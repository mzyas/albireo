import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { builtinTools, ProviderRegistry, ScriptedProvider, Session } from "@albireo/core";
import { SessionStore } from "@albireo/store";
import {
  chooseSession,
  defaultSessionsDir,
  formatSessionList,
  formatTime,
  runSessionsCommand,
} from "../dist/sessions.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function sandbox() {
  const root = await mkdtemp(path.join(tmpdir(), "albireo-cli-sessions-"));
  const cwd = path.join(root, "work");
  await mkdir(cwd);
  return { root, cwd, done: () => rm(root, { recursive: true, force: true }) };
}

async function saveSession(store, cwd, question, answer = "ok") {
  const provider = new ScriptedProvider([{ text: answer }]);
  const session = new Session({
    providers: new ProviderRegistry().register("scripted", () => provider),
    provider: "scripted",
    tools: builtinTools,
    cwd,
  });
  const rec = store.record(session, { cwd });
  await session.send(question);
  await rec.flush();
  rec.stop();
  await new Promise((r) => setTimeout(r, 5));
  return rec.id;
}

function fakeIO() {
  const io = { out: "", err: "", stdout: (t) => (io.out += t), stderr: (t) => (io.err += t) };
  return io;
}

// ---- chooseSession ---------------------------------------------------------------------------

test("chooseSession picks nothing, the latest of the workspace, or an explicit id", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(path.join(s.root, "sessions"));
    const other = path.join(s.root, "other");
    await mkdir(other);

    assert.deepEqual(await chooseSession(store, { continueLast: false, cwd: s.cwd }), {});
    assert.match((await chooseSession(store, { continueLast: true, cwd: s.cwd })).note, /no earlier session/);

    const first = await saveSession(store, s.cwd, "first");
    const second = await saveSession(store, s.cwd, "second");
    const elsewhere = await saveSession(store, other, "elsewhere");

    const latest = await chooseSession(store, { continueLast: true, cwd: s.cwd });
    assert.equal(latest.loaded.meta.id, second);
    assert.equal(latest.loaded.messages.length, 2);
    assert.equal((await chooseSession(store, { continueLast: true, cwd: other })).loaded.meta.id, elsewhere);
    assert.equal((await chooseSession(store, { continueLast: false, id: first, cwd: s.cwd })).loaded.meta.id, first);
    // An explicit id wins over --continue, and a bad one is an error rather than a silent new session.
    await assert.rejects(chooseSession(store, { continueLast: false, id: "nope", cwd: s.cwd }), { code: "not_found" });
    await assert.rejects(chooseSession(store, { continueLast: false, id: "../x", cwd: s.cwd }), { code: "invalid_id" });
  } finally {
    await s.done();
  }
});

// ---- albireo sessions ------------------------------------------------------------------------

test("sessions lists this workspace, or all of them, and deletes by id", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(path.join(s.root, "sessions"));
    const other = path.join(s.root, "other");
    await mkdir(other);

    let io = fakeIO();
    assert.equal(await runSessionsCommand([], io, store, s.cwd), 0);
    assert.match(io.out, /No saved sessions for .*work\. Use --all/);

    const a = await saveSession(store, s.cwd, "fix the parser");
    const b = await saveSession(store, other, "x".repeat(100));

    io = fakeIO();
    assert.equal(await runSessionsCommand(["list"], io, store, s.cwd), 0);
    const [header, ...rows] = io.out.trimEnd().split("\n");
    assert.match(header, /^ID\s+UPDATED\s+MSGS\s+TITLE$/);
    assert.equal(rows.length, 1);
    assert.match(rows[0], new RegExp(`^${a}  \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\s+2  fix the parser$`));

    io = fakeIO();
    assert.equal(await runSessionsCommand(["--all"], io, store, s.cwd), 0);
    assert.match(io.out, /WORKSPACE/);
    assert.ok(io.out.includes(a) && io.out.includes(b));
    assert.ok(io.out.split("\n").every((l) => l.length < 260));
    assert.ok(io.out.includes(`${"x".repeat(59)}…`), "long titles are cut");

    io = fakeIO();
    assert.equal(await runSessionsCommand(["--cwd", other], io, store, s.cwd), 0);
    assert.ok(io.out.includes(b) && !io.out.includes(a));

    io = fakeIO();
    assert.equal(await runSessionsCommand(["delete", a], io, store, s.cwd), 0);
    assert.match(io.out, new RegExp(`Deleted session ${a}`));
    assert.deepEqual(
      (await store.list()).map((m) => m.id),
      [b],
    );
  } finally {
    await s.done();
  }
});

