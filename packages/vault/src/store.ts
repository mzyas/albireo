import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeBaseURLQuery } from "./credentials.js";
import {
  deriveFromMasterKey,
  deriveFromPassphrase,
  type KdfParams,
  newKdf,
  type Protection,
  parseEnvelope,
  seal,
  unseal,
  type VaultEnvelope,
} from "./crypto.js";
import { VaultError } from "./errors.js";
import { defaultVaultDir, writeFileAtomic } from "./fs.js";
import { defaultProtector, type KeyProtector } from "./protector.js";

export const BUILTIN_PROVIDER_IDS = ["anthropic", "openai"] as const;
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];
/** @deprecated Alias for BUILTIN_PROVIDER_IDS; custom providers can use any valid ProviderId. */
export const PROVIDER_IDS = BUILTIN_PROVIDER_IDS;
export type ProviderId = string;

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isBuiltinProviderId(v: unknown): v is BuiltinProviderId {
  return typeof v === "string" && (BUILTIN_PROVIDER_IDS as readonly string[]).includes(v);
}

export function isValidProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && PROVIDER_ID_PATTERN.test(v);
}

export function isProviderId(v: unknown): v is BuiltinProviderId {
  return isBuiltinProviderId(v);
}

export interface ProviderSecret {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/** Decrypted payload. Lives only in memory. */
export interface VaultSecrets {
  providers: Record<string, ProviderSecret>;
  updatedAt: number;
}

export type VaultState = "uninitialized" | "locked" | "unlocked";

export interface ProviderPatch {
  /** A new key. Omitted or empty leaves the stored key unchanged. */
  apiKey?: string;
  clearApiKey?: boolean;
  /** Omitted leaves it unchanged; "" removes it. */
  baseURL?: string;
  /** Omitted leaves it unchanged; "" removes it. */
  model?: string;
}

export interface VaultStoreOptions {
  /** Directory for `vault.enc.json` (and `master.dpapi` on Windows). Defaults to the per-user config dir. */
  dir?: string;
  /** Holder of the master key for os-keychain mode. Defaults to the platform's store; null disables it. */
  protector?: KeyProtector | null;
}

export const VAULT_FILE = "vault.enc.json";
export const MIN_PASSPHRASE = 8;
const MASTER_KEY_LEN = 32;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Encrypted credential store. State machine:
 * uninitialized --initialize--> unlocked <--lock/unlock--> locked.
 * Writes are serialized, so concurrent updates can't lose each other's changes.
 */
export class VaultStore {
  readonly dir: string;
  readonly file: string;
  private readonly protector: KeyProtector | null;
  private keychainAvailable = false;
  /** Header of the vault on disk; null while uninitialized. */
  private kdf: KdfParams | null = null;
  private key: Buffer | null = null;
  private secrets: VaultSecrets | null = null;
  private broken = false;
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(opts: VaultStoreOptions) {
    this.dir = opts.dir ?? defaultVaultDir();
    this.file = path.join(this.dir, VAULT_FILE);
    this.protector = opts.protector === undefined ? defaultProtector(this.dir) : opts.protector;
  }

  /**
   * Read the vault header and, for an os-keychain vault, unlock it right away. Never throws for a
   * missing, locked or unreadable vault: the problem is reported through `state` and `error`.
   */
  static async open(opts: VaultStoreOptions = {}): Promise<VaultStore> {
    const store = new VaultStore(opts);
    let envelope: VaultEnvelope | null = null;
    try {
      envelope = await store.readEnvelope();
    } catch (err) {
      store.broken = true;
      store.problem = err instanceof VaultError ? `${err.message} (${store.file})` : `Cannot read ${store.file}.`;
      return store;
    }
    if (!envelope) {
      store.keychainAvailable = (await store.protector?.available().catch(() => false)) ?? false;
      return store;
    }
    store.kdf = envelope.kdf;
    if (envelope.kdf.mode === "os-keychain") {
      store.keychainAvailable = true;
      await store.unlock().catch((err) => {
        store.problem = err instanceof VaultError ? err.message : "Could not unlock the vault.";
      });
    }
    return store;
  }

  get state(): VaultState {
    if (!this.kdf && !this.broken) return "uninitialized";
    return this.key ? "unlocked" : "locked";
  }

  /** Mode of the existing vault, or the mode a new one would get. "unknown" when the file is unreadable. */
  get protection(): Protection | "unknown" {
    if (this.broken) return "unknown";
    return this.kdf?.mode ?? (this.keychainAvailable ? "os-keychain" : "passphrase");
  }

  /** Name of the OS store that holds (or would hold) the master key, when os-keychain mode applies. */
  get keychainLabel(): string | null {
    return this.protection === "os-keychain" ? (this.protector?.label ?? null) : null;
  }

  /** Last problem that keeps the vault from opening, safe to show to the user. */
  get error(): string | undefined {
    return this.problem;
  }

