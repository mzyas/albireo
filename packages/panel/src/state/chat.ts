// Pure chat state: the page is a function of the server's events. `applyEvent` mutates the state it
// is given, so the UI runs it inside a store's `produce` and the tests run it on a plain object.
import type { Risk } from "@albireo/core";
import type { ApprovalRequest, ServerEvent } from "../protocol.ts";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  risk: Risk | "unknown";
  result?: { content: string; isError: boolean };
}

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; reasoning: string; text: string; live: boolean }
  /** Consecutive read-only calls share one block (`merge`); every other call is a block of its own. */
  | { kind: "tools"; merge: boolean; calls: ToolCall[] }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string };

export interface ChatState {
  connected: boolean;
  /** True once the first snapshot has arrived. */
  ready: boolean;
  status: "idle" | "running";
  provider: string;
  model: string;
  providers: string[];
  items: Item[];
  pending: ApprovalRequest[];
  /** Token totals over the events this view has seen (the server keeps a bounded log). */
  usage: { input: number; output: number; cacheRead: number };
}

export function createChatState(): ChatState {
  return {
    connected: false,
    ready: false,
    status: "idle",
    provider: "",
    model: "",
    providers: [],
    items: [],
    pending: [],
    usage: { input: 0, output: 0, cacheRead: 0 },
  };
}

type AssistantItem = Extract<Item, { kind: "assistant" }>;

function lastItem(s: ChatState): Item | undefined {
  return s.items[s.items.length - 1];
}

/** The assistant message that is still streaming, started if there is none. */
function liveAssistant(s: ChatState): AssistantItem {
  const last = lastItem(s);
  if (last?.kind === "assistant" && last.live) return last;
  s.items.push({ kind: "assistant", reasoning: "", text: "", live: true });
  return lastItem(s) as AssistantItem;
}

/** A turn that ends without `assistant_end` (abort, error) leaves a live message behind: settle it. */
function closeLive(s: ChatState): void {
  const last = lastItem(s);
  if (last?.kind !== "assistant" || !last.live) return;
  if (!last.text && !last.reasoning) s.items.pop();
  else last.live = false;
}

function findCall(s: ChatState, id: string): ToolCall | undefined {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const it = s.items[i];
    if (it?.kind !== "tools") continue;
    const call = it.calls.find((c) => c.id === id);
    if (call) return call;
  }
  return undefined;
}

function addPending(s: ChatState, req: ApprovalRequest): void {
  if (!s.pending.some((p) => p.id === req.id)) s.pending.push(req);
}

export function applyEvent(s: ChatState, ev: ServerEvent): void {
  switch (ev.type) {
    case "text_delta":
      liveAssistant(s).text += ev.text;
      return;
    case "reasoning_delta":
      liveAssistant(s).reasoning += ev.text;
      return;
    case "snapshot": {
      s.items = [];
      s.pending = [];
      s.usage = { input: 0, output: 0, cacheRead: 0 };
      for (const e of ev.log) applyEvent(s, e);
      if (ev.live) {
        const a = liveAssistant(s);
        a.reasoning = ev.live.reasoning;
        a.text = ev.live.text;
      }
      for (const p of ev.pending) addPending(s, p);
      s.status = ev.status;
      s.provider = ev.provider;
      s.model = ev.model;
      s.providers = ev.providers;
      s.ready = true;
      return;
    }
    case "assistant_end": {
      const last = lastItem(s);
      if (last?.kind === "assistant" && last.live) closeLive(s);
      else if (ev.text) s.items.push({ kind: "assistant", reasoning: "", text: ev.text, live: false });
      s.usage.input += ev.usage.inputTokens;
      s.usage.output += ev.usage.outputTokens;
      s.usage.cacheRead += ev.usage.cacheReadTokens ?? 0;
      return;
    }
    case "secrets_changed":
      return;
  }

  // Every other event ends whatever assistant message was streaming.
  closeLive(s);
  switch (ev.type) {
    case "user":
      s.items.push({ kind: "user", text: ev.text });
      return;
    case "tool_call": {
      const call: ToolCall = { id: ev.id, name: ev.name, input: ev.input, risk: ev.risk };
      const merge = ev.risk === "read";
      const last = lastItem(s);
      if (merge && last?.kind === "tools" && last.merge) last.calls.push(call);
      else s.items.push({ kind: "tools", merge, calls: [call] });
      return;
    }
    case "tool_result": {
      const call = findCall(s, ev.id);
      if (call) call.result = { content: ev.content, isError: ev.isError };
      return;
    }
    case "approval_request":
      addPending(s, ev);
      return;
    case "approval_resolved": {
      const i = s.pending.findIndex((p) => p.id === ev.id);
      if (i >= 0) s.pending.splice(i, 1);
      return;
    }
    case "provider_changed":
      s.provider = ev.provider;
      s.model = ev.model;
      s.items.push({ kind: "notice", text: `Switched to ${ev.provider} · ${ev.model}` });
      return;
    case "status":
      s.status = ev.state;
      return;
    case "notice":
      s.items.push({ kind: "notice", text: ev.text });
      return;
    case "error":
      s.items.push({ kind: "error", text: ev.message });
      return;
  }
}
