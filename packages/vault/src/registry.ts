import {
  ANTHROPIC_MESSAGES_API,
  type AnthropicCompat,
  type AnthropicModelOverride,
  AnthropicProvider,
  type OpenAICompletionsCompat,
  type OpenAIModelOverride,
  OpenAIProvider,
  type Provider,
  type ProviderAuthMode,
  type ProviderHeaders,
  ProviderRegistry,
  type StreamEvent,
  type TurnRequest,
  type TurnResult,
  type WireApi,
} from "@albireo/core";
import { baseURLProblem } from "./credentials.js";
import {
  defaultProviderDefinitions,
  type ProviderCompat,
  type ProviderConfigStore,
  type ProviderModelConfig,
  type ResolvedProviderDefinition,
} from "./providers.js";
import type { ProviderId, ProviderSecret, VaultStore } from "./store.js";

/** What a provider is built from. `baseURL` is always set, so the SDK never falls back to the environment. */
export interface ResolvedProviderConfig {
  id: ProviderId;
  api: WireApi;
  auth: ProviderAuthMode;
  apiKey?: string;
  baseURL: string;
  model?: string;
  headers?: ProviderHeaders;
  compat: ProviderCompat;
  models: ProviderModelConfig[];
}

export type ProviderFactory = (config: ResolvedProviderConfig) => Provider;

/**
 * Stand-in for a provider without credentials. It never builds an SDK client (which would quietly
 * read API keys from the environment); a turn fails with a message that says how to fix it.
 */
export class UnconfiguredProvider implements Provider {
  constructor(
    readonly id: string,
    readonly defaultModel: string,
    readonly reason: string,
  ) {}

  async runTurn(): Promise<TurnResult> {
    throw new Error(this.reason);
  }
}

/**
 * (Re-)register the vault-backed factories for every known provider (built-ins plus custom
 * providers from `config`). `register` drops cached instances, and removed custom providers are
 * unregistered, so the next `registry.get` sees the current definitions and credentials.
 * `factories` overrides how real providers are built (tests).
 */
export function registerVaultProviders(
  registry: ProviderRegistry,
  vault: VaultStore,
  factories: Partial<Record<ProviderId, ProviderFactory>> = {},
  config?: ProviderConfigStore,
): ProviderRegistry {
  const definitions = config ? config.list() : defaultProviderDefinitions();
  const activeIds = new Set(definitions.map((d) => d.id));
  for (const existingId of registry.ids()) {
    if (!activeIds.has(existingId)) registry.unregister(existingId);
  }

  const secrets = vault.state === "unlocked" ? vault.read() : null;
  for (const def of definitions) {
    const entry = secrets?.providers[def.id];
    const model = entry?.model ?? def.defaultModel;

    const problem = problemWith(vault, def, entry);
    if (problem) {
      registry.register(def.id, () => new UnconfiguredProvider(def.id, model, problem.message));
      continue;
    }

    const resolved: ResolvedProviderConfig = {
      id: def.id,
      api: def.api,
      auth: def.auth,
      ...(def.auth !== "none" && entry?.apiKey ? { apiKey: entry.apiKey } : {}),
      baseURL: entry?.baseURL ?? def.baseURL,
      model,
      ...(def.headers ? { headers: { ...def.headers } } : {}),
      compat: { ...def.compat },
      models: structuredClone(def.models),
    };
    const create = factories[def.id] ?? createProviderFromConfig;
    const secret = resolved.apiKey;
    registry.register(def.id, () => {
      const inner = create(resolved);
      return secret ? redacting(inner, secret) : inner;
    });
  }
  return registry;
}

export function createVaultRegistry(
  vault: VaultStore,
  factories?: Partial<Record<ProviderId, ProviderFactory>>,
  config?: ProviderConfigStore,
): ProviderRegistry {
  return registerVaultProviders(new ProviderRegistry(), vault, factories, config);
}

/** Whether the vault holds a usable key for `id` right now. */
export function hasProviderKey(vault: VaultStore, id: string): boolean {
  if (vault.state !== "unlocked") return false;
  const entry = vault.read().providers[id];
  return Boolean(entry?.apiKey);
}

/** Why a provider can't run turns right now. */
export interface ProviderProblem {
  /** `base-url`: the base URL it would be built with fails the checks. `key`: no usable key. */
  cause: "base-url" | "key";
  /** Safe to show; says how to fix it. */
  message: string;
}

