import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OpenAIProvider,
  type Provider,
  ProviderRegistry,
  type StreamEvent,
  type TurnRequest,
  type TurnResult,
} from "@albireo/core";
import { PROVIDER_IDS, type ProviderId, type VaultStore } from "./store.js";

/** What a provider is built from. `baseURL` is always set, so the SDK never falls back to the environment. */
export interface ResolvedProviderConfig {
  apiKey: string;
  baseURL: string;
  model?: string;
}

export type ProviderFactory = (config: ResolvedProviderConfig) => Provider;

interface Vendor {
  label: string;
  baseURL: string;
  model: string;
  create: ProviderFactory;
}

const VENDORS: Record<ProviderId, Vendor> = {
  anthropic: {
    label: "Anthropic",
    baseURL: ANTHROPIC_DEFAULT_BASE_URL,
    model: ANTHROPIC_DEFAULT_MODEL,
    create: (c) => new AnthropicProvider(c),
  },
  openai: {
    label: "OpenAI",
    baseURL: OPENAI_DEFAULT_BASE_URL,
    model: OPENAI_DEFAULT_MODEL,
    create: (c) => new OpenAIProvider(c),
  },
};

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
 * (Re-)register the vault-backed factories for every known provider. `register` drops cached
 * instances, so the next `registry.get` sees the current credentials. `factories` overrides how
 * real providers are built (tests).
 */
export function registerVaultProviders(
  registry: ProviderRegistry,
  vault: VaultStore,
  factories: Partial<Record<ProviderId, ProviderFactory>> = {},
): ProviderRegistry {
  const secrets = vault.state === "unlocked" ? vault.read() : null;
  for (const id of PROVIDER_IDS) {
    const vendor = VENDORS[id];
    const entry = secrets?.providers[id];
    if (!entry?.apiKey) {
      const reason = vault.error
        ? `The Albireo vault could not be opened, so the ${vendor.label} API key is unavailable: ${vault.error}`
        : vault.state === "locked"
          ? `The Albireo vault is locked, so the ${vendor.label} API key is unavailable. Unlock it under "API Keys" in the panel.`
          : `The ${vendor.label} API key is not configured in the Albireo vault. Add it under "API Keys" in the panel, or with \`albireo keys set ${id}\` and restart.`;
      const model = entry?.model ?? vendor.model;
      registry.register(id, () => new UnconfiguredProvider(id, model, reason));
      continue;
    }
    const config: ResolvedProviderConfig = {
      apiKey: entry.apiKey,
      baseURL: entry.baseURL ?? vendor.baseURL,
      ...(entry.model ? { model: entry.model } : {}),
    };
    const create = factories[id] ?? vendor.create;
    registry.register(id, () => redacting(create(config), config.apiKey));
  }
  return registry;
}

export function createVaultRegistry(
  vault: VaultStore,
  factories?: Partial<Record<ProviderId, ProviderFactory>>,
): ProviderRegistry {
  return registerVaultProviders(new ProviderRegistry(), vault, factories);
}

/** Whether the vault holds a usable key for `id` right now. */
export function hasProviderKey(vault: VaultStore, id: string): boolean {
  if (vault.state !== "unlocked") return false;
  const entry = vault.read().providers[id as ProviderId];
  return Boolean(entry?.apiKey);
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
