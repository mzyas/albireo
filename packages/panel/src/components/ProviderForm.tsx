import { createEffect, createSignal, For, on, Show } from "solid-js";
import { api } from "../api.ts";
import { errorMessage } from "../lib/format.ts";
import { providerBadge } from "../lib/vault.ts";
import type { ProviderPatchBody, ProviderSecretView, SecretsStatus } from "../protocol.ts";
import { clearDraft, getDraft, setDraft } from "../state/drafts.ts";
import { clearTick, keysMsg, setSecrets } from "../state/secrets.ts";
import { Field } from "./Field.tsx";

type Editable = "baseURL" | "model";

export function ProviderForm(props: {
  id: string;
  view: ProviderSecretView;
  /** Keys can be saved now (vault open, or it will open on first save). */
  usable: boolean;
  needsUnlock: boolean;
  active: boolean;
}) {
  const [key, setKey] = createSignal("");
  // Typed secrets never outlive the dialog.
  createEffect(on(clearTick, () => setKey(""), { defer: true }));

  const saved = (field: Editable) => props.view[field] ?? "";
  const shown = (field: Editable) => getDraft(props.id)?.[field] ?? saved(field);
  function edit(field: Editable, value: string) {
    // Back to the saved value means "not edited": it must not be sent.
    setDraft(props.id, field, value === saved(field) ? undefined : value);
  }

  const badge = () => providerBadge(props.view);
  const noAuth = () => props.view.auth === "none";
  const title = () => (props.view.name === props.id ? props.id : `${props.view.name} (${props.id})`);
  const deleteBlock = () =>
    props.active
      ? "Switch to another provider before deleting"
      : props.needsUnlock
        ? "Unlock the vault before deleting, so the stored key is deleted too"
        : "";
  const modelIds = () => [...new Set([props.view.defaultModel, ...(props.view.models ?? []).map((m) => m.id)])];

  async function save(patch: Omit<ProviderPatchBody, "provider">) {
    keysMsg("Saving…");
    try {
      const next = await api<SecretsStatus>("/secrets/provider", { provider: props.id, ...patch });
      setSecrets(next);
      setKey("");
      // Only a field that was sent and is unchanged since becomes clean: "Clear key", saving another
      // field, or edits typed while the save was in flight keep their unsaved edits.
      for (const field of ["baseURL", "model"] as const) {
        const sent = patch[field];
        if (sent !== undefined && getDraft(props.id)?.[field]?.trim() === sent) setDraft(props.id, field, undefined);
      }
      keysMsg(next.refreshPending ? "Saved. It takes effect when the current turn ends." : "Saved.");
    } catch (err) {
      keysMsg(errorMessage(err), true);
    }
  }

  async function remove() {
    keysMsg(`Deleting ${props.id}…`);
    try {
      setSecrets(await api<SecretsStatus>(`/providers/${encodeURIComponent(props.id)}`, undefined, "DELETE"));
      clearDraft(props.id);
      keysMsg(`Deleted custom provider "${props.id}".`);
    } catch (err) {
      keysMsg(errorMessage(err), true);
    }
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    // Only send what the user changed, so saving a key or a model never rewrites an untouched
    // (and possibly masked) base URL.
    const patch: Omit<ProviderPatchBody, "provider"> = {};
    const d = getDraft(props.id);
    if (d?.baseURL !== undefined) patch.baseURL = d.baseURL.trim();
    if (d?.model !== undefined) patch.model = d.model.trim();
    if (key().trim()) patch.apiKey = key().trim();
    if (Object.keys(patch).length === 0) {
      keysMsg("Nothing to save.");
      return;
    }
    void save(patch);
  }

  return (
    <form class="prov stack" onSubmit={submit}>
      <div class="prov-head">
        <h3>{title()}</h3>
        <span class="pill">{props.view.api}</span>
        <span class="pill" classList={{ ok: badge().ok }} title={props.view.problem ?? ""}>
          {badge().text}
        </span>
        <span class="spacer" />
        <Show when={!props.view.builtin}>
          <button
            type="button"
            class="danger"
            disabled={props.active || props.needsUnlock}
            title={deleteBlock() || `Delete custom provider ${props.id}`}
            onClick={remove}
          >
            Delete
          </button>
        </Show>
      </div>
      <Show when={props.usable}>
        <div class="stack">
          <Show when={!noAuth()}>
            <Field
              id={`prov-${props.id}-key`}
              label={props.view.auth === "bearer" ? "Bearer token" : "API key"}
              type="password"
              value={key()}
              onInput={setKey}
              placeholder={
                props.view.hasKey
                  ? `configured (${props.view.keyHint}) — leave blank to keep`
                  : props.view.auth === "bearer"
                    ? "paste bearer token"
                    : "paste API key"
              }
            />
          </Show>
          <Field
            id={`prov-${props.id}-base`}
            label="Base URL override (optional)"
            value={shown("baseURL")}
            onInput={(v) => edit("baseURL", v)}
            placeholder={props.view.defaultBaseURL}
          />
          <Field
            id={`prov-${props.id}-model`}
            label="Model override (optional)"
            value={shown("model")}
            onInput={(v) => edit("model", v)}
            placeholder={props.view.defaultModel}
            list={`prov-${props.id}-models`}
          />
          <datalist id={`prov-${props.id}-models`}>
            <For each={modelIds()}>{(m) => <option value={m} />}</For>
          </datalist>
          <div class="actions">
            <button type="submit" class="primary">
              Save
            </button>
            <Show when={!noAuth() && props.view.hasKey}>
              <button type="button" onClick={() => void save({ clearApiKey: true })}>
                Clear key
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </form>
  );
}
