import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, ProviderRegistry, ScriptedProvider, Session } from "@albireo/core";
import {
  isMessage,
  isValidId,
  newSessionId,
  SessionStore,
  StoreError,
  sameDir,
  titleFromMessage,
} from "../dist/index.js";

async function sandbox() {
  const root = await mkdtemp(path.join(tmpdir(), "albireo-store-"));
  const cwd = path.join(root, "work");
  await mkdir(cwd);
  const dir = path.join(root, "sessions");
  return { root, cwd, dir, store: new SessionStore(dir), done: () => rm(root, { recursive: true, force: true }) };
}

function makeSession(steps, opts = {}) {
  const provider = new ScriptedProvider(steps);
  const registry = new ProviderRegistry()
    .register("scripted", () => provider)
    .register("other", () => new ScriptedProvider([], "other"));
  return new Session({ providers: registry, provider: "scripted", tools: builtinTools, cwd: tmpdir(), ...opts });
}

const text = (t) => ({ type: "text", text: t });
const lines = async (file) => (await readFile(file, "utf8")).split("\n").filter(Boolean);

test("nothing is written until the first message exists", async () => {
  const s = await sandbox();
  try {
    const rec = s.store.record(makeSession([]), { cwd: s.cwd });
    await rec.flush();
    await assert.rejects(readdir(s.dir), { code: "ENOENT" });
    assert.deepEqual(await s.store.list(), []);
    rec.stop();
  } finally {
    await s.done();
  }
});

test("a conversation is saved as it happens and loads back identical", async () => {
  const s = await sandbox();
  try {
    const session = makeSession([
      { text: "Looking.", toolCalls: [{ name: "list_dir", input: { path: "." } }] },
      { text: "All done." },
    ]);
    const rec = s.store.record(session, { cwd: s.cwd });
    await session.send("  look around\nand report back  ");
    await rec.flush();

    const loaded = await s.store.load(rec.id);
    assert.deepEqual(loaded.messages, JSON.parse(JSON.stringify(session.history)));
    assert.equal(loaded.skipped, 0);
    assert.equal(loaded.meta.id, rec.id);
    assert.equal(loaded.meta.cwd, s.cwd);
    assert.equal(loaded.meta.title, "look around");
    assert.equal(loaded.meta.provider, "scripted");
    assert.equal(loaded.meta.model, "scripted-1");
    assert.equal(loaded.meta.messageCount, 4);
    assert.ok(loaded.meta.updatedAt >= loaded.meta.createdAt);

    const file = await lines(path.join(s.dir, `${rec.id}.jsonl`));
    assert.equal(file.length, 1 + 4);
    assert.equal(JSON.parse(file[0]).type, "session");
    assert.deepEqual(rec.info, loaded.meta);

    if (process.platform !== "win32") {
      assert.equal((await stat(s.dir)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(s.dir, `${rec.id}.jsonl`))).mode & 0o777, 0o600);
    }
  } finally {
    await s.done();
  }
});

