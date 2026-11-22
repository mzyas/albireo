import assert from "node:assert/strict";
import test from "node:test";
import type { ServerEvent } from "../src/protocol.ts";
import { applyEvent, type ChatState, createChatState } from "../src/state/chat.ts";

const usage = { inputTokens: 10, outputTokens: 5 };

function feed(events: Partial<ServerEvent>[], state = createChatState()): ChatState {
  for (const ev of events) applyEvent(state, ev as ServerEvent);
  return state;
}

test("streamed text becomes one assistant message that is settled by assistant_end", () => {
  const s = feed([
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
  ]);
  assert.deepEqual(s.items, [{ kind: "assistant", reasoning: "", text: "Hello", live: true }]);
  feed([{ type: "assistant_end", text: "Hello", usage, provider: "p", model: "m", stopReason: "end_turn" }], s);
  assert.deepEqual(s.items, [{ kind: "assistant", reasoning: "", text: "Hello", live: false }]);
  assert.deepEqual(s.usage, { input: 10, output: 5, cacheRead: 0 });
});

test("an assistant_end with no streamed deltas (replayed log) still shows its text", () => {
  const s = feed([{ type: "assistant_end", text: "From the log", usage, provider: "p", model: "m" }]);
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0]?.kind === "assistant" && s.items[0].text, "From the log");
});

test("reasoning streams into the same message as the text", () => {
  const s = feed([
    { type: "reasoning_delta", text: "think" },
    { type: "text_delta", text: "answer" },
  ]);
  assert.deepEqual(s.items, [{ kind: "assistant", reasoning: "think", text: "answer", live: true }]);
});

test("an aborted turn does not leave a message streaming forever", () => {
  const s = feed([
    { type: "text_delta", text: "partial" },
    { type: "notice", text: "Aborted." },
    { type: "status", state: "idle" },
  ]);
  assert.equal(s.items[0]?.kind === "assistant" && s.items[0].live, false);
  // New output starts a new message instead of appending to the old one.
  feed([{ type: "text_delta", text: "next" }], s);
  assert.equal(s.items.filter((i) => i.kind === "assistant").length, 2);
});

test("an empty streaming placeholder is dropped when the turn ends without output", () => {
  const s = feed([
    { type: "text_delta", text: "" },
    { type: "status", state: "idle" },
  ]);
  assert.equal(s.items.length, 0);
});

test("consecutive read-only calls share one block; other calls stand alone", () => {
  const call = (id: string, risk: string) => ({ type: "tool_call", id, name: "t", input: {}, risk });
  const s = feed([call("1", "read"), call("2", "read"), call("3", "write"), call("4", "read")] as never);
  const blocks = s.items.map((i) => (i.kind === "tools" ? i.calls.map((c) => c.id).join(",") : i.kind));
  assert.deepEqual(blocks, ["1,2", "3", "4"]);
});

test("text between two read-only calls keeps them in separate blocks", () => {
  const call = (id: string) => ({ type: "tool_call", id, name: "t", input: {}, risk: "read" });
  const s = feed([call("1"), { type: "text_delta", text: "ok" }, call("2")] as never);
  assert.deepEqual(
    s.items.map((i) => i.kind),
    ["tools", "assistant", "tools"],
  );
});

test("tool results attach to their call, including inside a merged block", () => {
  const call = (id: string) => ({ type: "tool_call", id, name: "t", input: {}, risk: "read" });
  const s = feed([
    call("1"),
    call("2"),
    { type: "tool_result", id: "2", name: "t", content: "boom", isError: true },
    { type: "tool_result", id: "missing", name: "t", content: "ignored", isError: false },
  ] as never);
  const block = s.items[0];
  assert.ok(block?.kind === "tools");
  assert.equal(block.calls[0]?.result, undefined);
  assert.deepEqual(block.calls[1]?.result, { content: "boom", isError: true });
});

test("approvals are pending until resolved, and never duplicated", () => {
  const req = { type: "approval_request", id: "a", name: "run_command", input: { command: "ls" }, risk: "exec" };
  const s = feed([req, req] as never);
  assert.equal(s.pending.length, 1);
  feed([{ type: "approval_resolved", id: "a", allow: true }], s);
  assert.equal(s.pending.length, 0);
});

test("a snapshot rebuilds the whole view, including an unresolved approval that is also in the log", () => {
  const req = { type: "approval_request", id: "a", name: "write_file", input: {}, risk: "write" };
  const s = createChatState();
  s.items.push({ kind: "notice", text: "stale" });
  s.usage.input = 99;
  feed(
    [
      {
        type: "snapshot",
        log: [
          { type: "user", text: "hi", seq: 1 },
          { type: "assistant_end", text: "hello", usage, provider: "p", model: "m", stopReason: "end_turn", seq: 2 },
          { ...req, seq: 3 },
        ],
        live: { text: "typing", reasoning: "" },
        status: "running",
        provider: "anthropic",
        model: "claude",
        providers: ["anthropic", "openai"],
        pending: [req],
      },
    ] as never,
    s,
  );
  assert.deepEqual(
    s.items.map((i) => i.kind),
    ["user", "assistant", "assistant"],
  );
  assert.equal(s.items[2]?.kind === "assistant" && s.items[2].live, true);
  assert.equal(s.pending.length, 1);
  assert.equal(s.status, "running");
  assert.equal(s.provider, "anthropic");
  assert.deepEqual(s.providers, ["anthropic", "openai"]);
  assert.deepEqual(s.usage, { input: 10, output: 5, cacheRead: 0 });
  assert.equal(s.ready, true);
});

test("provider_changed updates the active model and leaves a notice", () => {
  const s = feed([{ type: "provider_changed", provider: "openai", model: "gpt" }]);
  assert.equal(s.provider, "openai");
  assert.equal(s.model, "gpt");
  assert.deepEqual(s.items, [{ kind: "notice", text: "Switched to openai · gpt" }]);
});

test("secrets_changed is not a chat event", () => {
  assert.deepEqual(feed([{ type: "secrets_changed" }]), createChatState());
});
