import { Show } from "solid-js";
import { attention } from "../lib/vault.ts";
import { folderName } from "../lib/workspace.ts";
import { vault } from "../state/secrets.ts";
import { chat } from "../state/store.ts";
import { paneOpen, setKeysOpen, setPaneOpen } from "../state/ui.ts";
import { changes, dataOf } from "../state/workspace.ts";
import { Logo } from "./Logo.tsx";
import { ModelSwitcher } from "./ModelSwitcher.tsx";

export function TopBar() {
  const state = () => {
    if (!chat.connected) return chat.ready ? "disconnected" : "connecting…";
    return chat.status;
  };
  const alert = () => {
    const s = vault();
    return s ? attention(s, chat.provider) : { needed: false, reason: "" };
  };
  return (
    <header class="topbar">
      <div class="brand">
        <Logo />
        <span>Albireo</span>
      </div>
      <span class="pill" data-state={state()} role="status">
        {state()}
      </span>
      <Show when={chat.cwd}>
        <span class="workspace-chip" title={chat.cwd}>
          {folderName(chat.cwd)}
        </span>
      </Show>
      <span class="spacer" />
      <ModelSwitcher />
      <Show when={vault()}>
        <button
          type="button"
          class="keys-btn"
          onClick={() => setKeysOpen(true)}
          title={alert().reason}
          aria-label={alert().needed ? "API Keys (needs attention)" : "API Keys"}
        >
          API Keys
          <Show when={alert().needed}>
            <span class="badge" aria-hidden="true">
              !
            </span>
          </Show>
        </button>
      </Show>
      <button
        type="button"
        class="pane-toggle"
        aria-pressed={paneOpen()}
        aria-label={paneOpen() ? "Hide the workspace pane" : "Show the workspace pane"}
        title="Changes, files and context"
        onClick={() => setPaneOpen(!paneOpen())}
      >
        Workspace
        <Show when={(dataOf(changes())?.files.length ?? 0) > 0}>
          <span class="count">{dataOf(changes())?.files.length}</span>
        </Show>
      </button>
    </header>
  );
}
