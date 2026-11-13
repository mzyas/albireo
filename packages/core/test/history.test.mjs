import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTHROPIC_MESSAGES_API,
  MISSING_RESULT_TEXT,
  ProviderRegistry,
  ScriptedProvider,
  Session,
  builtinTools,
  normalizeHistory,
  replaysNatively,
  toAnthropicMessages,
  toOpenAIMessages,
} from "../dist/index.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const asst = (...content) => ({ role: "assistant", content });
const call = (id, name = "list_dir") => ({ type: "tool_call", id, name, input: {} });
const result = (callId, content = "ok") => ({ type: "tool_result", callId, content });
const toolTurn = (id) => [asst(call(id)), { role: "user", content: [result(id)] }];
const target = { provider: "anthropic", model: "m1", api: ANTHROPIC_MESSAGES_API };

test("foreign tool-call ids are made portable and their results follow", () => {
  const longId = "call|" + "x".repeat(100);
  const out = normalizeHistory([user("hi"), ...toolTurn(longId)], target);
  const id = out[1].content[0].id;
  assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(out[2].content[0].callId, id);
});

test("already-portable ids are left alone", () => {
  const out = normalizeHistory([user("hi"), ...toolTurn("toolu_01AbC")], target);
  assert.equal(out[1].content[0].id, "toolu_01AbC");
  assert.equal(out[2].content[0].callId, "toolu_01AbC");
});

test("ids that collide after sanitizing stay distinct", () => {
  const out = normalizeHistory([user("hi"), ...toolTurn("a b"), ...toolTurn("a_b")], target);
  const first = out[1].content[0].id;
  const second = out[3].content[0].id;
  assert.notEqual(first, second);
  assert.equal(out[2].content[0].callId, first);
  assert.equal(out[4].content[0].callId, second);
});

test("maxIdLength is honoured", () => {
  const out = normalizeHistory([user("hi"), ...toolTurn("y".repeat(70))], target, { maxIdLength: 40 });
  assert.equal(out[1].content[0].id.length, 40);
  assert.equal(out[2].content[0].callId.length, 40);
});

test("natively replayed messages keep their ids; other models get sanitized ones", () => {
  const native = { provider: "anthropic", model: "m1", api: ANTHROPIC_MESSAGES_API, payload: [] };
  const msg = { ...asst(call("weird id|1")), native };
  const history = [user("hi"), msg, { role: "user", content: [result("weird id|1")] }];

  assert.equal(replaysNatively(msg, target), true);
  const same = normalizeHistory(history, target);
  assert.equal(same[1].content[0].id, "weird id|1");
  assert.equal(same[2].content[0].callId, "weird id|1");

  for (const other of [{ ...target, model: "m2" }, { ...target, api: "something-else" }, { ...target, provider: "openai" }]) {
    assert.equal(replaysNatively(msg, other), false);
    const out = normalizeHistory(history, other);
    assert.equal(out[1].content[0].id, "weird_id_1");
    assert.equal(out[2].content[0].callId, "weird_id_1");
  }
});

test("a call without a result gets an error result placed before the next user text", () => {
  const out = normalizeHistory([user("go"), asst(call("c1"), call("c2")), user("next")], target);
  assert.equal(out.length, 3);
  const parts = out[2].content;
  assert.deepEqual(parts.map((p) => p.type), ["tool_result", "tool_result", "text"]);
  assert.deepEqual(parts.slice(0, 2).map((p) => [p.callId, p.content, p.isError]), [
    ["c1", MISSING_RESULT_TEXT, true],
    ["c2", MISSING_RESULT_TEXT, true],
  ]);
});

test("real results are kept and ordered by call order; only missing ones are filled", () => {
  const out = normalizeHistory(
    [user("go"), asst(call("c1"), call("c2")), { role: "user", content: [result("c2", "second")] }],
    target,
  );
  const parts = out[2].content;
  assert.equal(parts[0].callId, "c1");
  assert.equal(parts[0].isError, true);
  assert.equal(parts[1].callId, "c2");
  assert.equal(parts[1].content, "second");
  assert.equal(parts[1].isError, undefined);
});

