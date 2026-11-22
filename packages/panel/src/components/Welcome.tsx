import { Show } from "solid-js";
import { attention } from "../lib/vault.ts";
import { vault } from "../state/secrets.ts";
import { chat } from "../state/store.ts";
import { setKeysOpen } from "../state/ui.ts";
import { Logo } from "./Logo.tsx";

export function Welcome() {
  const needsSetup = () => {
    const s = vault();
    return s ? attention(s, chat.provider) : { needed: false, reason: "" };
  };
  return (
    <div class="welcome">
      <Logo size={40} />
      <h1>Albireo</h1>
      <p>
        Ask for a change, a review, or an explanation. Albireo reads and edits files in the workspace it was started in.
      </p>
      <Show when={chat.ready && needsSetup().needed}>
        <div class="callout">
          <p>{needsSetup().reason}</p>
          <button type="button" class="primary" onClick={() => setKeysOpen(true)}>
            Set up API keys
          </button>
        </div>
      </Show>
    </div>
  );
}
