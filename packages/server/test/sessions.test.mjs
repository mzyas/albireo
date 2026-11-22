import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, ProviderRegistry, ScriptedProvider, Session } from "@albireo/core";
import { SessionStore } from "@albireo/store";
import { defaultSessionsDir, ManagerError, resumeChoice, SessionManager, startPanelServer } from "../dist/index.js";

// ---- a provider the tests can steer through the user's message ------------------------------------

const textOf = (message) => message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

/**
 * `hold …` keeps the turn running until `release()` or an abort; `write …` asks to write a file (which
 * needs approval) and then says it did; anything else is echoed back.
 */
class TestProvider {
  defaultModel = "m1";
  holds = [];
  constructor(id = "test") {
    this.id = id;
  }
  release() {
    for (const resolve of this.holds.splice(0)) resolve();
  }
  async runTurn(req, onEvent) {
    const last = req.messages[req.messages.length - 1];
    const text = textOf(last);
    const usage = { inputTokens: 1, outputTokens: 1 };
    if (text.startsWith("hold")) {
      await new Promise((resolve, reject) => {
        this.holds.push(resolve);
        req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (text.startsWith("write")) {
      const call = {
        type: "tool_call",
        id: `call_${Math.random().toString(36).slice(2, 8)}`,
        name: "write_file",
        input: { path: "out.txt", contents: "x" },
      };
      return { message: { role: "assistant", content: [call] }, stopReason: "tool_use", usage };
    }
    const reply = last.content.some((p) => p.type === "tool_result") ? "wrote it" : `echo: ${text}`;
    onEvent({ type: "text_delta", text: reply });
    return { message: { role: "assistant", content: [{ type: "text", text: reply }] }, stopReason: "end_turn", usage };
  }
}

async function setup({ store = true, save = true, canCreate = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "albireo-mgr-"));
  const folders = {};
  for (const name of ["one", "two", "three"]) {
    folders[name] = path.join(root, name);
    await mkdir(folders[name]);
  }
  const provider = new TestProvider("test");
  const other = new TestProvider("other");
  const registry = new ProviderRegistry().register("test", () => provider).register("other", () => other);
  const sessionsDir = path.join(root, "sessions");
  const saveErrors = [];
  const manager = new SessionManager(
    {
      registry,
      tools: builtinTools,
      store: store ? new SessionStore(sessionsDir) : undefined,
      save,
      provider: "test",
      cwd: folders.one,
      onSaveError: (err) => saveErrors.push(err),
    },
    canCreate,
  );
  return {
    root,
    folders,
    provider,
    other,
    registry,
    manager,
    sessionsDir,
    saveErrors,
    async cleanup() {
      await manager.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const waitFor = async (check, what = "condition") => {
  for (let i = 0; i < 400; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const isInvalid = (message) => (err) =>
  err instanceof ManagerError && err.code === "invalid" && (!message || message.test(err.message));

// ---- manager --------------------------------------------------------------------------------------

test("create starts a session in the workspace asked for, and the first one is the primary", async () => {
  const s = await setup();
  try {
    const first = await s.manager.create();
    assert.equal(first.session.cwd, s.folders.one, "the manager's workspace by default");
    assert.equal(s.manager.primary, first);

    const second = await s.manager.create({ cwd: s.folders.two });
    assert.equal(second.session.cwd, s.folders.two);
    assert.equal(s.manager.primary, first, "a later session does not take over");
    assert.notEqual(first.id, second.id);
    assert.deepEqual(
      s.manager.sessions().map((m) => m.id),
      [first.id, second.id],
    );
    assert.equal(s.manager.get(second.id), second);

    const other = await s.manager.create({ provider: "other", model: "custom-model" });
    assert.equal(other.session.providerId, "other");
    assert.equal(other.session.model, "custom-model");
  } finally {
    await s.cleanup();
  }
});

test("create refuses a workspace that is not an existing folder and says why without quoting the path", async () => {
  const s = await setup();
  try {
    await assert.rejects(s.manager.create({ cwd: "relative/dir" }), isInvalid(/absolute/));
    await assert.rejects(s.manager.create({ cwd: path.join(s.root, "nope-secret-name") }), (err) => {
      assert.ok(isInvalid(/does not exist/)(err));
      assert.ok(!err.message.includes("nope-secret-name"));
      return true;
    });
    await assert.rejects(s.manager.create({ cwd: path.parse(s.root).root }), isInvalid(/root/));
    await assert.rejects(s.manager.create({ cwd: "   " }), isInvalid());
    await assert.rejects(s.manager.create({ cwd: 42 }), isInvalid());
    await assert.rejects(s.manager.create({ cwd: path.join(s.folders.one, "..", "..", "\0") }), isInvalid());
    await assert.rejects(s.manager.create({ provider: "missing" }), isInvalid(/Unknown provider/));
    assert.deepEqual(s.manager.sessions(), [], "nothing was started");
  } finally {
    await s.cleanup();
  }
});

test("nothing is written until a session has a message, then it is saved and listed", async () => {
  const s = await setup();
  try {
    const a = await s.manager.create({ cwd: s.folders.two });
    assert.equal(existsSync(s.sessionsDir), false, "an empty session leaves nothing behind");
    let listed = await s.manager.list();
    assert.deepEqual(
      listed.sessions.map((x) => [x.id, x.live, x.messageCount, x.title]),
      [[a.id, true, 0, ""]],
    );

    await a.session.send("first words");
    await s.manager.flush();
    assert.ok((await readdir(s.sessionsDir)).includes(`${a.id}.jsonl`));
    listed = await s.manager.list();
    assert.equal(listed.sessions[0].title, "first words");
    assert.equal(listed.sessions[0].messageCount, 2);
    assert.equal(listed.sessions[0].cwd, s.folders.two);
    assert.equal(listed.primary, a.id);
    assert.equal(listed.canCreate, true);
    assert.equal(listed.cwd, s.folders.one);
    assert.deepEqual(listed.workspaces, [s.folders.two, s.folders.one], "recent workspaces first, then the manager's");
  } finally {
    await s.cleanup();
  }
});

test("a saved session comes back with its history, workspace and provider, once however often it is asked for", async () => {
  const t = await setup();
  try {
    const first = await t.manager.create({ cwd: t.folders.two, provider: "other" });
    await first.session.send("remember me");
    await t.manager.flush();
    await t.manager.dispose();

    const restarted = new SessionManager({
      registry: t.registry,
      tools: builtinTools,
      store: new SessionStore(t.sessionsDir),
      provider: "test",
      cwd: t.folders.one,
    });
    const before = await restarted.list();
    assert.deepEqual(
      before.sessions.map((x) => [x.id, x.live]),
      [[first.id, false]],
    );

    const [a, b] = await Promise.all([restarted.open(first.id), restarted.open(first.id)]);
    assert.equal(a, b, "two requests make one session, not two writers of one file");
    assert.equal(a.session.cwd, t.folders.two);
    assert.equal(a.session.providerId, "other");
    assert.equal(a.session.history.length, 2);
    assert.equal(restarted.primary, a);
    assert.equal(await restarted.open(first.id), a, "already open");

    await a.session.send("and again");
    await restarted.flush();
    const after = await restarted.list();
    assert.equal(after.sessions[0].messageCount, 4, "new messages continue the same file");
    assert.equal(after.sessions[0].live, true);
    assert.equal((await readdir(t.sessionsDir)).filter((f) => f.endsWith(".jsonl")).length, 1);
    await restarted.dispose();
  } finally {
    await rm(t.root, { recursive: true, force: true });
  }
});

test("open reports a missing session, a bad id, a workspace that is gone and a server that saves nothing", async () => {
  const s = await setup();
  try {
    await assert.rejects(
      s.manager.open("20200101-000000-abcdef"),
      (err) => err instanceof ManagerError && err.code === "not_found",
    );
    await assert.rejects(s.manager.open("../escape"), isInvalid());

    const doomed = path.join(s.root, "doomed");
    await mkdir(doomed);
    const a = await s.manager.create({ cwd: doomed });
    await a.session.send("hi");
    await s.manager.flush();
    await s.manager.dispose();
    await rm(doomed, { recursive: true, force: true });
    const again = new SessionManager({
      registry: s.registry,
      tools: builtinTools,
      store: new SessionStore(s.sessionsDir),
      provider: "test",
      cwd: s.folders.one,
    });
    await assert.rejects(again.open(a.id), isInvalid(/no longer exists/));
    await again.dispose();

    const none = await setup({ store: false });
    await assert.rejects(none.manager.open("20200101-000000-abcdef"), (err) => err.code === "not_found");
    await none.cleanup();
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("resumeChoice goes back to the saved provider and keeps a model only when it was chosen", () => {
  const registry = new ProviderRegistry()
    .register("a", () => new TestProvider("a"))
    .register("b", () => new TestProvider("b"));
  assert.deepEqual(resumeChoice({ provider: "b", model: "m1" }, registry, "a"), {
    provider: "b",
    model: undefined,
    note: undefined,
  });
  assert.deepEqual(resumeChoice({ provider: "b", model: "special" }, registry, "a"), {
    provider: "b",
    model: "special",
    note: undefined,
  });
  const gone = resumeChoice({ provider: "gone", model: "x" }, registry, "a");
  assert.equal(gone.provider, "a");
  assert.equal(gone.model, undefined, "a model of another provider is not carried over");
  assert.match(gone.note ?? "", /"gone".*not available/);
  assert.deepEqual(resumeChoice({ provider: "b", model: "special" }, registry, "a", { provider: "a", model: "mine" }), {
    provider: "a",
    model: "mine",
    note: undefined,
  });
  assert.equal(
    resumeChoice({ provider: "", model: "" }, registry, "a").note,
    undefined,
    "an unknown provider is only news when it was named",
  );
});

test("sessions run side by side without mixing their conversations", async () => {
  const s = await setup();
  try {
    const a = await s.manager.create({ cwd: s.folders.one });
    const b = await s.manager.create({ cwd: s.folders.two });
    const heard = { a: [], b: [] };
    a.session.on((e) => heard.a.push(e.type === "user" ? e.text : e.type));
    b.session.on((e) => heard.b.push(e.type === "user" ? e.text : e.type));

    const slow = a.session.send("hold on");
    await waitFor(() => a.session.status === "running", "the first session to start");
    await b.session.send("quick");
    assert.equal(a.session.status, "running", "the other session finishing does not end this one");
    assert.equal(b.session.status, "idle");
    s.provider.release();
    await slow;

    assert.deepEqual(
      a.session.history.map((m) => textOf(m)),
      ["hold on", "echo: hold on"],
    );
    assert.deepEqual(
      b.session.history.map((m) => textOf(m)),
      ["quick", "echo: quick"],
    );
    assert.ok(heard.a.includes("hold on") && !heard.a.includes("quick"));
    assert.ok(heard.b.includes("quick") && !heard.b.includes("hold on"));
  } finally {
    await s.cleanup();
  }
});

test("summaries show who is running and who is waiting for an answer", async () => {
  const s = await setup();
  try {
    const a = await s.manager.create();
    const b = await s.manager.create({ cwd: s.folders.two });
    const running = a.session.send("hold");
    const waiting = b.session.send("write the file");
    await waitFor(() => b.session.pendingApprovals === 1, "an approval request");

    const rows = Object.fromEntries((await s.manager.list()).sessions.map((x) => [x.id, x]));
    assert.equal(rows[a.id].status, "running");
    assert.equal(rows[a.id].pending, 0);
    assert.equal(rows[b.id].status, "running");
    assert.equal(rows[b.id].pending, 1);

    b.session.approve([...b.session.snapshot().pending][0].id, true);
    s.provider.release();
    await Promise.all([running, waiting]);
    const done = Object.fromEntries((await s.manager.list()).sessions.map((x) => [x.id, x]));
    assert.deepEqual(
      [done[a.id].status, done[a.id].pending, done[b.id].status, done[b.id].pending],
      ["idle", 0, "idle", 0],
    );
  } finally {
    await s.cleanup();
  }
});

test("delete aborts a running session and removes what was saved; deleting what is not there is an error", async () => {
  const s = await setup();
  try {
    const a = await s.manager.create();
    await a.session.send("keep nothing");
    await s.manager.flush();
    const b = await s.manager.create({ cwd: s.folders.two });
    const running = b.session.send("hold forever");
    await waitFor(() => b.session.status === "running");

    await s.manager.delete(b.id);
    await running; // the abort ended the turn
    assert.equal(s.manager.get(b.id), undefined);
    assert.equal(s.manager.primary, a, "the primary stays while it exists");

    await s.manager.delete(a.id);
    assert.equal(s.manager.primary, undefined);
    assert.deepEqual(await readdir(s.sessionsDir), [], "the files of a deleted session are gone");
    assert.deepEqual((await s.manager.list()).sessions, []);

    await assert.rejects(s.manager.delete(a.id), (err) => err.code === "not_found");
    await assert.rejects(s.manager.delete("../x"), (err) => err instanceof ManagerError);
  } finally {
    await s.cleanup();
  }
});

test("deleting a saved session that is not open removes it", async () => {
  const s = await setup();
  try {
    const a = await s.manager.create();
    await a.session.send("hello");
    await s.manager.flush();
    await s.manager.dispose();
    const fresh = new SessionManager({
      registry: s.registry,
      tools: builtinTools,
      store: new SessionStore(s.sessionsDir),
      provider: "test",
      cwd: s.folders.one,
    });
    await fresh.delete(a.id);
    assert.deepEqual((await fresh.list()).sessions, []);
    await fresh.dispose();
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("without saving, conversations stay in memory and a saved session is opened but not changed", async () => {
  const s = await setup({ save: false });
  try {
    const a = await s.manager.create();
    await a.session.send("not kept");
    await s.manager.flush();
    assert.equal(existsSync(s.sessionsDir), false);
    assert.equal((await s.manager.list()).sessions[0].title, "not kept", "still listed from memory");
    assert.equal((await s.manager.list()).sessions[0].messageCount, 2);
  } finally {
    await s.cleanup();
  }
});

test("a failed write is reported and does not stop the conversation", async () => {
  const s = await setup();
  try {
    // A file where the sessions directory should be: every write fails.
    await rm(s.sessionsDir, { recursive: true, force: true });
    await (await import("node:fs/promises")).writeFile(s.sessionsDir, "in the way");
    const a = await s.manager.create();
    await a.session.send("hello");
    await s.manager.flush();
    assert.ok(s.saveErrors.length > 0);
    assert.equal(a.session.history.length, 2, "the conversation went on");
  } finally {
    await s.cleanup();
  }
});

test("onChange tells listeners once per burst, and each() follows sessions as they come and go", async () => {
  const s = await setup();
  try {
    let changes = 0;
    const off = s.manager.onChange(() => changes++);
    const visited = [];
    const cleaned = [];
    const stop = s.manager.each((_session, id) => {
      visited.push(id);
      return () => cleaned.push(id);
    });

    const a = await s.manager.create();
    const b = await s.manager.create({ cwd: s.folders.two });
    assert.deepEqual(visited, [a.id, b.id], "sessions that start later are visited too");
    await waitFor(() => changes >= 1, "a change notice");
    assert.ok(changes <= 2, "two quick creations are one or two notices, not a stream");

    const before = changes;
    await a.session.send("hello");
    await waitFor(() => changes > before, "a notice for a turn");

    await s.manager.delete(a.id);
    assert.deepEqual(cleaned, [a.id], "what each() returned runs when the session goes");
    stop();
    assert.deepEqual(cleaned, [a.id, b.id], "and for the rest when visiting stops");
    off();
    const frozen = changes;
    await s.manager.create();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(changes, frozen, "a removed listener hears nothing");
  } finally {
    await s.cleanup();
  }
});

test("single wraps one session: it is listed and usable, nothing else is allowed", async () => {
  const registry = new ProviderRegistry().register("scripted", () => new ScriptedProvider([{ text: "hi" }]));
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-single-"));
  try {
    const session = new Session({ providers: registry, provider: "scripted", tools: [], cwd });
    const manager = SessionManager.single(session);
    assert.equal(manager.canCreate, false);
    assert.equal(manager.primary?.session, session);
    const listed = await manager.list();
    assert.equal(listed.sessions.length, 1);
    assert.equal(listed.canCreate, false);
    assert.equal(listed.primary, manager.primary?.id);
    for (const act of [() => manager.create(), () => manager.open("x"), () => manager.delete(manager.primary.id)]) {
      await assert.rejects(act(), (err) => err instanceof ManagerError && err.code === "unsupported");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// ---- over HTTP ------------------------------------------------------------------------------------

function request(base, { method = "GET", pathname, token, body, raw }) {
  const url = new URL(pathname, base);
  const headers = { host: url.host };
  if (token !== undefined) headers["x-albireo-token"] = token;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }),
      );
    });
    req.on("error", reject);
    req.end(raw ?? (body === undefined ? undefined : JSON.stringify(body)));
  });
}

/** Opens `GET /events` and collects what arrives. */
function openStream(base, token, session) {
  const url = new URL("/events", base);
  url.searchParams.set("token", token);
  if (session) url.searchParams.set("session", session);
  const events = [];
  const stream = { events, status: 0, ended: false, close: () => {} };
  stream.opened = new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      stream.status = res.statusCode;
      res.setEncoding("utf8");
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk;
        for (let i = buffer.indexOf("\n\n"); i >= 0; i = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)));
        }
      });
      res.on("end", () => {
        stream.ended = true;
      });
      res.on("close", () => {
        stream.ended = true;
      });
      resolve(stream);
    });
    req.on("error", (err) => (err.code === "ECONNRESET" ? resolve(stream) : reject(err)));
    stream.close = () => req.destroy();
  });
  return stream;
}

async function serve(options) {
  const s = await setup(options);
  const panel = await startPanelServer(s.manager, { publicDir: new URL("file:///nonexistent/") });
  const url = new URL(panel.url);
  return {
    ...s,
    panel,
    base: url.origin,
    token: url.searchParams.get("token"),
    async cleanup() {
      await panel.close();
      await s.cleanup();
    },
  };
}

test("/sessions needs the token, lists, creates, opens and deletes", async () => {
  const s = await serve();
  try {
    assert.equal((await request(s.base, { pathname: "/sessions" })).status, 401);
    assert.equal((await request(s.base, { method: "POST", pathname: "/sessions", body: {} })).status, 401);

    const first = await request(s.base, { method: "POST", pathname: "/sessions", token: s.token });
    assert.equal(first.status, 200, "no body means the defaults");
    const created = first.json().session;
    assert.equal(created.cwd, s.folders.one);
    assert.equal(created.live, true);
    assert.equal(first.headers["cache-control"], "no-store");

    const second = await request(s.base, {
      method: "POST",
      pathname: "/sessions",
      token: s.token,
      body: { cwd: s.folders.two, provider: "other", model: "xl" },
    });
    assert.deepEqual(
      [second.json().session.cwd, second.json().session.provider, second.json().session.model],
      [s.folders.two, "other", "xl"],
    );

    const listed = (await request(s.base, { pathname: "/sessions", token: s.token })).json();
    assert.equal(listed.sessions.length, 2);
    assert.equal(listed.primary, created.id);
    assert.equal(listed.canCreate, true);

    const bad = await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, body: { cwd: "nope" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json().code, "invalid");
    assert.equal(
      (await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, raw: "{oops" })).status,
      400,
    );
    const notJson = await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, raw: "{oops" });
    assert.ok(!notJson.text.includes("oops"), "the parser's message, which quotes the body, is not repeated");
    assert.equal(
      (await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, body: { cwd: 5 } })).status,
      400,
    );

    const removed = await request(s.base, { method: "DELETE", pathname: `/sessions/${created.id}`, token: s.token });
    assert.equal(removed.status, 200);
    assert.equal(
      (await request(s.base, { method: "DELETE", pathname: `/sessions/${created.id}`, token: s.token })).status,
      404,
    );
    assert.equal(
      (await request(s.base, { method: "POST", pathname: "/sessions/nope/open", token: s.token })).status,
      404,
    );
    assert.equal(
      (await request(s.base, { method: "POST", pathname: "/sessions/%E0%A4%A/open", token: s.token })).status,
      400,
    );
    assert.equal((await request(s.base, { method: "PUT", pathname: "/sessions", token: s.token })).status, 404);
  } finally {
    await s.cleanup();
  }
});

