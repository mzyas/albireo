import type { ProviderRegistry, Session } from "@albireo/core";
import type { Protection } from "./crypto.js";
import { VaultError } from "./errors.js";
import { maskApiKey, type ProviderFactory, registerVaultProviders } from "./registry.js";
import { isProviderId, PROVIDER_IDS, type ProviderId, type VaultState, type VaultStore } from "./store.js";

/** What clients may see about one provider. Never the key itself. */
export interface ProviderSecretView {
  hasKey: boolean;
  keyHint: string | null;
  baseURL?: string;
  model?: string;
}

export interface SecretsStatus {
  enabled: true;
  state: VaultState;
  protection: Protection | "unknown";
  /** OS store holding the master key (os-keychain mode), e.g. "Windows DPAPI". */
  keychain: string | null;
  /** Problem that keeps the vault from opening, if any. */
  error?: string;
  /** True while a change waits for the running turn to finish before the session picks it up. */
  refreshPending: boolean;
  providers: Record<ProviderId, ProviderSecretView>;
}

export interface ProviderUpdate {
  provider: ProviderId;
  apiKey?: string;
  clearApiKey?: boolean;
  baseURL?: string;
  model?: string;
}

export interface SecretManagerOptions {
  vault: VaultStore;
  registry: ProviderRegistry;
  /** Refreshed after every change, immediately when idle, otherwise once the running turn ends. */
  session?: Session;
  factories?: Partial<Record<ProviderId, ProviderFactory>>;
}

/**
 * Ties the vault to a live registry and session: every change re-registers the providers and
 * refreshes the session. All inputs are validated here, since they arrive as JSON from the panel.
 */
export class SecretManager {
  readonly vault: VaultStore;
  private readonly registry: ProviderRegistry;
  private readonly factories: Partial<Record<ProviderId, ProviderFactory>>;
  private session?: Session;
  private offSession?: () => void;
  private pendingRefresh = false;
  private listeners = new Set<() => void>();

  constructor(opts: SecretManagerOptions) {
    this.vault = opts.vault;
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
    const providers = {} as Record<ProviderId, ProviderSecretView>;
    for (const id of PROVIDER_IDS) {
      const entry = secrets?.providers[id];
      providers[id] = {
        hasKey: Boolean(entry?.apiKey),
        keyHint: maskApiKey(entry?.apiKey),
        ...(entry?.baseURL ? { baseURL: entry.baseURL } : {}),
        ...(entry?.model ? { model: entry.model } : {}),
      };
    }
    return {
      enabled: true,
      state: vault.state,
      protection: vault.protection,
      keychain: vault.keychainLabel,
      ...(vault.error ? { error: vault.error } : {}),
      refreshPending: this.pendingRefresh,
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

  /** Save one provider's settings. An uninitialized vault is created in os-keychain mode first. */
  async setProvider(input: ProviderUpdate | Record<string, unknown>): Promise<SecretsStatus> {
    const body: Record<string, unknown> = typeof input === "object" && input !== null ? { ...input } : {};
    if (!isProviderId(body.provider)) {
      throw new VaultError("invalid", `provider must be one of: ${PROVIDER_IDS.join(", ")}.`);
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

  /** Forget the key in memory. Only for passphrase mode: an os-keychain vault would just reopen itself. */
  async lock(): Promise<SecretsStatus> {
    if (this.vault.protection !== "passphrase") {
      throw new VaultError("invalid", "Only a passphrase-protected vault can be locked.");
    }
    this.vault.lock();
    this.changed();
    return this.status();
  }

  private changed(): void {
    registerVaultProviders(this.registry, this.vault, this.factories);
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