test("sessions reports usage mistakes and store errors without leaking paths", async () => {
  const s = await sandbox();
  try {
    const store = new SessionStore(path.join(s.root, "sessions"));
    const run = async (argv) => {
      const io = fakeIO();
      return { code: await runSessionsCommand(argv, io, store, s.cwd), io };
    };
    assert.equal((await run(["frobnicate"])).code, 2);
    assert.equal((await run(["delete"])).code, 2);
    assert.equal((await run(["delete", "a", "b"])).code, 2);
    assert.equal((await run(["list", "extra"])).code, 2);
    assert.equal((await run(["--bogus"])).code, 2);

    const missing = await run(["delete", "nothing-here"]);
    assert.equal(missing.code, 1);
    assert.match(missing.io.err, /No session with that id/);
    const invalid = await run(["delete", "../etc"]);
    assert.equal(invalid.code, 1);
    assert.match(invalid.io.err, /Invalid session id/);

    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.io.out, /albireo sessions/);
  } finally {
    await s.done();
  }
});

test("formatTime is local time to the minute, and a list with no title says so", () => {
  assert.match(formatTime(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const out = formatSessionList(
    [{ id: "abc", createdAt: 1, updatedAt: 1, cwd: "/w", title: "", provider: "p", model: "m", messageCount: 3 }],
    false,
  );
  assert.match(out, /\(untitled\)/);
});

// ---- the real command line, against a local OpenAI-compatible server -------------------------

/** Answers every chat completion with the next reply, streamed, and keeps the requests it saw. */
function mockOpenAI(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const chunk = (choices, extra = {}) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "mock-1", choices, ...extra })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        chunk([
          {
            index: 0,
            delta: { role: "assistant", content: replies.shift() ?? "(out of replies)" },
            finish_reason: null,
          },
        ]),
      );
      res.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }]));
      res.write(chunk([], { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ requests, port: server.address().port, close: () => server.close() }),
    );
  });
}

/** Runs the real CLI with its config directory moved into `home`. */
function runCli(home, args) {
  const env = { ...process.env, APPDATA: home, XDG_CONFIG_HOME: home, HOME: home, USERPROFILE: home };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Where the CLI will keep its sessions when started with this `home`. */
function sessionsDirFor(home) {
  const keys = ["APPDATA", "XDG_CONFIG_HOME", "HOME", "USERPROFILE"];
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) process.env[k] = home;
  try {
    return defaultSessionsDir();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const userMessages = (request) => request.messages.filter((m) => m.role === "user").map((m) => m.content);

/** A config directory for the CLI under `s.root`, with a provider that talks to the mock server. */
async function configure(s, mock) {
  const home = path.join(s.root, "home");
  const sessionsDir = sessionsDirFor(home);
  const configDir = path.dirname(sessionsDir);
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "providers.json"),
    JSON.stringify({
      providers: {
        mock: {
          name: "Mock",
          api: "openai-completions",
          baseURL: `http://127.0.0.1:${mock.port}/v1`,
          defaultModel: "mock-1",
          auth: "none",
        },
      },
    }),
  );
  return { home, sessionsDir, configDir };
}