  /** Copy of the decrypted secrets. */
  read(): VaultSecrets {
    return structuredClone(this.requireUnlocked());
  }

  /**
   * Create the vault. With a passphrase it uses passphrase mode; without, a random master key goes
   * into the OS credential store (os-keychain mode).
   */
  initialize(passphrase?: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.kdf || this.broken) throw new VaultError("invalid", "The vault already exists.");
      // Another Albireo process (e.g. `albireo keys` next to a running kernel) may have created it
      // since this store was opened. Overwriting it would also replace its master key.
      if (await this.readEnvelope()) {
        throw new VaultError("invalid", "Another Albireo process created the vault meanwhile; restart to use it.");
      }
      let kdf: KdfParams;
      let key: Buffer;
      if (passphrase !== undefined) {
        if (passphrase.length < MIN_PASSPHRASE) {
          throw new VaultError("invalid", `The passphrase must be at least ${MIN_PASSPHRASE} characters.`);
        }
        kdf = newKdf("passphrase");
        key = await deriveFromPassphrase(passphrase, kdf);
      } else {
        kdf = newKdf("os-keychain");
        key = await this.createMasterKey(kdf);
      }
      const secrets: VaultSecrets = { providers: {}, updatedAt: Date.now() };
      try {
        await this.persist(key, kdf, secrets);
      } catch (err) {
        key.fill(0);
        throw err;
      }
      this.kdf = kdf;
      this.key = key;
      this.secrets = secrets;
      this.problem = undefined;
    });
  }

  /** Unlock with the passphrase, or (os-keychain mode) by asking the OS store again. No-op when unlocked. */
  unlock(passphrase?: string): Promise<void> {
    return this.exclusive(async () => {
      if (this.broken) throw new VaultError("corrupt", this.problem ?? "The vault file is unreadable.");
      if (this.key) return;
      const envelope = await this.readEnvelope();
      if (!envelope) throw new VaultError("uninitialized", "The vault has not been created yet.");
      let key: Buffer;
      if (envelope.kdf.mode === "passphrase") {
        if (!passphrase) throw new VaultError("invalid", "A passphrase is required to unlock the vault.");
        key = await deriveFromPassphrase(passphrase, envelope.kdf);
      } else {
        key = await this.keyFromKeychain(envelope.kdf);
      }
      let secrets: VaultSecrets;
      try {
        secrets = parseSecrets(unseal(key, envelope));
      } catch (err) {
        key.fill(0);
        throw err;
      }
      this.kdf = envelope.kdf;
      this.key = key;
      this.secrets = secrets;
      this.problem = undefined;
    });
  }

  /** Drop the key and decrypted secrets from memory. The key buffer is zeroed. */
  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.secrets = null;
  }

  updateProvider(id: ProviderId, patch: ProviderPatch): Promise<void> {
    return this.exclusive(async () => {
      if (!isValidProviderId(id)) {
        throw new VaultError(
          "invalid",
          `Invalid provider id: ${String(id)}. Use lowercase letters, digits, '.', '_' or '-'.`,
        );
      }
      const clean = validatePatch(patch);
      this.requireUnlocked();
      const key = this.key as Buffer;
      const kdf = this.kdf as KdfParams;
      const current = await this.latest(key, kdf);
      const entry: ProviderSecret = { ...current.providers[id] };
      if (clean.clearApiKey) delete entry.apiKey;
      else if (clean.apiKey) entry.apiKey = clean.apiKey;
      for (const field of ["baseURL", "model"] as const) {
        const value = clean[field];
        if (value === undefined) continue;
        if (value) entry[field] = value;
        else delete entry[field];
      }
      const next: VaultSecrets = { providers: { ...current.providers }, updatedAt: Date.now() };
      if (Object.keys(entry).length > 0) next.providers[id] = entry;
      else delete next.providers[id];
      // latest() checked that the key is still ours, and nothing awaited since.
      await this.persist(key, kdf, next);
      this.secrets = next;
    });
  }

  /** Remove all stored fields for one provider. No-op when absent. */
  deleteProvider(id: ProviderId): Promise<void> {
    return this.exclusive(async () => {
      if (!isValidProviderId(id)) throw new VaultError("invalid", `Invalid provider id: ${String(id)}.`);
      this.requireUnlocked();
      const key = this.key as Buffer;
      const kdf = this.kdf as KdfParams;
      const current = await this.latest(key, kdf);
      if (!(id in current.providers)) return;
      const providers = { ...current.providers };
      delete providers[id];
      const next: VaultSecrets = { providers, updatedAt: Date.now() };
      await this.persist(key, kdf, next);
      this.secrets = next;
    });
  }

  // ---- internals -----------------------------------------------------------

  /**
   * The secrets as they are on disk now, so that a write never drops what another Albireo process
   * wrote after this one read the file. Also refreshes the in-memory copy.
   */
  private async latest(key: Buffer, kdf: KdfParams): Promise<VaultSecrets> {
    const envelope = await this.readEnvelope();
    // lock() may have run while we waited; it zeroes `key`.
    if (this.key !== key) throw new VaultError("locked", "The vault is locked.");
    if (!envelope || envelope.kdf.mode !== kdf.mode || envelope.kdf.salt !== kdf.salt) {
      throw new VaultError("invalid", `Another Albireo process replaced the vault (${this.file}); restart to use it.`);
    }
    this.secrets = parseSecrets(unseal(key, envelope));
    return this.secrets;
  }

  private requireUnlocked(): VaultSecrets {
    if (this.state === "uninitialized") throw new VaultError("uninitialized", "The vault has not been created yet.");
    if (!this.secrets || !this.key) throw new VaultError("locked", "The vault is locked.");
    return this.secrets;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async readEnvelope(): Promise<VaultEnvelope | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return parseEnvelope(text);
  }

  private async persist(key: Buffer, kdf: KdfParams, secrets: VaultSecrets): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(secrets), "utf8");
    const envelope = seal(key, kdf, plaintext);
    plaintext.fill(0);
    await writeFileAtomic(this.file, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  private async createMasterKey(kdf: KdfParams): Promise<Buffer> {
    const protector = this.protector;
    if (!protector || !(await protector.available())) {
      throw new VaultError(
        "unavailable",
        "No OS credential store is available here; protect the vault with a passphrase.",
      );
    }
    const master = randomBytes(MASTER_KEY_LEN);
    try {
      await protector.save(master);
      // Read it back: some stores report success without keeping the item.
      const back = await protector.load();
      const same = back?.equals(master) ?? false;
      back?.fill(0);
      if (!same) throw new Error("read-back mismatch");
      return deriveFromMasterKey(master, kdf);
    } catch {
      throw new VaultError("unavailable", `Could not store the master key in ${protector.label}.`);
    } finally {
      master.fill(0);
    }
  }

  private async keyFromKeychain(kdf: KdfParams): Promise<Buffer> {
    const protector = this.protector;
    if (!protector)
      throw new VaultError("unavailable", "This vault needs an OS credential store, and none is configured.");
    let master: Buffer | null;
    try {
      master = await protector.load();
    } catch {
      throw new VaultError("unavailable", `Could not read the master key from ${protector.label}.`);
    }
    if (!master) throw new VaultError("bad_key", `The master key is missing from ${protector.label}.`);
    try {
      return deriveFromMasterKey(master, kdf);
    } finally {
      master.fill(0);
    }
  }
}

