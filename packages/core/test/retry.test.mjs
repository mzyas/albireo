import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, ProviderRegistry, ScriptedProvider, Session } from "../dist/index.js";

/** Fails its first `failures` requests, then answers from the script. */
class FlakyProvider extends ScriptedProvider {
  constructor(steps, failures) {
    super(steps);
    this.failures = failures;
  }
  async runTurn(req, onEvent) {
    if (this.failures > 0) {
      this.failures--;
      this.requests.push(req);
      throw new Error("network down");
    }
    return super.runTurn(req, onEvent);
  }
}

async function setup(provider) {
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-retry-"));
  const registry = new ProviderRegistry().register("scripted", () => provider);
  const session = new Session({ providers: registry, provider: "scripted", tools: builtinTools, cwd });
  return { cwd, session };
}

const statuses = (session) => session.snapshot().log.filter((e) => e.type === "status");

test("a failed turn can be retried without adding a second user message", async () => {
  const provider = new FlakyProvider([{ text: "recovered" }], 1);
  const { cwd, session } = await setup(provider);
  try {
    assert.equal(session.canRetry, false, "an empty session has nothing to retry");
    await session.send("hello");
    assert.equal(session.canRetry, true);
    assert.equal(session.snapshot().canRetry, true);
    assert.equal(statuses(session).at(-1).canRetry, true, "the idle event says so too");

    await session.retry();
    assert.equal(session.canRetry, false);
    assert.equal(statuses(session).at(-1).canRetry, false);
    assert.deepEqual(
      session.history.map((m) => m.role),
      ["user", "assistant"],
      "the retry reuses the user message",
    );
    const users = session.snapshot().log.filter((e) => e.type === "user");
    assert.equal(users.length, 1);
    assert.equal(session.snapshot().log.findLast((e) => e.type === "assistant_end").text, "recovered");
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(provider.requests[1].messages, provider.requests[0].messages, "the same request goes out again");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retry after a model switch uses the new model", async () => {
  const first = new FlakyProvider([], 1);
  const second = new ScriptedProvider([{ text: "from the second" }], "other");
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-retry-"));
  const registry = new ProviderRegistry().register("scripted", () => first).register("other", () => second);
  const session = new Session({ providers: registry, provider: "scripted", tools: builtinTools, cwd });
  try {
    await session.send("hello");
    session.switchProvider("other");
    assert.equal(session.canRetry, true, "switching does not change the history");
    await session.retry();
    assert.equal(second.requests.length, 1);
    assert.equal(session.snapshot().log.findLast((e) => e.type === "assistant_end").text, "from the second");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retry with nothing to retry reports an error and does not start a turn", async () => {
  const provider = new ScriptedProvider([{ text: "hi" }]);
  const { cwd, session } = await setup(provider);
  try {
    await session.retry();
    assert.equal(provider.requests.length, 0);
    assert.equal(session.snapshot().log.at(-1).type, "error");

    await session.send("hello");
    await session.retry(); // the last turn was answered
    assert.equal(provider.requests.length, 1);
    assert.equal(session.snapshot().log.at(-1).type, "error");
    assert.equal(session.status, "idle");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retry continues a turn that was aborted between a tool call and the model's next step", async () => {
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "list_dir", input: { path: "." } }] },
    { text: "finished" },
  ]);
  const { cwd, session } = await setup(provider);
  try {
    // Abort as soon as the tool result is out: the history then ends with the tool results.
    session.on((e) => {
      if (e.type === "tool_call") session.abort();
    });
    await session.send("look around");
    assert.equal(session.history.at(-1).role, "user");
    assert.equal(session.canRetry, true);

    await session.retry();
    assert.equal(session.snapshot().log.findLast((e) => e.type === "assistant_end").text, "finished");
    assert.equal(session.canRetry, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("retry while a turn is running does nothing but report it", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = new ScriptedProvider([{ text: "slow" }]);
  const run = provider.runTurn.bind(provider);
  provider.runTurn = async (req, onEvent) => {
    await gate;
    return run(req, onEvent);
  };
  const { cwd, session } = await setup(provider);
  try {
    const turn = session.send("hello");
    await session.retry();
    assert.equal(session.snapshot().log.findLast((e) => e.type === "error").message, "A turn is already running");
    release();
    await turn;
    assert.equal(provider.requests.length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
