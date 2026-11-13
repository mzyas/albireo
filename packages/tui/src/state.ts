import type { LoggedEvent, Snapshot } from "@albireo/core";

export interface Item {
  id: number;
  kind: "user" | "assistant" | "tool" | "result" | "notice" | "error";
  text: string;
  isError?: boolean;
}

export interface Approval {
  id: string;
  name: string;
  input: unknown;
  risk: string;
}

export interface UiState {
  items: Item[];
  live: { text: string; reasoning: string } | null;
  approval: Approval | null;
  status: "idle" | "running";
  provider: string;
  model: string;
  nextId: number;
}

export function initialState(snap: Snapshot): UiState {
  let s: UiState = {
    items: [],
    live: snap.live,
    approval: snap.pending[0] ?? null,
    status: snap.status,
    provider: snap.provider,
    model: snap.model,
    nextId: 1,
  };
  for (const e of snap.log) s = reduce(s, e);
  return s;
}

function push(s: UiState, kind: Item["kind"], text: string, isError?: boolean): UiState {
  return { ...s, items: [...s.items, { id: s.nextId, kind, text, isError }], nextId: s.nextId + 1 };
}

export function reduce(s: UiState, e: LoggedEvent): UiState {
  switch (e.type) {
    case "user":
      return push(s, "user", e.text);
    case "text_delta":
      return { ...s, live: { text: (s.live?.text ?? "") + e.text, reasoning: s.live?.reasoning ?? "" } };
    case "reasoning_delta":
      return { ...s, live: { text: s.live?.text ?? "", reasoning: (s.live?.reasoning ?? "") + e.text } };
    case "assistant_end": {
      const next = { ...s, live: null };
      return e.text ? push(next, "assistant", e.text) : next;
    }
    case "tool_call":
      return push(s, "tool", `${e.name} ${JSON.stringify(e.input)}`);
    case "approval_request":
      return { ...s, approval: { id: e.id, name: e.name, input: e.input, risk: e.risk } };
    case "approval_resolved":
      return s.approval?.id === e.id ? { ...s, approval: null } : s;
    case "tool_result":
      return push(s, "result", e.content, e.isError);
    case "provider_changed":
      return push({ ...s, provider: e.provider, model: e.model }, "notice", `Switched to ${e.provider} · ${e.model}`);
    case "status":
      return { ...s, status: e.state };
    case "notice":
      return push(s, "notice", e.text);
    case "error":
      return push(s, "error", e.message);
  }
}
