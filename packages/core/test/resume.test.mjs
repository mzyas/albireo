import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  builtinTools,
  eventsFromHistory,
  ProviderRegistry,
  ScriptedProvider,
  Session,
  UNFINISHED_TOOL_TEXT,
} from "../dist/index.js";

const text = (t) => ({ type: "text", text: t });
const meta = (over = {}) => ({
  provider: "p",
  model: "m",
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
  at: 1,
  ...over,
});

function makeSession(steps, opts = {}) {
  const provider = new ScriptedProvider(steps);
  const registry = new ProviderRegistry().register("scripted", () => provider);
  const session = new Session({
    providers: registry,
    provider: "scripted",
    tools: builtinTools,
    cwd: tmpdir(),
    ...opts,
  });
  return { session, provider };
}

test("eventsFromHistory rebuilds the events a client would have seen", () => {
  const history = [
    { role: "user", content: [text("list files")] },
    {
      role: "assistant",
      content: [text("Looking."), { type: "tool_call", id: "c1", name: "list_dir", input: { path: "." } }],
      meta: meta({ stopReason: "tool_use" }),
    },
    { role: "user", content: [{ type: "tool_result", callId: "c1", content: "a.txt", isError: false }] },
    { role: "assistant", content: [text("Found a.txt.")], meta: meta() },
  ];
  const events = eventsFromHistory(history, (name) => (name === "list_dir" ? "read" : "unknown"));
  assert.deepEqual(events, [
    { type: "user", text: "list files" },
    {
      type: "assistant_end",
      text: "Looking.",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
      provider: "p",
      model: "m",
    },
    { type: "tool_call", id: "c1", name: "list_dir", input: { path: "." }, risk: "read" },
    { type: "tool_result", id: "c1", name: "list_dir", content: "a.txt", isError: false },
    {
      type: "assistant_end",
      text: "Found a.txt.",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
      provider: "p",
      model: "m",
    },
  ]);
});

test("eventsFromHistory copes with messages that lack meta, and marks unanswered tool calls as failed", () => {
  const history = [
    { role: "user", content: [text("go")] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c9", name: "run_command", input: { command: "sleep 100" } }],
      native: { provider: "anthropic", model: "claude", payload: {} },
    },
  ];
  const events = eventsFromHistory(history, () => "exec");
  assert.deepEqual(events[1], {
    type: "assistant_end",
    text: "",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    provider: "anthropic",
    model: "claude",
  });
  assert.deepEqual(events.at(-1), {
    type: "tool_result",
    id: "c9",
    name: "run_command",
    content: UNFINISHED_TOOL_TEXT,
    isError: true,
  });
  assert.deepEqual(
    eventsFromHistory([], () => "read"),
    [],
  );
});

test("a session built from a history shows it in its snapshot and continues the conversation", async () => {
  const history = [
    { role: "user", content: [text("hello")] },
    { role: "assistant", content: [text("hi there")], meta: meta() },
  ];
  const { session, provider } = makeSession([{ text: "second answer" }], { history });

  const snap = session.snapshot();
  assert.deepEqual(
    snap.log.map((e) => e.type),
    ["user", "assistant_end"],
  );
  assert.deepEqual(
    snap.log.map((e) => e.seq),
    [1, 2],
  );
  assert.equal(snap.status, "idle");
  assert.equal(session.history.length, 2);

  await session.send("and now?");
  // The model sees the restored messages first, then the new one.
  const sent = provider.requests[0].messages.map((m) => m.content[0].text);
  assert.deepEqual(sent, ["hello", "hi there", "and now?"]);
  // New events continue the numbering instead of restarting it.
  const seqs = session.snapshot().log.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(session.snapshot().log.at(-1).type, "status");
});

test("the history passed in is copied, not shared", () => {
  const history = [{ role: "user", content: [text("hello")] }];
  const { session } = makeSession([], { history });
  session.history.push({ role: "user", content: [text("more")] });
  assert.equal(history.length, 1);
});

test("onMessage hears every message of a turn, in order, and not the restored ones", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-resume-"));
  try {
    const restored = [{ role: "user", content: [text("old")] }];
    const { session } = makeSession([{ toolCalls: [{ name: "list_dir", input: { path: "." } }] }, { text: "done" }], {
      history: restored,
      cwd: dir,
    });
    const heard = [];
    session.onMessage((m) => heard.push(m));
    await session.send("new");

    assert.deepEqual(
      heard.map((m) => [m.role, m.content.map((p) => p.type).join("+")]),
      [
        ["user", "text"],
        ["assistant", "tool_call"],
        ["user", "tool_result"],
        ["assistant", "text"],
      ],
    );
    // The assistant messages carry the meta the session adds, by the time they are announced.
    assert.equal(heard[1].meta.model, "scripted-1");
    assert.deepEqual(heard, session.history.slice(1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a listener can be removed, and one that throws does not break the turn", async () => {
  const { session } = makeSession([{ text: "ok" }]);
  const heard = [];
  const off = session.onMessage((m) => heard.push(m));
  session.onMessage(() => {
    throw new Error("disk full");
  });
  off();
  await session.send("hi");
  assert.equal(heard.length, 0);
  assert.equal(session.snapshot().log.at(-1).type, "status");
  assert.equal(session.history.length, 2);
  assert.equal(
    session.snapshot().log.some((e) => e.type === "error"),
    false,
  );
});

test("resuming from a finished session gives the same view as the original", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-resume-"));
  try {
    const steps = [
      { text: "Let me look.", toolCalls: [{ name: "list_dir", input: { path: "." } }] },
      { text: "All done." },
    ];
    const { session: first } = makeSession(steps, { cwd: dir });
    await first.send("look around");

    const { session: second } = makeSession([], { cwd: dir, history: structuredClone(first.history) });
    const view = (s) =>
      s
        .snapshot()
        .log.filter((e) => ["user", "assistant_end", "tool_call", "tool_result"].includes(e.type))
        .map((e) => ({ type: e.type, text: e.text, id: e.id, name: e.name, content: e.content, risk: e.risk }))
        .sort((a, b) => a.type.localeCompare(b.type) || String(a.id).localeCompare(String(b.id)));
    assert.deepEqual(view(second), view(first));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
