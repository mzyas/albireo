import type { ContentPart, Message } from "./types.js";

/** The model (and wire API) a history is about to be sent to. */
export interface HistoryTarget {
  provider: string;
  model: string;
  /** Wire API variant, e.g. "anthropic-messages". Native payloads only replay when it matches. */
  api?: string;
}

export interface NormalizeOptions {
  /** Longest tool-call id the target accepts. Default 64. */
  maxIdLength?: number;
}

export const MISSING_RESULT_TEXT = "No result was recorded for this tool call.";

type ToolResultPart = Extract<ContentPart, { type: "tool_result" }>;

/** True when this assistant message can be replayed from its provider-native payload. */
export function replaysNatively(m: Message, target: HistoryTarget): boolean {
  return (
    m.role === "assistant" &&
    m.native !== undefined &&
    m.native.provider === target.provider &&
    m.native.model === target.model &&
    m.native.api === target.api
  );
}

function missingResult(callId: string): ToolResultPart {
  return { type: "tool_result", callId, content: MISSING_RESULT_TEXT, isError: true };
}

/**
 * Make a provider-neutral history safe to send to `target`. Pure: returns a new array.
 *
 *  - tool-call ids from other providers are rewritten to a portable form (and their results follow);
 *    messages replayed natively keep their ids because the native payload still carries them
 *  - every tool call gets a result: missing ones are filled with an error result, placed first in the
 *    next user message (the order both vendors require)
 *  - tool results that answer no call are dropped
 *  - empty / whitespace-only text parts and messages left empty are dropped
 *  - null or missing content (hand-built or old persisted histories) is treated as empty
 */
export function normalizeHistory(
  messages: readonly Message[],
  target: HistoryTarget,
  opts: NormalizeOptions = {},
): Message[] {
  const maxId = opts.maxIdLength ?? 64;
  const idMap = new Map<string, string>();
  const used = new Set<string>();

  const reserve = (id: string): void => {
    idMap.set(id, id);
    used.add(id);
  };
  const mapId = (id: string): string => {
    const known = idMap.get(id);
    if (known !== undefined) return known;
    const base = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxId) || "call";
    let candidate = base;
    let n = 1;
    while (used.has(candidate)) {
      const suffix = `_${++n}`;
      candidate = base.slice(0, maxId - suffix.length) + suffix;
    }
    used.add(candidate);
    idMap.set(id, candidate);
    return candidate;
  };

  const out: Message[] = [];
  let pending: string[] | null = null; // ids of the last assistant message's calls still awaiting results

  const flushPending = (): void => {
    if (pending) out.push({ role: "user", content: pending.map(missingResult) });
    pending = null;
  };

  for (const raw of messages) {
    const parts = ((raw.content as ContentPart[] | null | undefined) ?? []).filter(
      (p) => !(p.type === "text" && p.text.trim() === ""),
    );
    const m: Message = { ...raw, content: parts };

    if (m.role === "assistant") {
      flushPending();
      if (parts.length === 0) continue;

      const native = replaysNatively(m, target);
      const content = parts.map((p): ContentPart => {
        if (p.type !== "tool_call") return p;
        if (native) {
          reserve(p.id);
          return p;
        }
        return { ...p, id: mapId(p.id) };
      });
      const ids = content.flatMap((p) => (p.type === "tool_call" ? [p.id] : []));
      pending = ids.length > 0 ? ids : null;
      out.push({ ...m, content });
      continue;
    }

    const results = parts.filter((p): p is ToolResultPart => p.type === "tool_result");
    const rest = parts.filter((p) => p.type !== "tool_result");

    if (pending) {
      const wanted = new Set<string>(pending);
      const byId = new Map<string, ToolResultPart>();
      for (const r of results) {
        const id = idMap.get(r.callId) ?? r.callId;
        if (wanted.has(id) && !byId.has(id)) byId.set(id, { ...r, callId: id });
      }
      const ordered = pending.map((id) => byId.get(id) ?? missingResult(id));
      pending = null;
      out.push({ ...m, content: [...ordered, ...rest] });
    } else if (rest.length > 0) {
      out.push({ ...m, content: rest }); // results with no call to answer are dropped
    }
  }

  flushPending();
  return out;
}