test("unanswered calls at the end of history get a closing user message", () => {
  const out = normalizeHistory([user("go"), asst(call("c1"))], target);
  assert.equal(out.length, 3);
  assert.equal(out[2].role, "user");
  assert.equal(out[2].content[0].callId, "c1");
});

test("two assistant messages in a row get results inserted between them", () => {
  const out = normalizeHistory([user("go"), asst(call("c1")), asst({ type: "text", text: "hm" })], target);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(out[2].content[0].callId, "c1");
});

test("results that answer no call are dropped", () => {
  const out = normalizeHistory([user("hi"), { role: "user", content: [result("ghost")] }, user("again")], target);
  assert.deepEqual(out.map((m) => m.content[0].text), ["hi", "again"]);
});

test("empty and whitespace-only text is dropped, and emptied messages disappear", () => {
  const out = normalizeHistory(
    [user("hi"), asst({ type: "text", text: "" }), asst({ type: "text", text: "  \n" }, { type: "text", text: "ok" }), user("  ")],
    target,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].content, [{ type: "text", text: "ok" }]);
});

test("null or missing content from hand-built histories is tolerated", () => {
  const out = normalizeHistory([user("hi"), { role: "assistant", content: null }, { role: "user" }, user("yo")], target);
  assert.deepEqual(out.map((m) => m.content[0].text), ["hi", "yo"]);
});

test("the input history is not mutated", () => {
  const history = [user("go"), asst(call("a b"), { type: "text", text: "" }), user("next")];
  const before = JSON.parse(JSON.stringify(history));
  normalizeHistory(history, target);
  assert.deepEqual(history, before);
});

test("the session stamps every assistant message with who produced it", async () => {
  const provider = new ScriptedProvider([{ text: "hello" }]);
  const registry = new ProviderRegistry().register("scripted", () => provider);
  const session = new Session({ providers: registry, provider: "scripted", tools: builtinTools, cwd: process.cwd() });
  await session.send("hi");
  const reply = session.history.find((m) => m.role === "assistant");
  assert.equal(reply.meta.provider, "scripted");
  assert.equal(reply.meta.model, "scripted-1");
  assert.equal(reply.meta.stopReason, "end_turn");
  assert.equal(typeof reply.meta.at, "number");
  assert.equal(session.history.find((m) => m.role === "user").meta, undefined);
});

test("anthropic adapter replays the native payload only for the same provider, model and api", () => {
  const payload = [{ type: "text", text: "NATIVE" }];
  const history = [
    user("hi"),
    { role: "assistant", content: [{ type: "text", text: "neutral" }], native: { provider: "anthropic", model: "m1", api: ANTHROPIC_MESSAGES_API, payload } },
    user("again"),
  ];
  assert.deepEqual(toAnthropicMessages(history, "m1")[1].content, payload);
  assert.equal(toAnthropicMessages(history, "m2")[1].content[0].text, "neutral");
  const wrongApi = [history[0], { ...history[1], native: { ...history[1].native, api: "other" } }, history[2]];
  assert.equal(toAnthropicMessages(wrongApi, "m1")[1].content[0].text, "neutral");
});

test("openai adapter shortens over-long foreign ids to 40 characters consistently", () => {
  const id = "z".repeat(80);
  const out = toOpenAIMessages("sys", [user("hi"), ...toolTurn(id)], "gpt-x");
  const assistant = out.find((m) => m.role === "assistant");
  const tool = out.find((m) => m.role === "tool");
  assert.equal(assistant.tool_calls[0].id.length, 40);
  assert.equal(tool.tool_call_id, assistant.tool_calls[0].id);
});

test("openai adapter fills missing tool results so the request stays valid", () => {
  const out = toOpenAIMessages("sys", [user("go"), asst(call("c1")), user("next")], "gpt-x");
  assert.deepEqual(out.map((m) => m.role), ["system", "user", "assistant", "tool", "user"]);
  assert.equal(out[3].tool_call_id, "c1");
});