function parseSecrets(buf: Buffer): VaultSecrets {
  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new VaultError("corrupt", "The decrypted vault is not valid JSON.");
  } finally {
    buf.fill(0);
  }
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const providers = (typeof obj.providers === "object" && obj.providers !== null ? obj.providers : {}) as Record<
    string,
    unknown
  >;
  const out: VaultSecrets = { providers: {}, updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0 };
  for (const [id, entry] of Object.entries(providers)) {
    if (!isValidProviderId(id) || typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const clean: ProviderSecret = {};
    for (const field of ["apiKey", "baseURL", "model"] as const) {
      const v = e[field];
      if (typeof v === "string" && v) clean[field] = v;
    }
    if (Object.keys(clean).length > 0) out.providers[id] = clean;
  }
  return out;
}

function validatePatch(patch: ProviderPatch): ProviderPatch {
  const p = (typeof patch === "object" && patch !== null ? patch : {}) as Record<string, unknown>;
  const str = (field: string, max: number): string | undefined => {
    const v = p[field];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new VaultError("invalid", `${field} must be a string.`);
    const t = v.trim();
    if (t.length > max || CONTROL.test(t)) throw new VaultError("invalid", `${field} is not valid.`);
    return t;
  };
  const apiKey = str("apiKey", 4096);
  if (apiKey && /\s/.test(apiKey)) throw new VaultError("invalid", "The API key must not contain whitespace.");
  const baseURL = str("baseURL", 2048);
  if (baseURL) {
    let url: URL;
    try {
      url = new URL(baseURL);
    } catch {
      throw new VaultError("invalid", "The base URL is not a valid URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new VaultError("invalid", "The base URL must start with http:// or https://.");
    }
    if (url.username || url.password) throw new VaultError("invalid", "Put credentials in the API key, not the URL.");
    assertSafeBaseURLQuery(url, "The base URL");
  }
  const model = str("model", 200);
  if (p.clearApiKey !== undefined && typeof p.clearApiKey !== "boolean") {
    throw new VaultError("invalid", "clearApiKey must be a boolean.");
  }
  return { apiKey, baseURL, model, clearApiKey: p.clearApiKey === true };
}
