import type { ProviderAuthMode, ProviderHeaders, ProviderRegistry, Session, WireApi } from "@albireo/core";
import type { Protection } from "./crypto.js";
import { VaultError } from "./errors.js";
import {
  defaultProviderDefinitions,
  type ProviderCompat,
  type ProviderConfigEntry,
  type ProviderConfigGuard,
  type ProviderConfigStore,
  type ProviderModelConfig,
  type ResolvedProviderDefinition,
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
  /** Vault-level baseURL override, if set. */
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
}

export interface ProviderConfigUpsertStatus extends SecretsStatus {
  /** False when an existing entry was replaced, so a client knows whether undoing means deleting. */
  created: boolean;
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
  /** Why the last reload of `providers.json` was held back, if it was. */
  private heldReload: string | undefined;
  private listeners = new Set<() => void>();

  constructor(opts: SecretManagerOptions) {
    this.vault = opts.vault;
    this.config = opts.config;
    this.registry = opts.registry;
    this.factories = opts.factories ?? {};
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
      // A reload held back for the previous provider may apply now.
      if (e.type === "provider_changed" && this.heldReload) {
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
    const configError = [this.heldReload, this.config?.error].filter(Boolean).join(" ");
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
        ...(entry?.baseURL ? { baseURL: entry.baseURL } : {}),
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
   * Pick up external edits to `providers.json`. Reading, the active-provider check and the commit
   * run as one step in the config store's queue. A file that drops the active provider is held
   * back (it stays on disk) and applied by the first reload after the session switches away.
   * Notifies only when something visible changed, so `GET /secrets` can call it every time.
   */
  async reloadProviderConfig(): Promise<SecretsStatus> {
    if (!this.config) return this.status();
    const { changed, held } = await this.config.reload(this.keepActive);
    const heldChanged = held !== this.heldReload;
    this.heldReload = held;
    if (changed) this.changed();
    else if (heldChanged) this.notify();
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
   * Add or update a provider endpoint definition in `providers.json`. Never accepts `apiKey`.
   * Changes to the active provider apply like any other change: right away when idle, otherwise
   * once the running turn ends.
   */
  async upsertProviderConfig(
    input: ProviderConfigUpsert | Record<string, unknown>,
  ): Promise<ProviderConfigUpsertStatus> {
    if (!this.config) {
      throw new VaultError("unavailable", "Provider configuration store is not enabled.");
    }
    const body: Record<string, unknown> = typeof input === "object" && input !== null ? { ...input } : {};
    const { id, ...entry } = body;
    if (!isValidProviderId(id)) {
      throw new VaultError(
        "invalid",
        `Invalid provider id: ${String(id)}. Use lowercase letters, digits, '.', '_' or '-'.`,
      );
    }
    const { created } = await this.config.upsert(id, entry as ProviderConfigEntry, this.keepActive);
    // The write started from the file on disk and passed the guard, so nothing is held back now.
    this.heldReload = undefined;
    this.changed();
    return { ...this.status(), created };
  }

  /**
   * Remove a custom provider from `providers.json` together with its vault entry. Refused while
   * the vault is locked: the stored key could not be erased, and a provider re-added later under
   * the same ID would inherit it.
   */
  async deleteCustomProvider(id: unknown): Promise<SecretsStatus> {
    if (!this.config) {
      throw new VaultError("unavailable", "Provider configuration store is not enabled.");
    }
    if (!isValidProviderId(id)) {
      throw new VaultError("invalid", `Invalid provider id: ${String(id)}.`);
    }
    if (isBuiltinProviderId(id)) {
      throw new VaultError("invalid", `Built-in provider "${id}" cannot be deleted.`);
    }
    if (!this.config.has(id)) {
      throw new VaultError("invalid", `Unknown provider "${id}".`);
    }
    if (this.session?.providerId === id) {
      throw new VaultError("invalid", `Cannot delete active provider "${id}". Switch to another provider first.`);
    }
    if (this.vault.state === "locked") {
      throw new VaultError(
        "locked",
        `Unlock the vault before deleting "${id}", so its stored key is deleted too. With an unreadable vault, remove the entry from providers.json by hand.`,
      );
    }
    // Key first: if removing the config entry then fails, the provider is left without a key
    // rather than a key outliving its provider.
    if (this.vault.state === "unlocked") await this.vault.deleteProvider(id);
    await this.config.remove(id, this.keepActive);
    this.heldReload = undefined;
    this.changed();
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

  /**
   * Config guard: never commit entries that drop the active custom provider, or the registry
   * would unregister it and the session could no longer refresh. Evaluated inside the config
   * store's queue, against what is about to be committed.
   */
  private readonly keepActive: ProviderConfigGuard = (next) => {
    const active = this.session?.providerId;
    if (!active || isBuiltinProviderId(active) || Object.hasOwn(next, active)) return undefined;
    return `Active provider "${active}" was removed from providers.json; switch to another provider first.`;
  };

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
