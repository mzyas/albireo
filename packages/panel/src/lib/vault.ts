import type { ProviderSecretView, SecretsStatus } from "../protocol.ts";

export function describeVault(s: SecretsStatus): string {
  if (s.error) return s.error;
  const holder = s.keychain ?? "your OS credential store";
  if (s.state === "uninitialized") {
    return s.protection === "os-keychain"
      ? `No keys saved yet. They will be encrypted with a key held by ${holder}.`
      : "No keys saved yet. No OS credential store is available here, so choose a passphrase (at least 8 characters) to protect them.";
  }
  if (s.state === "locked") return "The vault is locked. Enter its passphrase to use the saved keys.";
  return s.protection === "passphrase"
    ? "Keys are encrypted with your passphrase."
    : `Keys are encrypted with a key held by ${holder}.`;
}

/** True when keys can be saved right now (the vault is open, or will open on first save). */
export function formsUsable(s: SecretsStatus): boolean {
  return s.state === "unlocked" || (s.state === "uninitialized" && s.protection === "os-keychain");
}

/** Why a custom provider can't be added right now, or "" if it can. The server refuses these too. */
export function addProviderBlock(s: SecretsStatus): string {
  if (s.needsUnlock) return "Unlock the vault before adding a provider";
  if (s.error) return "Fix the vault before adding a provider: it can't be opened";
  return "";
}

/** Whether the active provider needs the user to do something, and a one-line reason. */
export function attention(s: SecretsStatus, currentProvider: string): { needed: boolean; reason: string } {
  const current = s.providers[currentProvider];
  const needsVault = current?.auth !== "none";
  const needed =
    Boolean(s.error || s.configError || current?.problem) ||
    (needsVault && (s.state !== "unlocked" || !current?.configured));
  if (!needed) return { needed, reason: "" };
  const reason =
    s.configError ??
    current?.problem ??
    (s.state === "unlocked" ? `No ${currentProvider} key saved` : describeVault(s));
  return { needed, reason };
}

export function providerLabel(id: string, view: ProviderSecretView | undefined): string {
  return view && view.name.toLowerCase() !== id ? `${id} (${view.name})` : id;
}

export function providerBadge(view: ProviderSecretView): { text: string; ok: boolean } {
  // Something other than the key keeps it from working, e.g. a base URL that fails the checks.
  if (view.problem) return { text: "unusable", ok: false };
  if (view.auth === "none") return { text: "no key needed", ok: true };
  return { text: view.hasKey ? "encrypted" : "not configured", ok: view.hasKey };
}

/** Model IDs worth suggesting for a provider: its override, its default, then its listed models. */
export function modelSuggestions(view: ProviderSecretView | undefined): string[] {
  if (!view) return [];
  const ids = new Set<string>();
  if (view.model) ids.add(view.model);
  if (view.defaultModel) ids.add(view.defaultModel);
  for (const m of view.models ?? []) ids.add(m.id);
  return [...ids];
}

export interface CustomProviderInput {
  id: string;
  name: string;
  api: "openai-completions" | "anthropic-messages";
  auth: "api-key" | "bearer" | "none";
  baseURL: string;
  defaultModel: string;
  extraModels: string;
  openai: { maxTokensField: string; usageInStreaming: boolean; nonNullContent: boolean; developerRole: boolean };
  anthropic: { thinkingMode: string; eagerToolInput: boolean; fallbacks: boolean };
}

/** Body of `POST /providers`. The key is not part of it: it goes to `/secrets/provider` afterwards. */
export function buildCustomProviderPayload(f: CustomProviderInput): Record<string, unknown> {
  const id = f.id.trim();
  const name = f.name.trim();
  const defaultModel = f.defaultModel.trim();
  const extra = f.extraModels
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const modelIds = [...new Set([defaultModel, ...extra].filter(Boolean))];
  const compat =
    f.api === "anthropic-messages"
      ? {
          thinkingMode: f.anthropic.thinkingMode,
          supportsEagerToolInputStreaming: f.anthropic.eagerToolInput,
          supportsFallbacks: f.anthropic.fallbacks,
        }
      : {
          maxTokensField: f.openai.maxTokensField,
          supportsUsageInStreaming: f.openai.usageInStreaming,
          requiresNonNullAssistantContent: f.openai.nonNullContent,
          supportsDeveloperRole: f.openai.developerRole,
        };
  return {
    id,
    ...(name ? { name } : {}),
    api: f.api,
    auth: f.auth,
    baseURL: f.baseURL.trim(),
    defaultModel,
    ...(modelIds.length > 0 ? { models: modelIds.map((m) => ({ id: m })) } : {}),
    compat,
  };
}
