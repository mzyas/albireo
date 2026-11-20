import type { ProviderAuthMode, ProviderHeaders, ProviderRegistry, Session, WireApi } from "@albireo/core";
import { assertSafeBaseURLQuery, maskBaseURL } from "./credentials.js";
import type { Protection } from "./crypto.js";
import { VaultError } from "./errors.js";
import {
  defaultProviderDefinitions,
  type ProviderCompat,
  type ProviderConfigEntry,
  type ProviderConfigStore,
  type ProviderModelConfig,
  type ResolvedProviderDefinition,
  validateProviderEntry,
} from "./providers.js";
import { maskApiKey, type ProviderFactory, registerVaultProviders } from "./registry.js";
import { isBuiltinProviderId, isValidProviderId, type ProviderId, type VaultState, type VaultStore } from "./store.js";

/** What clients may see about one provider. Never the key itself. */
export interface ProviderSecretView {
  id: ProviderId;
  name: string;
  api: WireApi;
  auth: ProviderAuthMode;
  builtin: boolean;
  /** True when the provider is ready to make requests (always true for `auth: "none"`). */
  configured: boolean;
  hasKey: boolean;
  keyHint: string | null;
  defaultBaseURL: string;
  defaultModel: string;
  /** Vault-level baseURL override, if set. Query values other than version selectors are masked. */
  baseURL?: string;
  /** Vault-level model override, if set. */
  model?: string;
  models: ProviderModelConfig[];
  headers?: ProviderHeaders;
  compat: ProviderCompat;
}

export interface SecretsStatus {
  enabled: true;
  state: VaultState;
  protection: Protection | "unknown";
  /** OS store holding the master key (os-keychain mode), e.g. "Windows DPAPI". */
  keychain: string | null;
  /** Problem that keeps the vault from opening, if any. */
  error?: string;
  /** Problem reading `providers.json`, if any (built-ins remain available). */
  configError?: string;
  /** True while a change waits for the running turn to finish before the session picks it up. */
  refreshPending: boolean;
  /** Ordered list of provider IDs: built-ins first, then custom providers. */
  providerOrder: ProviderId[];
  providers: Record<ProviderId, ProviderSecretView>;
}

export interface ProviderUpdate {
  provider: ProviderId;
  apiKey?: string;
  clearApiKey?: boolean;
  baseURL?: string;
  model?: string;
}

export interface ProviderConfigUpsert extends ProviderConfigEntry {
  id: ProviderId;
  /** Optional key, saved to the vault before the entry is written; never stored in `providers.json`. */
  apiKey?: string;
}

export interface SecretManagerOptions {
  vault: VaultStore;
  registry: ProviderRegistry;
  /** Non-secret endpoint definitions (`providers.json`). Optional; defaults to built-in providers only. */
  config?: ProviderConfigStore;
  /** Refreshed after every change, immediately when idle, otherwise once the running turn ends. */
  session?: Session;
  factories?: Partial<Record<ProviderId, ProviderFactory>>;
}

/**
 * Ties the vault and provider config store to a live registry and session: every change
 * re-registers the providers and refreshes the session. All inputs are validated here, since they
 * arrive as JSON from the panel.
 */
