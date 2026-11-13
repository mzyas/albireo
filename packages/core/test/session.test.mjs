import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProviderRegistry,
  ScriptedProvider,
  Session,
  builtinTools,
  resolveInside,
  toOpenAIMessages,
  toAnthropicMessages,
} from "../dist/index.js";

async function makeSession(steps) {
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-"));
  const provider = new ScriptedProvider(steps);
  const registry = new ProviderRegistry().register("scripted", () => provider);
  const session = new Session({ providers: registry, provider: "scripted", tools: builtinTools, cwd });
  return { cwd, provider, session, registry };
}

test("read tools run without approval and the loop finishes", async () => {
  const { cwd, session } = await makeSession([
    { toolCalls: [{ name: "list_dir", input: { path: "." } }] },
    { text: "done" },
  ]);
  await session.send("hi");
  const types = session.snapshot().log.map((e) => e.type);
  assert.ok(types.includes("tool_result"));
  assert.equal(session.snapshot().log.findLast((e) => e.type === "assistant_end").text, "done");
  assert.equal(session.status, "idle");
  await rm(cwd, { recursive: true, force: true });
});

test("write tools wait for approval; approving runs them", async () => {
  const { cwd, session } = await makeSession([
    { toolCalls: [{ name: "write_file", input: { path: "a.txt", contents: "hello" } }] },
    { text: "ok" },
  ]);
  session.on((e) => {
    if (e.type === "approval_request") session.approve(e.id, true);
  });
  await session.send("write it");
  assert.equal(await readFile(path.join(cwd, "a.txt"), "utf8"), "hello");
  await rm(cwd, { recursive: true, force: true });
});

test("denied write does not touch disk and reports an error result", async () => {
  const { cwd, session } = await makeSession([
    { toolCalls: [{ name: "write_file", input: { path: "b.txt", contents: "x" } }] },
    { text: "ok" },
  ]);
  session.on((e) => {
    if (e.type === "approval_request") session.approve(e.id, false);
  });
  await session.send("write it");
  const result = session.snapshot().log.find((e) => e.type === "tool_result");
  assert.equal(result.isError, true);
  await assert.rejects(readFile(path.join(cwd, "b.txt"), "utf8"));
  await rm(cwd, { recursive: true, force: true });
});

test("invalid tool input is reported back, not executed", async () => {
  const { cwd, session } = await makeSession([
    { toolCalls: [{ name: "read_file", input: { path: 42 } }] },
    { text: "ok" },
  ]);
  await session.send("go");
  const result = session.snapshot().log.find((e) => e.type === "tool_result");
  assert.equal(result.isError, true);
  assert.match(result.content, /Invalid input/);
  await rm(cwd, { recursive: true, force: true });
});

test("paths cannot escape the workspace", () => {
  assert.throws(() => resolveInside("/work/proj", "../secret"));
  assert.throws(() => resolveInside("/work/proj", "/etc/passwd"));
  assert.doesNotThrow(() => resolveInside("/work/proj", "src/a.ts"));
});

test("history is provider-neutral: switching providers keeps the transcript", async () => {
  const { cwd, session, registry } = await makeSession([
    { toolCalls: [{ name: "list_dir", input: { path: "." } }] },
    { text: "first" },
  ]);
  const second = new ScriptedProvider([{ text: "second" }], "scripted2");
  registry.register("scripted2", () => second);
  await session.send("one");
  session.switchProvider("scripted2");
  await session.send("two");
  assert.equal(second.requests[0].messages.length, 5); // user, assistant(tool), tool result, assistant, user
  await rm(cwd, { recursive: true, force: true });
});

test("adapters translate neutral history for both vendors", () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "looking" },
        { type: "tool_call", id: "call_1", name: "list_dir", input: { path: "." } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", callId: "call_1", content: "a\nb" }] },
  ];
  const oa = toOpenAIMessages("sys", history);
  assert.deepEqual(oa.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(oa[2].tool_calls[0].function.arguments, '{"path":"."}');
  const an = toAnthropicMessages(history, "claude-opus-5-5");
  assert.equal(an[1].content[1].type, "tool_use");
  assert.equal(an[2].content[0].type, "tool_result");
});
