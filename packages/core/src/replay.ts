import type { KernelEvent } from "./session.js";
import type { Risk } from "./tool.js";
import type { Message } from "./types.js";

export const UNFINISHED_TOOL_TEXT = "The session ended before this tool call finished, so it has no result.";

/**
 * The events a client would have seen while `history` was being made, rebuilt from the history alone:
 * user messages, one `assistant_end` per assistant message, and tool calls with their results.
 *
 * It is what a resumed session shows in `snapshot()`. Streaming deltas, notices, errors and approval
 * requests were never part of the history, so they do not come back. A tool call that was never
 * answered (the process died mid-tool) gets an error result, so the view does not show it as running.
 */
export function eventsFromHistory(
  history: readonly Message[],
  riskOf: (tool: string) => Risk | "unknown",
): KernelEvent[] {
  const out: KernelEvent[] = [];
  const open = new Map<string, string>(); // call id → tool name, until its result arrives

  for (const m of history) {
    const content = m.content ?? [];
    const text = content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

    if (m.role === "user") {
      if (text) out.push({ type: "user", text });
      for (const p of content) {
        if (p.type !== "tool_result") continue;
        const name = open.get(p.callId) ?? "";
        open.delete(p.callId);
        out.push({ type: "tool_result", id: p.callId, name, content: p.content, isError: p.isError === true });
      }
      continue;
    }

    out.push({
      type: "assistant_end",
      text,
      stopReason: m.meta?.stopReason ?? "end_turn",
      usage: m.meta?.usage ?? { inputTokens: 0, outputTokens: 0 },
      provider: m.meta?.provider ?? m.native?.provider ?? "",
      model: m.meta?.model ?? m.native?.model ?? "",
    });
    for (const p of content) {
      if (p.type !== "tool_call") continue;
      open.set(p.id, p.name);
      out.push({ type: "tool_call", id: p.id, name: p.name, input: p.input, risk: riskOf(p.name) });
    }
  }

  for (const [id, name] of open) {
    out.push({ type: "tool_result", id, name, content: UNFINISHED_TOOL_TEXT, isError: true });
  }
  return out;
}
