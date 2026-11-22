import { createEffect, on, onCleanup, onMount, Show } from "solid-js";
import { toJson } from "../lib/format.ts";
import { approvalBody } from "../lib/tools.ts";
import { answerApproval } from "../state/actions.ts";
import { chat } from "../state/store.ts";
import { composerBusy } from "../state/ui.ts";

/** The pending approval, pinned above the message box so it can't scroll out of sight. */
export function ApprovalCard() {
  let allow: HTMLButtonElement | undefined;
  const req = () => chat.pending[0];

  // Bring the card to the keyboard when it appears, unless the user is in the middle of typing.
  createEffect(
    on(
      () => req()?.id,
      (id) => {
        if (id && !composerBusy()) queueMicrotask(() => allow?.focus());
      },
    ),
  );

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const current = req();
      if (e.key !== "Escape" || e.defaultPrevented || !current) return;
      const target = e.target instanceof Element ? e.target : null;
      // Escape belongs to dialogs and text fields first.
      if (target?.closest("dialog[open]") || target?.matches("input, textarea, select")) return;
      answerApproval(current.id, false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <Show when={req()} keyed>
      {(r) => {
        const body = () => approvalBody(r.name, r.input);
        return (
          <section class="approval" aria-labelledby="approval-title">
            <header>
              <strong id="approval-title">
                Allow <code>{r.name}</code>?
              </strong>
              <span class="risk" data-risk={r.risk}>
                {r.risk}
              </span>
              <Show when={chat.pending.length > 1}>
                <span class="more">+{chat.pending.length - 1} more waiting</span>
              </Show>
            </header>
            <Show when={body()} fallback={<pre class="approval-code">{toJson(r.input)}</pre>}>
              {(b) => (
                <>
                  <div class="label">{b().label}</div>
                  <pre class="approval-code">{b().text}</pre>
                </>
              )}
            </Show>
            <div class="approval-actions">
              <button type="button" class="primary" ref={allow} onClick={() => answerApproval(r.id, true)}>
                Allow <kbd>Enter</kbd>
              </button>
              <button type="button" onClick={() => answerApproval(r.id, false)}>
                Deny <kbd>Esc</kbd>
              </button>
            </div>
          </section>
        );
      }}
    </Show>
  );
}
