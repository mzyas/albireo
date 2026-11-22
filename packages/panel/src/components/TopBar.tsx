import { Show } from "solid-js";
import { attention } from "../lib/vault.ts";
import { vault } from "../state/secrets.ts";
import { chat } from "../state/store.ts";
import { setKeysOpen } from "../state/ui.ts";
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
    </header>
  );
}