export class SecretManager {
  readonly vault: VaultStore;
  readonly config?: ProviderConfigStore;
  private readonly registry: ProviderRegistry;
  private readonly factories: Partial<Record<ProviderId, ProviderFactory>>;
  private session?: Session;
  private offSession?: () => void;
  private pendingRefresh = false;
  private listeners = new Set<() => void>();
  /** Serializes config changes with their vault side effects. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: SecretManagerOptions) {
    this.vault = opts.vault;
    this.config = opts.config;
    this.registry = opts.registry;
    this.factories = opts.factories ?? {};
    // The active provider stays defined even if providers.json drops it, so the session can refresh.
    this.config?.retain(() => this.session?.providerId);
    if (opts.session) this.attach(opts.session);
  }

  attach(session: Session): void {
    this.offSession?.();
    this.session = session;
    this.offSession = session.on((e) => {
      if (e.type === "status" && e.state === "idle" && this.pendingRefresh) {
        this.refreshSession();
        this.notify();
      }
      // A provider kept only because it was active can go once the session has moved on.
      if (e.type === "provider_changed" && this.config?.retained) {
        this.reloadProviderConfig().catch(() => {});
      }
    });
  }

  dispose(): void {
    this.offSession?.();
    this.listeners.clear();
  }

  /** Called after every change (e.g. to tell connected panels to re-fetch). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  status(): SecretsStatus {
    const vault = this.vault;
    const secrets = vault.state === "unlocked" ? vault.read() : null;
    const retained = this.config?.retained;
    const configError = [
      retained
        ? `Active provider "${retained}" is no longer in providers.json; it stays available until you switch to another provider.`
        : undefined,
      this.config?.error,
    ]
      .filter(Boolean)
      .join(" ");
    const definitions = this.definitions();
    const providerOrder: ProviderId[] = [];
    const providers: Record<ProviderId, ProviderSecretView> = {};
    for (const def of definitions) {
      providerOrder.push(def.id);
      const entry = secrets?.providers[def.id];
      const hasKey = Boolean(entry?.apiKey);
      providers[def.id] = {
        id: def.id,
        name: def.name,
        api: def.api,
        auth: def.auth,
        builtin: def.builtin,
        configured: def.auth === "none" || hasKey,
        hasKey,
        keyHint: maskApiKey(entry?.apiKey),
        defaultBaseURL: def.baseURL,
        defaultModel: def.defaultModel,
        ...(entry?.baseURL ? { baseURL: maskBaseURL(entry.baseURL) } : {}),
        ...(entry?.model ? { model: entry.model } : {}),
        models: def.models.map((m) => ({
          ...structuredClone(m),
          ...(m.headers ? { headers: maskHeaders(m.headers) } : {}),
        })),
        ...(def.headers ? { headers: maskHeaders(def.headers) } : {}),
        compat: { ...def.compat },
      };
    }
    return {
      enabled: true,
      state: vault.state,
      protection: vault.protection,
      keychain: vault.keychainLabel,
      ...(vault.error ? { error: vault.error } : {}),
      ...(configError ? { configError } : {}),
      refreshPending: this.pendingRefresh,
      providerOrder,
      providers,
    };
  }

  /** Create a passphrase-protected vault, or unlock an existing one. */
  async unlock(input: { passphrase?: unknown }): Promise<SecretsStatus> {
    const passphrase = input?.passphrase;
    if (typeof passphrase !== "string" || !passphrase) throw new VaultError("invalid", "passphrase is required.");
    if (this.vault.state === "uninitialized") await this.vault.initialize(passphrase);
    else await this.vault.unlock(passphrase);
    this.changed();
    return this.status();
  }

  /**
   * Pick up external edits to `providers.json`. If the file dropped the active provider, it stays
   * defined until the session switches away. Notifies only when something visible changed, so
   * `GET /secrets` can call it every time.
   */
  async reloadProviderConfig(): Promise<SecretsStatus> {
    const config = this.config;
    if (!config) return this.status();
    await this.exclusive(async () => {
      if (await config.reload()) this.changed();
    });
    return this.status();
  }

  /** Save one provider's credentials/overrides. An uninitialized vault is created in os-keychain mode first. */
  async setProvider(input: ProviderUpdate | Record<string, unknown>): Promise<SecretsStatus> {
    const body: Record<string, unknown> = typeof input === "object" && input !== null ? { ...input } : {};
    const ids = this.definitions().map((d) => d.id);
    if (typeof body.provider !== "string" || !ids.includes(body.provider)) {
      throw new VaultError("invalid", `provider must be one of: ${ids.join(", ")}.`);
    }
    for (const field of ["apiKey", "baseURL", "model"]) {
      if (body[field] !== undefined && typeof body[field] !== "string") {
        throw new VaultError("invalid", `${field} must be a string.`);
      }
    }
    if (typeof body.baseURL === "string" && body.baseURL.trim()) {
      const api = this.definitions().find((d) => d.id === body.provider)?.api;
      const url = URL.canParse(body.baseURL.trim()) ? new URL(body.baseURL.trim()) : undefined;
      // The vault checks the rest; only the wire API decides whether a query string works at all.
      if (url) assertSafeBaseURLQuery(url, "The base URL", api);
    }
    if (this.vault.state === "uninitialized") await this.vault.initialize();
    await this.vault.updateProvider(body.provider, {
      apiKey: body.apiKey as string | undefined,
      clearApiKey: body.clearApiKey as boolean | undefined,
      baseURL: body.baseURL as string | undefined,
      model: body.model as string | undefined,
    });
    this.changed();
    return this.status();
  }