test("a saved session is opened over HTTP and then served like any other", async () => {
  const s = await serve();
  try {
    const first = (await request(s.base, { method: "POST", pathname: "/sessions", token: s.token })).json().session;
    await request(s.base, {
      method: "POST",
      pathname: "/command",
      token: s.token,
      body: { type: "send", text: "hello", session: first.id },
    });
    await waitFor(() => s.manager.get(first.id)?.session.history.length === 2, "the reply");
    await s.manager.flush();
    await s.panel.close();
    await s.manager.dispose();

    // "Restart": a new manager and server over the same store.
    const manager = new SessionManager({
      registry: s.registry,
      tools: builtinTools,
      store: new SessionStore(s.sessionsDir),
      provider: "test",
      cwd: s.folders.one,
    });
    const panel = await startPanelServer(manager, { publicDir: new URL("file:///nonexistent/") });
    const url = new URL(panel.url);
    const base = url.origin;
    const token = url.searchParams.get("token");
    try {
      assert.equal(
        (await request(base, { pathname: `/events?session=${first.id}`, token })).status,
        404,
        "not open yet",
      );
      const listed = (await request(base, { pathname: "/sessions", token })).json();
      assert.deepEqual(
        listed.sessions.map((x) => [x.id, x.live, x.title]),
        [[first.id, false, "hello"]],
      );
      assert.equal(listed.primary, null);

      const opened = await request(base, { method: "POST", pathname: `/sessions/${first.id}/open`, token });
      assert.equal(opened.status, 200);
      assert.equal(opened.json().session.live, true);

      const stream = await openStream(base, token, first.id).opened;
      await waitFor(() => stream.events.some((e) => e.type === "snapshot"), "a snapshot");
      const snapshot = stream.events.find((e) => e.type === "snapshot");
      assert.deepEqual(
        snapshot.log.filter((e) => e.type === "user" || e.type === "assistant_end").map((e) => e.text),
        ["hello", "echo: hello"],
        "the conversation is back",
      );
      stream.close();
    } finally {
      await panel.close();
      await manager.dispose();
    }
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});

test("events and commands go to the session they name, and the first one is the default", async () => {
  const s = await serve();
  try {
    const a = (await request(s.base, { method: "POST", pathname: "/sessions", token: s.token })).json().session;
    const b = (
      await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, body: { cwd: s.folders.two } })
    ).json().session;

    const streamA = await openStream(s.base, s.token, a.id).opened;
    const streamB = await openStream(s.base, s.token, b.id).opened;
    const streamDefault = await openStream(s.base, s.token).opened;
    await waitFor(
      () => [streamA, streamB, streamDefault].every((x) => x.events.some((e) => e.type === "snapshot")),
      "snapshots",
    );
    assert.equal(streamA.events[0].cwd, s.folders.one);
    assert.equal(streamB.events[0].cwd, s.folders.two);
    assert.equal(streamDefault.events[0].cwd, s.folders.one, "no session named: the primary");

    const sent = await request(s.base, {
      method: "POST",
      pathname: "/command",
      token: s.token,
      body: { type: "send", text: "to b", session: b.id },
    });
    assert.equal(sent.status, 202);
    await waitFor(() => streamB.events.some((e) => e.type === "assistant_end"), "b's reply");
    assert.ok(!streamA.events.some((e) => e.type === "user"), "a heard nothing");
    assert.ok(!streamDefault.events.some((e) => e.type === "user"));
    assert.equal(s.manager.get(a.id).session.history.length, 0);

    await request(s.base, {
      method: "POST",
      pathname: "/command",
      token: s.token,
      body: { type: "send", text: "to the default" },
    });
    await waitFor(() => streamA.events.some((e) => e.type === "assistant_end"), "the default's reply");
    assert.ok(streamDefault.events.some((e) => e.type === "user" && e.text === "to the default"));
    assert.ok(!streamB.events.some((e) => e.type === "user" && e.text === "to the default"));

    assert.equal(
      (
        await request(s.base, {
          method: "POST",
          pathname: "/command",
          token: s.token,
          body: { type: "abort", session: "nope" },
        })
      ).status,
      404,
    );
    assert.equal((await request(s.base, { pathname: "/events?session=nope", token: s.token })).status, 404);
    for (const stream of [streamA, streamB, streamDefault]) stream.close();
  } finally {
    await s.cleanup();
  }
});