test("the command line saves a conversation and continues it later", { timeout: 120_000 }, async () => {
  const s = await sandbox();
  const mock = await mockOpenAI(["answer one", "answer two", "answer three", "answer four"]);
  try {
    const { home, sessionsDir, configDir } = await configure(s, mock);
    const base = ["--no-panel", "-p", "mock", "--cwd", s.cwd];

    // 1. A new conversation is saved.
    const one = await runCli(home, [...base, "--prompt", "first question"]);
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /answer one/);
    const files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    const id = files[0].replace(".jsonl", "");

    const listed = await runCli(home, ["sessions", "--cwd", s.cwd]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(listed.stdout.includes(id) && listed.stdout.includes("first question"));

    // 2. --continue carries it on: the model sees the earlier turn, and the same file grows.
    const two = await runCli(home, [...base, "--continue", "--prompt", "second question"]);
    assert.equal(two.code, 0, two.stderr);
    assert.match(two.stdout, /answer two/);
    assert.deepEqual(userMessages(mock.requests.at(-1)), ["first question", "second question"]);
    assert.deepEqual(
      mock.requests
        .at(-1)
        .messages.filter((m) => m.role === "assistant")
        .map((m) => m.content),
      ["answer one"],
    );
    assert.equal((await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl")).length, 1);
    const store = new SessionStore(sessionsDir);
    assert.equal((await store.load(id)).messages.length, 4);

    // 3. --resume <id> --no-save continues without changing what is saved.
    const three = await runCli(home, [...base, "--resume", id, "--no-save", "--prompt", "third question"]);
    assert.equal(three.code, 0, three.stderr);
    assert.deepEqual(userMessages(mock.requests.at(-1)), ["first question", "second question", "third question"]);
    assert.equal((await store.load(id)).messages.length, 4);

    // 4. A conversation that is not saved leaves nothing behind.
    const four = await runCli(home, [...base, "--no-save", "--prompt", "off the record"]);
    assert.equal(four.code, 0, four.stderr);
    assert.equal((await store.list()).length, 1);

    // 5. --continue where nothing was saved starts fresh and says so.
    const elsewhere = path.join(s.root, "elsewhere");
    await mkdir(elsewhere);
    const fresh = await runCli(home, [
      "--no-panel",
      "-p",
      "mock",
      "--cwd",
      elsewhere,
      "--continue",
      "--prompt",
      "brand new",
    ]);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.match(fresh.stderr, /no earlier session in this directory/);
    assert.deepEqual(userMessages(mock.requests.at(-1)), ["brand new"]);
    assert.equal((await store.list()).length, 2);

    // 6. Mistakes are reported, not guessed at.
    const bad = await runCli(home, [...base, "--resume", "../../etc/passwd", "--prompt", "x"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Invalid session id/);
    const missing = await runCli(home, [...base, "--resume", "nothing-here", "--prompt", "x"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /No session with that id/);
    const both = await runCli(home, [...base, "--continue", "--resume", id, "--prompt", "x"]);
    assert.equal(both.code, 2);

    // 7. Deleting through the command line.
    const del = await runCli(home, ["sessions", "delete", id]);
    assert.equal(del.code, 0, del.stderr);
    assert.deepEqual(
      (await store.list()).map((m) => m.title),
      ["brand new"],
    );
    assert.equal(
      JSON.parse(await readFile(path.join(configDir, "providers.json"), "utf8")).providers.mock.auth,
      "none",
    );
  } finally {
    mock.close();
    await s.done();
  }
});

test("a panel that connects to a continued session is shown the earlier conversation", {
  timeout: 120_000,
}, async () => {
  const s = await sandbox();
  const mock = await mockOpenAI(["the earlier answer"]);
  try {
    const { home } = await configure(s, mock);
    const base = ["--no-panel", "-p", "mock", "--cwd", s.cwd];
    const first = await runCli(home, [...base, "--prompt", "the earlier question"]);
    assert.equal(first.code, 0, first.stderr);

    // Serve mode: no --prompt. Read the panel URL it prints, then the first thing the panel would get.
    const env = { ...process.env, APPDATA: home, XDG_CONFIG_HOME: home, HOME: home, USERPROFILE: home };
    const child = spawn(process.execPath, [CLI, "-p", "mock", "--cwd", s.cwd, "--continue"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      let out = "";
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no panel URL; got: ${out}`)), 30_000);
        child.stdout.on("data", (c) => {
          out += c;
          const m = out.match(/GUI panel: (\S+)/);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.once("exit", () => reject(new Error(`exited early; got: ${out}`)));
      });
      assert.match(out, /Session: \S+ \(continued, 2 messages so far\)/);

      const events = new URL("/events", url);
      events.searchParams.set("token", new URL(url).searchParams.get("token"));
      const ctl = new AbortController();
      const res = await fetch(events, { signal: ctl.signal });
      const reader = res.body.getReader();
      let buffer = "";
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        assert.ok(!done, "the stream ended before the snapshot");
        buffer += Buffer.from(value).toString("utf8");
      }
      ctl.abort();
      const snapshot = JSON.parse(buffer.split("\n\n")[0].replace(/^data: /, ""));
      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshot.status, "idle");
      assert.equal(snapshot.provider, "mock");
      assert.deepEqual(
        snapshot.log.map((e) => [e.type, e.text]),
        [
          ["user", "the earlier question"],
          ["assistant_end", "the earlier answer"],
        ],
      );

      // The panel can also see this session in the list and start another one beside it.
      const headers = { "x-albireo-token": new URL(url).searchParams.get("token") };
      const listed = await (await fetch(new URL("/sessions", url), { headers })).json();
      assert.equal(listed.canCreate, true);
      assert.deepEqual(
        listed.sessions.map((x) => [x.live, x.title, x.cwd]),
        [[true, "the earlier question", s.cwd]],
      );
      assert.equal(listed.primary, listed.sessions[0].id);

      const made = await fetch(new URL("/sessions", url), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ cwd: s.cwd }),
      });
      assert.equal(made.status, 200);
      const after = await (await fetch(new URL("/sessions", url), { headers })).json();
      assert.equal(after.sessions.length, 2);
      assert.equal(after.primary, listed.primary, "the continued session is still the default");
    } finally {
      child.kill();
    }
  } finally {
    mock.close();
    await s.done();
  }
});
