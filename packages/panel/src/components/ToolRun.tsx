import { createMemo, For, Show } from "solid-js";
import { toJson } from "../lib/format.ts";
import { toolSummary } from "../lib/tools.ts";
import type { ToolCall } from "../state/chat.ts";
import { chat } from "../state/store.ts";

type Phase = "waiting" | "running" | "done" | "failed";

function phaseOf(call: ToolCall): Phase {
  if (call.result) return call.result.isError ? "failed" : "done";
  return chat.pending.some((p) => p.id === call.id) ? "waiting" : "running";
}

const PHASE_LABEL: Record<Phase, string> = {
  waiting: "waiting for approval",
  running: "running",
  done: "done",
  failed: "failed",
};

function ToolRow(props: { call: ToolCall }) {
  const phase = () => phaseOf(props.call);
  return (
    <details class="tool" data-phase={phase()}>
      <summary>
        <span class="tool-name">{props.call.name}</span>
        <span class="tool-arg">{toolSummary(props.call.input)}</span>
        <span class="tool-phase">{PHASE_LABEL[phase()]}</span>
      </summary>
      <div class="tool-body">
        <div class="label">Input</div>
        <pre>{toJson(props.call.input)}</pre>
        <Show when={props.call.result}>
          {(r) => (
            <>
              <div class="label">{r().isError ? "Error" : "Result"}</div>
              <pre>{r().content}</pre>
            </>
          )}
        </Show>
      </div>
    </details>
  );
}

/** A block of tool calls: one call is a row; several read-only calls fold into one summary. */
export function ToolRun(props: { calls: ToolCall[] }) {
  const failed = createMemo(() => props.calls.filter((c) => c.result?.isError).length);
  const active = createMemo(() => props.calls.filter((c) => !c.result).length);
  return (
    <Show when={props.calls.length > 1} fallback={<ToolRow call={props.calls[0] as ToolCall} />}>
      <details class="tool-group">
        <summary>
          <span class="tool-name">Read-only</span>
          <span class="tool-arg">{props.calls.length} calls</span>
          <span class="tool-phase" data-phase={failed() > 0 ? "failed" : active() > 0 ? "running" : "done"}>
            {failed() > 0 ? `${failed()} failed` : active() > 0 ? "running" : "done"}
          </span>
        </summary>
        <div class="tool-group-body">
          <For each={props.calls}>{(call) => <ToolRow call={call} />}</For>
        </div>
      </details>
    </Show>
  );
}