test("every open stream hears that the list changed, and a deleted session's stream ends", async () => {
  const s = await serve();
  try {
    const a = (await request(s.base, { method: "POST", pathname: "/sessions", token: s.token })).json().session;
    const b = (
      await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, body: { cwd: s.folders.two } })
    ).json().session;
    const streamA = await openStream(s.base, s.token, a.id).opened;
    const streamB = await openStream(s.base, s.token, b.id).opened;
    await waitFor(() => streamA.events.length > 0 && streamB.events.length > 0, "snapshots");

    await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, body: { cwd: s.folders.three } });
    await waitFor(
      () => [streamA, streamB].every((x) => x.events.some((e) => e.type === "sessions_changed")),
      "the list change on both streams",
    );

    await request(s.base, { method: "DELETE", pathname: `/sessions/${b.id}`, token: s.token });
    await waitFor(() => streamB.ended, "the deleted session's stream to end");
    assert.equal(streamA.ended, false, "the other stream stays open");
    streamA.close();
  } finally {
    await s.cleanup();
  }
});

test("workspace routes answer for the session they name", async () => {
  const s = await serve();
  try {
    await (await import("node:fs/promises")).writeFile(path.join(s.folders.one, "in-one.txt"), "1");
    await (await import("node:fs/promises")).writeFile(path.join(s.folders.two, "in-two.txt"), "2");
    const a = (await request(s.base, { method: "POST", pathname: "/sessions", token: s.token })).json().session;
    const b = (
      await request(s.base, { method: "POST", pathname: "/sessions", token: s.token, body: { cwd: s.folders.two } })
    ).json().session;
    const files = async (session) =>
      (await request(s.base, { pathname: `/workspace/files?session=${session}`, token: s.token })).json().files;
    assert.deepEqual(await files(a.id), ["in-one.txt"]);
    assert.deepEqual(await files(b.id), ["in-two.txt"]);
    const preview = await request(s.base, {
      pathname: `/workspace/file?path=in-two.txt&session=${b.id}`,
      token: s.token,
    });
    assert.equal(preview.json().content, "2");
    assert.equal(
      (await request(s.base, { pathname: `/workspace/file?path=in-two.txt&session=${a.id}`, token: s.token })).status,
      404,
    );
    assert.equal((await request(s.base, { pathname: "/workspace/files?session=nope", token: s.token })).status, 404);
  } finally {
    await s.cleanup();
  }
});

