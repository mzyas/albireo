import { createEffect, createSignal, on, Show } from "solid-js";
import { api } from "../api.ts";
import { errorMessage } from "../lib/format.ts";
import { addProviderBlock, buildCustomProviderPayload, type CustomProviderInput, formsUsable } from "../lib/vault.ts";
import type { SecretsStatus } from "../protocol.ts";
import { clearTick, keysMsg, setSecrets } from "../state/secrets.ts";
import { Field } from "./Field.tsx";

export function CustomProviderForm(props: { status: SecretsStatus }) {
  const [open, setOpen] = createSignal(false);
  const [id, setId] = createSignal("");
  const [name, setName] = createSignal("");
  const [wire, setWire] = createSignal<CustomProviderInput["api"]>("openai-completions");
  const [auth, setAuth] = createSignal<CustomProviderInput["auth"]>("api-key");
  const [baseURL, setBaseURL] = createSignal("");
  const [defaultModel, setDefaultModel] = createSignal("");
  const [extraModels, setExtraModels] = createSignal("");
  const [maxTokensField, setMaxTokensField] = createSignal("max_completion_tokens");
  const [usageInStreaming, setUsageInStreaming] = createSignal(true);
  const [nonNullContent, setNonNullContent] = createSignal(false);
  const [developerRole, setDeveloperRole] = createSignal(false);
  const [thinkingMode, setThinkingMode] = createSignal("none");
  const [eagerToolInput, setEagerToolInput] = createSignal(false);
  const [fallbacks, setFallbacks] = createSignal(false);
  const [key, setKey] = createSignal("");
  createEffect(on(clearTick, () => setKey(""), { defer: true }));

  const isAnthropic = () => wire() === "anthropic-messages";
  const blocked = () => addProviderBlock(props.status);
  // The server refuses new providers while the vault is locked or can't be opened: a key stored under
  // the same ID before could not be cleared.
  const keyRowHidden = () => auth() === "none" || !formsUsable(props.status);

  function reset() {
    setId("");
    setName("");
    setWire("openai-completions");
    setAuth("api-key");
    setBaseURL("");
    setDefaultModel("");
    setExtraModels("");
    setMaxTokensField("max_completion_tokens");
    setUsageInStreaming(true);
    setNonNullContent(false);
    setDeveloperRole(false);
    setThinkingMode("none");
    setEagerToolInput(false);
    setFallbacks(false);
    setKey("");
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    const payload = buildCustomProviderPayload({
      id: id(),
      name: name(),
      api: wire(),
      auth: auth(),
      baseURL: baseURL(),
      defaultModel: defaultModel(),
      extraModels: extraModels(),
      openai: {
        maxTokensField: maxTokensField(),
        usageInStreaming: usageInStreaming(),
        nonNullContent: nonNullContent(),
        developerRole: developerRole(),
      },
      anthropic: { thinkingMode: thinkingMode(), eagerToolInput: eagerToolInput(), fallbacks: fallbacks() },
    });
    const providerId = String(payload.id);
    const initialKey = key().trim();
    const needsKey = auth() !== "none" && initialKey !== "";
    keysMsg("Saving custom provider…");
    try {
      setSecrets(await api<SecretsStatus>("/providers", payload));
    } catch (err) {
      keysMsg(errorMessage(err), true);
      return;
    }
    reset();
    setOpen(false);
    // The provider is saved either way; a key that fails can be entered in its own form.
    if (needsKey) {
      try {
        setSecrets(await api<SecretsStatus>("/secrets/provider", { provider: providerId, apiKey: initialKey }));
      } catch (err) {
        keysMsg(`Saved custom provider "${providerId}", but not its key: ${errorMessage(err)}`, true);
        return;
      }
    }
    keysMsg(`Saved custom provider "${providerId}".`);
  }

  return (
    <details class="prov" open={open()} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Add custom provider</summary>
      <form class="stack" onSubmit={submit}>
        <div class="grid2">
          <Field
            id="cp-id"
            label="Provider ID"
            value={id()}
            onInput={setId}
            placeholder="e.g. deepseek, ollama"
            pattern="[a-z0-9][a-z0-9._-]{0,63}"
            required
          />
          <Field
            id="cp-name"
            label="Display name (optional)"
            value={name()}
            onInput={setName}
            placeholder="e.g. DeepSeek"
          />
        </div>
        <div class="grid2">
          <div class="stack">
            <label for="cp-api">Wire API</label>
            <select
              id="cp-api"
              value={wire()}
              onChange={(e) => setWire(e.currentTarget.value as CustomProviderInput["api"])}
            >
              <option value="openai-completions">openai-completions</option>
              <option value="anthropic-messages">anthropic-messages</option>
            </select>
          </div>
          <div class="stack">
            <label for="cp-auth">Authentication</label>
            <select
              id="cp-auth"
              value={auth()}
              onChange={(e) => setAuth(e.currentTarget.value as CustomProviderInput["auth"])}
            >
              <option value="api-key">API key (vault)</option>
              <option value="bearer">Bearer token (vault)</option>
              <option value="none">None (local endpoint)</option>
            </select>
          </div>
        </div>
        <Field
          id="cp-base"
          label="Base URL"
          type="url"
          value={baseURL()}
          onInput={setBaseURL}
          placeholder="https://api.deepseek.com/v1"
          required
        />
        <div class="grid2">
          <Field
            id="cp-model"
            label="Default model"
            value={defaultModel()}
            onInput={setDefaultModel}
            placeholder="e.g. deepseek-chat"
            required
          />
          <Field
            id="cp-models"
            label="Extra models (comma-separated)"
            value={extraModels()}
            onInput={setExtraModels}
            placeholder="e.g. deepseek-reasoner"
          />
        </div>
        <Show
          when={isAnthropic()}
          fallback={
            <div class="stack">
              <label for="cp-max-tokens">Max tokens parameter</label>
              <select
                id="cp-max-tokens"
                value={maxTokensField()}
                onChange={(e) => setMaxTokensField(e.currentTarget.value)}
              >
                <option value="max_completion_tokens">max_completion_tokens (default)</option>
                <option value="max_tokens">max_tokens (legacy / DeepSeek / local)</option>
              </select>
              <label class="check">
                <input
                  type="checkbox"
                  checked={usageInStreaming()}
                  onChange={(e) => setUsageInStreaming(e.currentTarget.checked)}
                />
                Request usage in streaming (stream_options)
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  checked={nonNullContent()}
                  onChange={(e) => setNonNullContent(e.currentTarget.checked)}
                />
                Send empty string instead of null for tool-only assistant turns
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  checked={developerRole()}
                  onChange={(e) => setDeveloperRole(e.currentTarget.checked)}
                />
                Send system prompt as developer role
              </label>
            </div>
          }
        >
          <div class="stack">
            <label for="cp-thinking">Thinking mode</label>
            <select id="cp-thinking" value={thinkingMode()} onChange={(e) => setThinkingMode(e.currentTarget.value)}>
              <option value="none">none (compatible default)</option>
              <option value="adaptive">adaptive</option>
            </select>
            <label class="check">
              <input
                type="checkbox"
                checked={eagerToolInput()}
                onChange={(e) => setEagerToolInput(e.currentTarget.checked)}
              />
              Eager tool input streaming (beta)
            </label>
            <label class="check">
              <input type="checkbox" checked={fallbacks()} onChange={(e) => setFallbacks(e.currentTarget.checked)} />
              Enable Anthropic fallbacks
            </label>
          </div>
        </Show>
        <Field
          id="cp-key"
          label="API key (optional — saved encrypted in vault)"
          type="password"
          value={key()}
          onInput={setKey}
          placeholder="leave blank to set later"
          hidden={keyRowHidden()}
        />
        <div class="actions">
          <button type="submit" class="primary" disabled={blocked() !== ""} title={blocked()}>
            Save custom provider
          </button>
        </div>
      </form>
    </details>
  );
}
