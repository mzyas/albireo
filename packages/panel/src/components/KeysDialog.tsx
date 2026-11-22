import { createEffect, createSignal, For, Show } from "solid-js";
import { api } from "../api.ts";
import { errorMessage } from "../lib/format.ts";
import { describeVault, formsUsable } from "../lib/vault.ts";
import type { SecretsStatus } from "../protocol.ts";
import { clearTick, keysMessage, keysMsg, loadSecrets, setClearTick, setSecrets, vault } from "../state/secrets.ts";
import { chat } from "../state/store.ts";
import { CustomProviderForm } from "./CustomProviderForm.tsx";
import { Field } from "./Field.tsx";
import { ProviderForm } from "./ProviderForm.tsx";

function UnlockForm(props: { status: SecretsStatus }) {
  const [pass, setPass] = createSignal("");
  const [pass2, setPass2] = createSignal("");
  const creating = () => props.status.state === "uninitialized";
  createEffect(() => {
    clearTick();
    setPass("");
    setPass2("");
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const passphrase = pass();
    if (creating() && passphrase !== pass2()) {
      keysMsg("The passphrases do not match.", true);
      return;
    }
    try {
      setSecrets(await api<SecretsStatus>("/secrets/unlock", { passphrase }));
      setPass("");
      setPass2("");
      keysMsg("Unlocked.");
    } catch (err) {
      keysMsg(errorMessage(err), true);
    }
  }

  return (
    <form class="stack" onSubmit={submit}>
      <Field
        id="passphrase"
        label="Passphrase"
        type="password"
        value={pass()}
        onInput={setPass}
        autocomplete={creating() ? "new-password" : "current-password"}
        required
      />
      <Show when={creating()}>
        <Field
          id="passphrase2"
          label="Repeat passphrase"
          type="password"
          value={pass2()}
          onInput={setPass2}
          autocomplete="new-password"
          required
        />
      </Show>
      <div class="actions">
        <button type="submit" class="primary">
          {creating() ? "Create vault" : "Unlock"}
        </button>
      </div>
    </form>
  );
}

function KeysBody(props: { status: SecretsStatus }) {
  const usable = () => formsUsable(props.status);
  const order = () => props.status.providerOrder ?? Object.keys(props.status.providers);

  async function lock() {
    try {
      setSecrets(await api<SecretsStatus>("/secrets/lock", {}));
      keysMsg("Locked.");
    } catch (err) {
      keysMsg(errorMessage(err), true);
    }
  }

  return (
    <>
      <p class="muted">{describeVault(props.status)}</p>
      <Show when={props.status.configError}>
        <p class="form-error">providers.json: {props.status.configError}</p>
      </Show>
      <Show when={!usable() && props.status.protection === "passphrase"}>
        <UnlockForm status={props.status} />
      </Show>
      <div>
        <For each={order()}>
          {(id) => (
            <Show when={props.status.providers[id]}>
              {(view) => (
                <ProviderForm
                  id={id}
                  view={view()}
                  usable={usable()}
                  needsUnlock={props.status.needsUnlock === true}
                  active={id === chat.provider}
                />
              )}
            </Show>
          )}
        </For>
      </div>
      <CustomProviderForm status={props.status} />
      <Show when={props.status.state === "unlocked" && props.status.protection === "passphrase"}>
        <div class="actions">
          <button type="button" onClick={lock}>
            Lock vault
          </button>
        </div>
      </Show>
    </>
  );
}

export function KeysDialog(props: { open: boolean; onClose: () => void }) {
  let dialog!: HTMLDialogElement;

  createEffect(() => {
    if (props.open && !dialog.open) {
      keysMsg("");
      dialog.showModal();
      void loadSecrets();
    } else if (!props.open && dialog.open) {
      dialog.close();
    }
  });

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: closing on a backdrop click is a mouse convenience; Escape and the Close button already close the dialog
    <dialog
      ref={dialog}
      class="keys"
      aria-labelledby="keys-title"
      onClose={() => {
        setClearTick((n) => n + 1);
        props.onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === dialog) dialog.close();
      }}
    >
      <div class="dialog-inner">
        <div class="dlg-head">
          <h2 id="keys-title">API Keys &amp; Providers</h2>
          <button type="button" class="ghost" aria-label="Close" onClick={() => dialog.close()}>
            ×
          </button>
        </div>
        <Show when={vault()}>{(s) => <KeysBody status={s()} />}</Show>
        <p class="keys-msg" classList={{ error: keysMessage().error }} role="status">
          {keysMessage().text}
        </p>
      </div>
    </dialog>
  );
}