test("a server handed one session still works as before and refuses the session routes that need a manager", async () => {
  const registry = new ProviderRegistry().register("scripted", () => new ScriptedProvider([{ text: "hello there" }]));
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-one-"));
  const session = new Session({ providers: registry, provider: "scripted", tools: [], cwd });
  const panel = await startPanelServer(session, { publicDir: new URL("file:///nonexistent/") });
  const url = new URL(panel.url);
  try {
    const token = url.searchParams.get("token");
    const listed = (await request(url.origin, { pathname: "/sessions", token })).json();
    assert.equal(listed.canCreate, false);
    assert.equal(listed.sessions.length, 1);
    assert.equal((await request(url.origin, { method: "POST", pathname: "/sessions", token, body: {} })).status, 409);
    await request(url.origin, { method: "POST", pathname: "/command", token, body: { type: "send", text: "hi" } });
    await waitFor(() => session.history.length === 2, "the reply");
  } finally {
    await panel.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saved sessions live in a folder beside the vault", () => {
  assert.equal(defaultSessionsDir(path.join("config", "albireo")), path.join("config", "albireo", "sessions"));
  assert.ok(path.isAbsolute(defaultSessionsDir()), "the default is the per-user config dir");
});

test("a server that cannot take its port leaves no listeners on the manager", async () => {
  const t = await setup();
  const blocker = net.createServer();
  try {
    await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    let added = 0;
    let removed = 0;
    for (const name of ["onChange", "onRemoved"]) {
      const original = t.manager[name].bind(t.manager);
      t.manager[name] = (listener) => {
        added++;
        const off = original(listener);
        return () => {
          removed++;
          off();
        };
      };
    }
    await assert.rejects(startPanelServer(t.manager, { port: blocker.address().port }), { code: "EADDRINUSE" });
    assert.ok(added >= 2, "the server did subscribe before it tried to listen");
    assert.equal(removed, added, "every subscription was undone");
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await t.cleanup();
  }
});