test("provider-native payloads survive the round trip", async () => {
  const s = await sandbox();
  try {
    const native = {
      provider: "scripted",
      model: "m",
      api: "anthropic-messages",
      payload: { blocks: [{ type: "thinking", signature: "sig==" }] },
    };
    const provider = {
      id: "scripted",
      defaultModel: "m",
      runTurn: async () => ({
        message: { role: "assistant", content: [text("hi")], native },
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
    const session = new Session({
      providers: new ProviderRegistry().register("scripted", () => provider),
      provider: "scripted",
      tools: [],
      cwd: s.cwd,
    });
    const rec = s.store.record(session, { cwd: s.cwd });
    await session.send("hello");
    await rec.flush();
    const loaded = await s.store.load(rec.id);
    assert.deepEqual(loaded.messages[1].native, native);
  } finally {
    await s.done();
  }
});

test("a resumed session continues the same file", async () => {
  const s = await sandbox();
  try {
    const first = makeSession([{ text: "first answer" }]);
    const rec1 = s.store.record(first, { cwd: s.cwd });
    await first.send("first question");
    await rec1.flush();
    rec1.stop();

    const { meta, messages } = await s.store.load(rec1.id);
    const second = makeSession([{ text: "second answer" }], { history: messages });
    const rec2 = s.store.resume(second, meta);
    assert.equal(rec2.id, rec1.id);
    await second.send("second question");
    await rec2.flush();

    const all = await s.store.load(rec1.id);
    assert.deepEqual(all.messages, JSON.parse(JSON.stringify(second.history)));
    assert.equal(all.meta.messageCount, 4);
    assert.equal(all.meta.title, "first question", "the title stays what it was");
    const records = await lines(path.join(s.dir, `${rec1.id}.jsonl`));
    assert.equal(records.filter((l) => JSON.parse(l).type === "session").length, 1, "one header only");
    assert.equal((await s.store.list()).length, 1);
  } finally {
    await s.done();
  }
});

test("restored messages are not written again, and a stopped recording stops", async () => {
  const s = await sandbox();
  try {
    const session = makeSession([{ text: "a" }, { text: "b" }], {
      history: [{ role: "user", content: [text("old")] }],
    });
    const rec = s.store.record(session, { cwd: s.cwd });
    await session.send("one");
    rec.stop();
    await session.send("two");
    await rec.flush();
    const loaded = await s.store.load(rec.id);
    assert.deepEqual(
      loaded.messages.map((m) => m.content[0].text),
      ["one", "a"],
    );
  } finally {
    await s.done();
  }
});

test("a provider switch after the first message is remembered", async () => {
  const s = await sandbox();
  try {
    const session = makeSession([{ text: "hi" }]);
    const rec = s.store.record(session, { cwd: s.cwd });
    session.switchProvider("other", "other-model"); // before any message: nothing is written
    await rec.flush();
    await assert.rejects(readdir(s.dir), { code: "ENOENT" });

    await session.send("hello");
    session.switchProvider("scripted", "scripted-1");
    session.switchProvider("other", "model-x");
    await rec.flush();
    const { meta } = await s.store.load(rec.id);
    assert.equal(meta.provider, "other");
    assert.equal(meta.model, "model-x");
  } finally {
    await s.done();
  }
});

test("a session cut off by a crash still loads; damaged lines are skipped and counted", async () => {
  const s = await sandbox();
  try {
    const session = makeSession([{ text: "answer" }]);
    const rec = s.store.record(session, { cwd: s.cwd });
    await session.send("question");
    await rec.flush();
    const file = path.join(s.dir, `${rec.id}.jsonl`);
    const good = await readFile(file, "utf8");

    const bad = [
      "not json at all",
      JSON.stringify({ type: "message", at: 1, message: { role: "system", content: [] } }),
      JSON.stringify({ type: "message", at: 1, message: { role: "user", content: [{ type: "image" }] } }),
      JSON.stringify({ type: "message", at: 1, message: { role: "user", content: "text" } }),
      JSON.stringify({ type: "message", at: 1, message: { role: "assistant", content: [], native: { provider: 1 } } }),
      JSON.stringify({ type: "whatever" }),
    ];
    // Damage in the middle, then a final line cut off halfway, as a crash would leave it.
    const cut = JSON.stringify({
      type: "message",
      at: 2,
      message: { role: "user", content: [text("never finished")] },
    }).slice(0, 40);
    await writeFile(file, `${good}${bad.join("\n")}\n${cut}`);

    const loaded = await s.store.load(rec.id);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.skipped, bad.length + 1);

    // Recording into it again still works: the next message starts on its own line.
    const resumed = makeSession([{ text: "later" }], { history: loaded.messages });
    const rec2 = s.store.resume(resumed, loaded.meta);
    await resumed.send("after the crash");
    await rec2.flush();
    const again = await s.store.load(rec.id);
    assert.deepEqual(
      again.messages.map((m) => m.content[0].text),
      ["question", "answer", "after the crash", "later"],
    );
  } finally {
    await s.done();
  }
});

test("a file that is not a session is refused with a clear error", async () => {
  const s = await sandbox();
  try {
    await mkdir(s.dir, { recursive: true });
    const header = (over) => JSON.stringify({ type: "session", v: 1, id: "a", createdAt: 1, cwd: "/w", ...over });
    const cases = {
      empty: ["", "corrupt"],
      "no-header": [
        `${JSON.stringify({ type: "message", at: 1, message: { role: "user", content: [text("x")] } })}\n`,
        "corrupt",
      ],
      garbage: ["{{{\n", "corrupt"],
      "other-id": [`${header({ id: "somebody-else" })}\n`, "corrupt"],
      "no-cwd": [`${header({ cwd: undefined })}\n`, "corrupt"],
      future: [`${header({ v: 99 })}\n`, "unsupported"],
    };
    for (const [name, [content, code]] of Object.entries(cases)) {
      const id = `case-${name}`;
      await writeFile(path.join(s.dir, `${id}.jsonl`), content.replace('"id":"a"', `"id":"${id}"`));
      await assert.rejects(
        s.store.load(id),
        (e) => e instanceof StoreError && e.code === (name === "other-id" ? "corrupt" : code),
        name,
      );
    }
    await assert.rejects(s.store.load("missing"), (e) => e instanceof StoreError && e.code === "not_found");
    // Whatever is wrong, the message must not quote the file.
    await writeFile(path.join(s.dir, "leaky.jsonl"), "sk-secret-in-the-first-line\n");
    await assert.rejects(s.store.load("leaky"), (e) => !String(e.message).includes("sk-secret"));
  } finally {
    await s.done();
  }
});

test("ids can't point outside the store", async () => {
  const s = await sandbox();
  try {
    for (const id of [
      "../x",
      "a/b",
      "a\\b",
      "..",
      ".",
      ".hidden",
      "trailing.",
      "CON",
      "nul.txt",
      "lpt1",
      "",
      "a b",
      "x".repeat(65),
      "é",
    ]) {
      assert.equal(isValidId(id), false, JSON.stringify(id));
      await assert.rejects(s.store.load(id), (e) => e instanceof StoreError && e.code === "invalid_id");
      await assert.rejects(s.store.delete(id), (e) => e instanceof StoreError && e.code === "invalid_id");
    }
    for (const id of ["a", "20261122-103045-a1b2c3", "my_session-1", "v1.2", newSessionId()])
      assert.equal(isValidId(id), true, id);
    assert.match(newSessionId(new Date(Date.UTC(2026, 10, 22, 10, 30, 45))), /^20261122-103045-[0-9a-f]{6}$/);
  } finally {
    await s.done();
  }
});

test("list shows newest first, can be limited to a workspace, and rebuilds a lost cache", async () => {
  const s = await sandbox();
  try {
    const other = path.join(s.root, "other");
    await mkdir(other);
    const make = async (cwd, question) => {
      const session = makeSession([{ text: "ok" }]);
      const rec = s.store.record(session, { cwd });
      await session.send(question);
      await rec.flush();
      rec.stop();
      await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
      return rec.id;
    };
    const a = await make(s.cwd, "first in work");
    const b = await make(other, "only in other");
    const c = await make(s.cwd, "second in work");

    assert.deepEqual(
      (await s.store.list()).map((m) => m.id),
      [c, b, a],
    );
    assert.deepEqual(
      (await s.store.list({ cwd: s.cwd })).map((m) => m.id),
      [c, a],
    );
    assert.equal((await s.store.latest(s.cwd))?.id, c);
    assert.equal(await s.store.latest(path.join(s.root, "nowhere")), undefined);

    // Lose or damage the cache of one session, and add things that are not sessions.
    await rm(path.join(s.dir, `${a}.json`));
    await writeFile(path.join(s.dir, `${b}.json`), "{ broken");
    await writeFile(path.join(s.dir, "notes.txt"), "hello");
    await writeFile(path.join(s.dir, "bad name.jsonl"), "x");
    await writeFile(path.join(s.dir, "damaged.jsonl"), "garbage");
    const listed = await s.store.list();
    assert.deepEqual(
      listed.map((m) => [m.id, m.title, m.messageCount]),
      [
        [c, "second in work", 2],
        [b, "only in other", 2],
        [a, "first in work", 2],
      ],
    );
    assert.equal((await new SessionStore(path.join(s.root, "empty")).list()).length, 0);
  } finally {
    await s.done();
  }
});

test("delete removes a session and says so when there is none", async () => {
  const s = await sandbox();
  try {
    const session = makeSession([{ text: "ok" }]);
    const rec = s.store.record(session, { cwd: s.cwd });
    await session.send("hi");
    await rec.flush();
    await s.store.delete(rec.id);
    assert.deepEqual(await readdir(s.dir), []);
    await assert.rejects(s.store.delete(rec.id), (e) => e instanceof StoreError && e.code === "not_found");
  } finally {
    await s.done();
  }
});

test("a store that can't write reports it and never interrupts the conversation", async () => {
  const s = await sandbox();
  try {
    // The store directory sits below a regular file, so it can never be created.
    const blocker = path.join(s.root, "blocker");
    await writeFile(blocker, "x");
    const errors = [];
    const session = makeSession([{ text: "still works" }]);
    const rec = new SessionStore(path.join(blocker, "sessions")).record(session, {
      cwd: s.cwd,
      onError: (e) => errors.push(e),
    });
    await session.send("hello");
    await rec.flush();
    assert.ok(errors.length > 0);
    assert.equal(session.history.length, 2);
    assert.equal(session.snapshot().log.at(-1).type, "status");
    assert.equal(
      session.snapshot().log.some((e) => e.type === "error"),
      false,
    );
  } finally {
    await s.done();
  }
});

test("many messages are written in order", async () => {
  const s = await sandbox();
  try {
    const steps = Array.from({ length: 25 }, (_, i) => ({
      text: `step ${i}`,
      toolCalls: [{ name: "list_dir", input: { path: "." } }],
    }));
    steps.push({ text: "end" });
    const session = makeSession(steps, { cwd: s.cwd });
    const rec = s.store.record(session, { cwd: s.cwd });
    await session.send("go");
    await rec.flush();
    const loaded = await s.store.load(rec.id);
    assert.equal(loaded.messages.length, 1 + 25 * 2 + 1);
    assert.deepEqual(loaded.messages, JSON.parse(JSON.stringify(session.history)));
  } finally {
    await s.done();
  }
});

test("titles come from the first line the user wrote", () => {
  const user = (t) => ({ role: "user", content: [text(t)] });
  assert.equal(titleFromMessage(user("\n  \n  fix   the\tbug \nplease")), "fix the bug");
  assert.equal(titleFromMessage(user("x".repeat(200))), `${"x".repeat(79)}…`);
  assert.equal(titleFromMessage({ role: "assistant", content: [text("hi")] }), "");
  assert.equal(titleFromMessage({ role: "user", content: [{ type: "tool_result", callId: "c", content: "r" }] }), "");
});

test("sameDir compares resolved paths", () => {
  assert.equal(sameDir("/a/b/../c", "/a/c"), true);
  assert.equal(sameDir("/a/b", "/a/c"), false);
});

test("isMessage accepts what sessions produce and rejects what they can't", () => {
  assert.equal(isMessage({ role: "user", content: [text("x")] }), true);
  assert.equal(
    isMessage({ role: "assistant", content: [{ type: "tool_call", id: "1", name: "n", input: null }] }),
    true,
  );
  assert.equal(
    isMessage({ role: "user", content: [{ type: "tool_result", callId: "1", content: "r", isError: true }] }),
    true,
  );
  assert.equal(isMessage(null), false);
  assert.equal(isMessage({ role: "tool", content: [] }), false);
  assert.equal(isMessage({ role: "user", content: [{ type: "tool_call", id: 1, name: "n" }] }), false);
});