/**
 * Why provider `def` can't run turns right now, or undefined when it can (`auth: "none"` needs no
 * key). The registry, the status view and the CLI all go by this, so a provider never looks ready
 * and then fails its turn.
 */
export function providerProblem(vault: VaultStore, def: ResolvedProviderDefinition): ProviderProblem | undefined {
  return problemWith(vault, def, vault.state === "unlocked" ? vault.read().providers[def.id] : undefined);
}

function problemWith(
  vault: VaultStore,
  def: ResolvedProviderDefinition,
  entry: ProviderSecret | undefined,
): ProviderProblem | undefined {
  // Checked on the URL it would really use: an override saved under older rules, or one that
  // predates a change of wire API, must not slip through.
  const urlProblem = baseURLProblem(entry?.baseURL ?? def.baseURL, def.api);
  if (urlProblem) {
    return {
      cause: "base-url",
      message: `${def.name} cannot be used: ${urlProblem} Change or clear the base URL under "API Keys" in the panel, or with \`albireo keys set ${def.id} --keep-key --base-url ""\`.`,
    };
  }
  if (def.auth === "none" || entry?.apiKey) return undefined;
  const message = vault.error
    ? `The Albireo vault could not be opened, so the ${def.name} API key is unavailable: ${vault.error}`
    : vault.state === "locked"
      ? `The Albireo vault is locked, so the ${def.name} API key is unavailable. Unlock it under "API Keys" in the panel.`
      : `The ${def.name} API key is not configured in the Albireo vault. Add it under "API Keys" in the panel, or with \`albireo keys set ${def.id}\`.`;
  return { cause: "key", message };
}

/** Mask for display: first 3 and last 4 characters of keys long enough that this reveals little. */
export function maskApiKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length < 16) return "••••";
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}

/** Errors become `error` events that reach the panel and logs; make sure the key isn't in them. */
export function redactError(err: unknown, secret: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (secret.length < 8 || !message.includes(secret)) return err;
  const safe = new Error(message.split(secret).join(maskApiKey(secret) ?? "••••"));
  if (err instanceof Error) safe.name = err.name;
  return safe;
}

function createProviderFromConfig(config: ResolvedProviderConfig): Provider {
  if (config.api === ANTHROPIC_MESSAGES_API) {
    const modelOverrides = toAnthropicOverrides(config.models);
    return new AnthropicProvider({
      id: config.id,
      baseURL: config.baseURL,
      model: config.model,
      auth: config.auth,
      ...(config.auth === "bearer"
        ? { authToken: config.apiKey }
        : config.auth === "api-key"
          ? { apiKey: config.apiKey }
          : {}),
      headers: config.headers,
      compat: config.compat as AnthropicCompat,
      modelOverrides,
    });
  }
  const modelOverrides = toOpenAIOverrides(config.models);
  return new OpenAIProvider({
    id: config.id,
    baseURL: config.baseURL,
    model: config.model,
    auth: config.auth,
    ...(config.auth !== "none" ? { apiKey: config.apiKey } : {}),
    headers: config.headers,
    compat: config.compat as OpenAICompletionsCompat,
    modelOverrides,
  });
}

function toAnthropicOverrides(models: ProviderModelConfig[]): Record<string, AnthropicModelOverride> | undefined {
  const out: Record<string, AnthropicModelOverride> = {};
  for (const m of models) {
    if (m.maxTokens === undefined && !m.headers && !m.compat) continue;
    out[m.id] = {
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
      ...(m.headers ? { headers: { ...m.headers } } : {}),
      ...(m.compat ? { compat: m.compat as AnthropicCompat } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toOpenAIOverrides(models: ProviderModelConfig[]): Record<string, OpenAIModelOverride> | undefined {
  const out: Record<string, OpenAIModelOverride> = {};
  for (const m of models) {
    if (m.maxTokens === undefined && !m.headers && !m.compat) continue;
    out[m.id] = {
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
      ...(m.headers ? { headers: { ...m.headers } } : {}),
      ...(m.compat ? { compat: m.compat as OpenAICompletionsCompat } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function redacting(inner: Provider, secret: string): Provider {
  return {
    id: inner.id,
    defaultModel: inner.defaultModel,
    async runTurn(req: TurnRequest, onEvent: (e: StreamEvent) => void): Promise<TurnResult> {
      try {
        return await inner.runTurn(req, onEvent);
      } catch (err) {
        throw redactError(err, secret);
      }
    },
  };
}
