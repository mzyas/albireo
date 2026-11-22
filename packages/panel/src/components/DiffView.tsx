import { createMemo, For, Show } from "solid-js";
import { parseDiff } from "../lib/diff.ts";

const SIGN = { add: "+", del: "−", ctx: " ", note: "" } as const;

/** A file's unified diff: numbered lines in hunks, added and removed lines marked. Text nodes only. */
export function DiffView(props: { text: string; truncated?: boolean }) {
  const parsed = createMemo(() => parseDiff(props.text));
  return (
    <div class="diff">
      <p class="diff-stats">
        <span class="plus">+{parsed().added}</span> <span class="minus">−{parsed().removed}</span>
        <Show when={parsed().notes.length > 0}>
          <span class="muted"> · {parsed().notes.join(" · ")}</span>
        </Show>
      </p>
      <Show when={parsed().binary}>
        <p class="muted">This is a binary file, so there is no text diff.</p>
      </Show>
      <div class="diff-scroll">
        <For each={parsed().hunks}>
          {(hunk) => (
            <section class="hunk">
              <div class="hunk-head">{hunk.header}</div>
              <For each={hunk.lines}>
                {(line) => (
                  <div class="dl" data-kind={line.kind}>
                    <span class="ln" aria-hidden="true">
                      {"oldNo" in line ? line.oldNo : ""}
                    </span>
                    <span class="ln" aria-hidden="true">
                      {"newNo" in line ? line.newNo : ""}
                    </span>
                    <span class="dt">
                      {SIGN[line.kind]}
                      {line.text}
                    </span>
                  </div>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
      <Show when={props.truncated}>
        <p class="muted">The diff is long; only the first part is shown.</p>
      </Show>
    </div>
  );
}