  /**
   * Add or update a provider endpoint definition in `providers.json`, with an optional initial
   * `apiKey` that goes to the vault, never into the file. The key is saved first, so a key that
   * can't be saved leaves no entry behind. A new custom provider never inherits a key or override
   * that an earlier provider with the same ID left in the vault. Changes to the active provider
   * apply like any other change: right away when idle, otherwise once the running turn ends.
   */
  async upsertProviderConfig(input: ProviderConfigUpsert | Record<string, unknown>): Promise<SecretsStatus> {
    const config = this.requireConfig();
    const body: Record<string, unknown> = typeof input === "object" && input !== null ? { ...input } : {};
    const { id, apiKey, ...entry } = body;
    if (!isValidProviderId(id)) {
      throw new VaultError(
        "invalid",
        `Invalid provider id: ${String(id)}. Use lowercase letters, digits, '.', '_' or '-'.`,
      );
    }
    if (apiKey !== undefined && typeof apiKey !== "string") throw new VaultError("invalid", "apiKey must be a string.");
    const key = apiKey?.trim() ?? "";
    // Fail on a bad entry before touching the vault.
    validateProviderEntry(id, entry);
    await this.exclusive(async () => {
      try {
        // Pick up other processes' edits, so "new" below also means "not on disk".
        await config.reload();
        const fresh = !isBuiltinProviderId(id) && !config.has(id);
        if (fresh && this.vault.state === "locked") {
          throw new VaultError(
            "locked",
            `Unlock the vault before adding "${id}", so anything stored under that ID before can be cleared.`,
          );
        }
        if (fresh && this.vault.state === "unlocked") await this.vault.deleteProvider(id);
        if (key) {
          if (this.vault.state === "uninitialized") await this.vault.initialize();
          await this.vault.updateProvider(id, { apiKey: key });
        }
        try {
          await config.upsert(id, entry as ProviderConfigEntry);
        } catch (err) {
          // Don't leave the new key behind for a provider that was never written.
          if (fresh && key) await this.vault.deleteProvider(id).catch(() => {});
          throw err;
        }
      } finally {
        this.changed();
      }
    });
    return this.status();
  }

  /**
   * Remove a custom provider from `providers.json` together with its vault entry. Refused while
   * the vault is locked, since the stored key could not be erased. The entry goes first: if the
   * file can't be written, nothing is lost. A key that outlives it (the vault write failed) is
   * cleared when a provider is added under the same ID again.
   */
  async deleteCustomProvider(id: unknown): Promise<SecretsStatus> {
    const config = this.requireConfig();
    if (!isValidProviderId(id)) {
      throw new VaultError("invalid", `Invalid provider id: ${String(id)}.`);
    }
    if (isBuiltinProviderId(id)) {
      throw new VaultError("invalid", `Built-in provider "${id}" cannot be deleted.`);
    }
    await this.exclusive(async () => {
      if (!config.has(id)) {
        throw new VaultError("invalid", `Unknown provider "${id}".`);
      }
      if (this.session?.providerId === id) {
        throw new VaultError("invalid", `Cannot delete active provider "${id}". Switch to another provider first.`);
      }
      if (this.vault.state === "locked") {
        throw new VaultError("locked", `Unlock the vault before deleting "${id}", so its stored key is deleted too.`);
      }
      try {
        await config.remove(id);
        if (this.vault.state === "unlocked") await this.vault.deleteProvider(id);
      } finally {
        this.changed();
      }
    });
    return this.status();
  }

  /** Forget the key in memory. Only for passphrase mode: an os-keychain vault would just reopen itself. */
  async lock(): Promise<SecretsStatus> {
    if (this.vault.protection !== "passphrase") {
      throw new VaultError("invalid", "Only a passphrase-protected vault can be locked.");
    }
    this.vault.lock();
    this.changed();
    return this.status();
  }

  private requireConfig(): ProviderConfigStore {
    if (!this.config) throw new VaultError("unavailable", "Provider configuration store is not enabled.");
    return this.config;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private definitions(): ResolvedProviderDefinition[] {
    return this.config ? this.config.list() : defaultProviderDefinitions();
  }

  private changed(): void {
    registerVaultProviders(this.registry, this.vault, this.factories, this.config);
    this.refreshSession();
    this.notify();
  }

  private refreshSession(): void {
    const session = this.session;
    if (!session) return;
    if (session.status === "running") {
      this.pendingRefresh = true;
      return;
    }
    this.pendingRefresh = false;
    session.refreshProvider();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * Header names are useful to the panel; values never leave the config store, even if a
 * hand-edited file smuggled something past validation. `null` (suppress an SDK default) stays
 * `null`, so it isn't mistaken for a configured credential.
 */
function maskHeaders(headers: ProviderHeaders): ProviderHeaders {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, value === null ? null : "••••"]));
}
