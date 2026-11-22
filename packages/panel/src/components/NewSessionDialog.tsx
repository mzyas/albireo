import { createEffect, createSignal, For, Show } from "solid-js";
import { desktopBridge } from "../desktop.ts";
import { errorMessage } from "../lib/format.ts";
import { folderName } from "../lib/workspace.ts";
import { sessions, startSession } from "../state/sessions.ts";
import { chat } from "../state/store.ts";

/**
 * Starts a session in a workspace: one used before (a click), any absolute path (typed), or, in the
 * desktop app, a folder from the system's picker. The server checks that it is a real folder. A plain
 * browser has no folder browser: a web page can't be handed the file system.
 */
export function NewSessionDialog(props: { open: boolean; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  let field!: HTMLInputElement;
  const [cwd, setCwd] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // Only the desktop app's window has the picker.
  const bridge = desktopBridge();

  async function browse() {
    if (!bridge) return;
    try {
      const folder = await bridge.pickDirectory(cwd().trim() || undefined);
      if (folder) {
        setCwd(folder);
        setError("");
      }
    } catch (err) {
      setError(`The folder picker could not be opened (${errorMessage(err)}).`);
    }
  }

  const recent = () => (sessions()?.workspaces ?? []).slice(0, 6);

  createEffect(() => {
    if (props.open && !dialog.open) {
      // It starts where the session being looked at works: the likeliest wish.
      setCwd(chat.cwd || sessions()?.cwd || "");
      setError("");
      dialog.showModal();
      field.select();
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const folder = cwd().trim();
    if (!folder) {
      setError("Enter the folder the session should work in.");
      return;
    }
    setBusy(true);
    // The new session starts on the provider in use now, with that provider's default model.
    const problem = await startSession({ cwd: folder, provider: chat.provider || undefined });
    setBusy(false);
    if (problem) setError(problem);
    else dialog.close();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: closing on a backdrop click is a mouse convenience; Escape and the Cancel button already close the dialog
    <dialog
      ref={dialog}
      class="keys new-session"
      aria-labelledby="new-session-title"
      onClose={props.onClose}
      onClick={(e) => {
        if (e.target === dialog) dialog.close();
      }}
    >
      <form class="dialog-inner stack" onSubmit={submit}>
        <div class="dlg-head">
          <h2 id="new-session-title">New session</h2>
          <button type="button" class="ghost" aria-label="Close" onClick={() => dialog.close()}>
            ×
          </button>
        </div>
        <label for="new-session-cwd">Workspace folder</label>
        <div class="path-row">
          <input
            id="new-session-cwd"
            class="path-field"
            ref={field}
            list="new-session-recent"
            autocomplete="off"
            spellcheck={false}
            placeholder="An absolute path, e.g. D:\work\project"
            value={cwd()}
            onInput={(e) => setCwd(e.currentTarget.value)}
          />
          <Show when={bridge}>
            <button type="button" onClick={browse}>
              Browse…
            </button>
          </Show>
        </div>
        <datalist id="new-session-recent">
          <For each={recent()}>{(w) => <option value={w} />}</For>
        </datalist>
        <Show when={recent().length > 0}>
          <p class="muted">Used before</p>
          <ul class="plain recent">
            <For each={recent()}>
              {(w) => (
                <li>
                  <button type="button" class="link-row" title={w} onClick={() => setCwd(w)}>
                    <span class="name">{folderName(w)}</span>
                    <span class="dir">{w}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <p class="muted">The agent can read here without asking, and asks before it writes or runs anything.</p>
        <Show when={error()}>
          <p class="form-error" role="alert">
            {error()}
          </p>
        </Show>
        <div class="actions">
          <button type="submit" class="primary" disabled={busy()}>
            {busy() ? "Starting…" : "Start session"}
          </button>
          <button type="button" onClick={() => dialog.close()}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
