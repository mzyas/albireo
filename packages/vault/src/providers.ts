import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MESSAGES_API,
  type AnthropicCompat,
  OPENAI_COMPLETIONS_API,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  type OpenAICompletionsCompat,
  type ProviderAuthMode,
  type ProviderHeaders,
  type WireApi,
} from "@albireo/core";
import { isCredentialHeader, parseBaseURL } from "./credentials.js";
import { VaultError } from "./errors.js";
import { defaultVaultDir, writeFileAtomic } from "./fs.js";
import {
  BUILTIN_PROVIDER_IDS,
  type BuiltinProviderId,
  isBuiltinProviderId,
  isValidProviderId,
  type ProviderId,
} from "./store.js";

export const PROVIDERS_FILE = "providers.json";
/** How long a missing `providers.json` gets to reappear before it counts as deleted. */
const MISSING_FILE_RECHECK_MS = 150;

export type ProviderCompat = AnthropicCompat | OpenAICompletionsCompat;

export interface ProviderModelConfig {
  id: string;
  name?: string;
  maxTokens?: number;
  headers?: ProviderHeaders;
  compat?: ProviderCompat;
}

export interface ProviderConfigEntry {
  name?: string;
  api?: WireApi;
  baseURL?: string;
  defaultModel?: string;
  auth?: ProviderAuthMode;
  headers?: ProviderHeaders;
  compat?: ProviderCompat;
  models?: ProviderModelConfig[];
}

export interface ProvidersFile {
  providers: Record<string, ProviderConfigEntry>;
}

/** Something that follows the store's commits, e.g. `SecretManager` for its registry and session. */
export interface ProviderConfigWatcher {
  /**
   * The custom providers in use (each session's active one). They stay defined even if the file
   * drops them, so none is unregistered while in use, and `remove` refuses them. Asked at every
   * commit; a kept entry goes away at the first commit after no one names it.
   */
  keep?(): ProviderId | readonly ProviderId[] | undefined;
  /** Called right after every commit that changed something, before anything else can run. */
  committed?(): void;
}

/** Parsed file before it is committed to memory. */
interface Snapshot {
  entries: Record<string, ProviderConfigEntry>;
  problem?: string;
}

export interface ResolvedProviderDefinition {
  id: ProviderId;
  name: string;
  api: WireApi;
  baseURL: string;
  defaultModel: string;
  auth: ProviderAuthMode;
  builtin: boolean;
  headers?: ProviderHeaders;
  compat: ProviderCompat;
  models: ProviderModelConfig[];
}

export interface ProviderConfigStoreOptions {
  /** Directory for `providers.json`. Defaults to the per-user config dir next to `vault.enc.json`. */
  dir?: string;
}

export const DEFAULT_ANTHROPIC_COMPAT: Required<AnthropicCompat> = {
  supportsEagerToolInputStreaming: true,
  supportsFallbacks: true,
  thinkingMode: "adaptive",
};

export const CUSTOM_ANTHROPIC_COMPAT: Required<AnthropicCompat> = {
  supportsEagerToolInputStreaming: false,
  supportsFallbacks: false,
  thinkingMode: "none",
};

export const DEFAULT_OPENAI_COMPAT: Required<OpenAICompletionsCompat> = {
  maxTokensField: "max_completion_tokens",
  supportsUsageInStreaming: true,
  supportsDeveloperRole: false,
  requiresNonNullAssistantContent: false,
};

const BUILTIN_DEFAULTS: Record<BuiltinProviderId, ResolvedProviderDefinition> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    api: ANTHROPIC_MESSAGES_API,
    baseURL: ANTHROPIC_DEFAULT_BASE_URL,
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    auth: "api-key",
    builtin: true,
    compat: { ...DEFAULT_ANTHROPIC_COMPAT },
    models: [],
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    api: OPENAI_COMPLETIONS_API,
    baseURL: OPENAI_DEFAULT_BASE_URL,
    defaultModel: OPENAI_DEFAULT_MODEL,
    auth: "api-key",
    builtin: true,
    compat: { ...DEFAULT_OPENAI_COMPAT },
    models: [],
  },
};

const VALID_WIRE_APIS = new Set<string>([ANTHROPIC_MESSAGES_API, OPENAI_COMPLETIONS_API]);
const VALID_AUTH_MODES = new Set<string>(["api-key", "bearer", "none"]);
const ALLOWED_PROVIDER_KEYS = new Set([
  "name",
  "api",
  "baseURL",
  "defaultModel",
  "auth",
  "headers",
  "compat",
  "models",
]);
const ALLOWED_MODEL_KEYS = new Set(["id", "name", "maxTokens", "headers", "compat"]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Built-in provider definitions without any `providers.json` overrides. */
export function defaultProviderDefinitions(): ResolvedProviderDefinition[] {
  return BUILTIN_PROVIDER_IDS.map((id) => structuredClone(BUILTIN_DEFAULTS[id]));
}

/**
 * Non-secret provider endpoint configuration stored in `providers.json` next to `vault.enc.json`.
 * Never holds API keys or tokens: an entry with `apiKey` or `authToken` is invalid. Loading skips
 * invalid entries and records `error` (a reload keeps an entry's last good version instead), so
 * one bad entry doesn't hide the rest; writes require the whole file to be valid.
 */
export class ProviderConfigStore {
  readonly dir: string;
  readonly file: string;
  private entries: Record<string, ProviderConfigEntry> = {};
  private problem: string | undefined;
  /** Entries in memory only because a watcher keeps them; the file no longer has them. */
  private kept = new Set<ProviderId>();
  private readonly watchers = new Set<ProviderConfigWatcher>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(opts: ProviderConfigStoreOptions) {
    this.dir = opts.dir ?? defaultVaultDir();
    this.file = path.join(this.dir, PROVIDERS_FILE);
  }

  /**
   * Read and validate `providers.json`. Never throws for a missing or invalid file: a missing file
   * leaves only built-in providers, an invalid entry is skipped while the others load, and a file
   * that can't be read or isn't valid JSON leaves only built-ins. Both problems go into `error`.
   */
  static async open(opts: ProviderConfigStoreOptions = {}): Promise<ProviderConfigStore> {
    const store = new ProviderConfigStore(opts);
    await store.loadFromDisk();
    return store;
  }

  /** Last configuration error, safe to show to the user. */
  get error(): string | undefined {
    return this.problem;
  }

  /** Custom providers kept defined by a watcher although `providers.json` no longer has them. */
  get retained(): ReadonlySet<ProviderId> {
    return this.kept;
  }

  /** Register a watcher (see `ProviderConfigWatcher`). Returns a function that removes it. */
  watch(watcher: ProviderConfigWatcher): () => void {
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  /** All resolved providers: built-ins first, then custom providers in file order. */
  list(): ResolvedProviderDefinition[] {
    return resolveDefinitions(this.entries);
  }

  /**
   * Re-read `providers.json`. Returns whether the definitions, the error or the retained providers
   * changed. Read and commit happen in one queued section, so a write queued meanwhile can't be
   * overwritten by an older read.
   */
  reload(): Promise<boolean> {
    return this.exclusive(async () => this.commit(await this.readSnapshot()));
  }

  ids(): ProviderId[] {
    return this.list().map((p) => p.id);
  }

  get(id: ProviderId): ResolvedProviderDefinition | undefined {
    return this.list().find((p) => p.id === id);
  }

  has(id: ProviderId): boolean {
    return this.get(id) !== undefined;
  }

  rawEntry(id: ProviderId): ProviderConfigEntry | undefined {
    return Object.hasOwn(this.entries, id) ? structuredClone(this.entries[id]) : undefined;
  }

  /**
   * Validate and save a provider entry (custom provider or built-in override). The write starts
   * from the file on disk, so other entries end up as the file has them. `beforeCreate` runs for
   * a custom provider the file doesn't have, even if memory still does (removed by hand and not
   * reloaded yet, or kept only because it is in use): after the file was found writable and
   * before anything is written; if it throws, nothing is.
   */
  upsert(
    id: ProviderId,
    entry: ProviderConfigEntry,
    opts: { beforeCreate?: () => Promise<void> } = {},
  ): Promise<ResolvedProviderDefinition> {
    return this.exclusive(async () => {
      const clean = validateProviderEntry(id, entry);
      const { providers: current } = await this.readForWrite();
      if (!isBuiltinProviderId(id) && !Object.hasOwn(current, id)) await opts.beforeCreate?.();
      const next: Record<string, ProviderConfigEntry> = { ...current, [id]: clean };
      await this.persist(next);
      this.commit({ entries: next });
      return resolveOne(id, clean);
    });
  }

  /**
   * Remove an entry from `providers.json`. Returns true if the entry existed on disk. Refused for
   * a provider in use (see `ProviderConfigWatcher.keep`), also when it comes into use while the
   * file is being written: the file then gets its previous text back (see `putBack`).
   */
  remove(id: ProviderId): Promise<boolean> {
    return this.exclusive(async () => {
      if (!isValidProviderId(id)) {
        throw new VaultError("invalid", `Invalid provider id: ${String(id)}.`);
      }
      if (this.inUse().has(id)) throw inUseError(id);
      const { text, providers: current } = await this.readForWrite();
      const existed = Object.hasOwn(current, id);
      const next: Record<string, ProviderConfigEntry> = { ...current };
      delete next[id];
      if (existed) await this.persist(next);
      if (this.inUse().has(id)) {
        if (existed) await this.putBack(text, next);
        throw inUseError(id);
      }
      this.commit({ entries: next });
      return existed;
    });
  }

  // ---- internals -----------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async loadFromDisk(): Promise<void> {
    this.commit(await this.readSnapshot());
  }

  /**
   * Make `snapshot` the in-memory state, keeping what is in use, then tell the watchers. All
   * synchronous and called with nothing awaited after the read or write it follows, so what is in
   * use is current and nothing can run between the commit and the watchers' updates.
   */
  private commit(snapshot: Snapshot): boolean {
    const entries = { ...snapshot.entries };
    const kept = new Set<ProviderId>();
    for (const id of this.inUse()) {
      if (!Object.hasOwn(entries, id) && Object.hasOwn(this.entries, id)) {
        entries[id] = this.entries[id] as ProviderConfigEntry;
        kept.add(id);
      }
    }
    const changed =
      JSON.stringify(entries) !== JSON.stringify(this.entries) ||
      snapshot.problem !== this.problem ||
      !sameMembers(kept, this.kept);
    this.entries = entries;
    this.problem = snapshot.problem;
    this.kept = kept;
    if (changed) for (const watcher of this.watchers) watcher.committed?.();
    return changed;
  }

  /** Custom providers the watchers have in use right now. */
  private inUse(): Set<ProviderId> {
    const ids = new Set<ProviderId>();
    for (const watcher of this.watchers) {
      const kept = watcher.keep?.();
      for (const id of typeof kept === "string" ? [kept] : (kept ?? [])) {
        if (id && !isBuiltinProviderId(id)) ids.add(id);
      }
    }
    return ids;
  }

  /** The entries that came from the file: memory without the retained ones. Entries are never mutated. */
  private fileEntries(): Record<string, ProviderConfigEntry> {
    return Object.fromEntries(Object.entries(this.entries).filter(([id]) => !this.kept.has(id)));
  }

  private hasFileEntries(): boolean {
    return Object.keys(this.entries).some((id) => !this.kept.has(id));
  }

  /** The file's text, or null when it doesn't exist. */
  private async readText(): Promise<string | null> {
    const text = await readIfExists(this.file);
    if (text !== null || !this.hasFileEntries()) return text;
    // Editors that save by renaming leave the file missing for a moment; look once more before
    // treating a file that had entries as deleted.
    await delay(MISSING_FILE_RECHECK_MS);
    return readIfExists(this.file);
  }

  /** `error` text for a file that can't be parsed. */
  private describe(err: unknown): string {
    return err instanceof VaultError ? `${err.message} (${this.file})` : `Cannot parse ${this.file}.`;
  }

  /**
   * Parse the file without mutating state. On a read failure or a broken file the last good
   * entries are kept (a half-written file must not make the running kernel forget its custom
   * providers). A single invalid entry is reported and replaced by its last good version, if any;
   * the other entries still load.
   */
  private async readSnapshot(): Promise<Snapshot> {
    let text: string | null;
    try {
      text = await this.readText();
    } catch {
      return { entries: this.fileEntries(), problem: `Cannot read ${this.file}.` };
    }
    if (text === null) return { entries: {} };
    try {
      const { providers, errors } = parseProviders(text, this.fileEntries());
      const problem = errors.length > 0 ? `${errors.map((e) => e.message).join(" ")} (${this.file})` : undefined;
      return { entries: providers, problem };
    } catch (err) {
      return { entries: this.fileEntries(), problem: this.describe(err) };
    }
  }

  /** The file's text (null when missing) and its entries, parsed strictly so a write can't drop one. */
  private async readForWrite(): Promise<{ text: string | null; providers: Record<string, ProviderConfigEntry> }> {
    let text: string | null;
    try {
      text = await this.readText();
    } catch {
      throw new VaultError("corrupt", `Cannot read ${this.file}.`);
    }
    if (text === null) return { text, providers: {} };
    try {
      return { text, providers: parseProvidersFile(text).providers };
    } catch (err) {
      throw new VaultError(
        "corrupt",
        `Fix or remove ${this.file} before saving provider settings: ${this.describe(err)}`,
      );
    }
  }

  private async persist(providers: Record<string, ProviderConfigEntry>): Promise<void> {
    const file: ProvidersFile = { providers };
    await writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }

  /**
   * Undo a write of `written`: the file gets back exactly the `text` it had, not a re-serialized
   * copy. If that write fails too, memory follows the file as it now is, so an entry in use stays
   * only as a kept one (reported by `retained`) instead of a file and memory that disagree.
   */
  private async putBack(text: string | null, written: Record<string, ProviderConfigEntry>): Promise<void> {
    try {
      if (text !== null) await writeFileAtomic(this.file, text);
    } catch {
      this.commit({ entries: written });
    }
  }
}

const TRANSIENT_READ_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/** A file's text, or null if it doesn't exist. */
async function readIfExists(file: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readFile(file, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (process.platform === "win32" && attempt < 1 && TRANSIENT_READ_ERRORS.has(code ?? "")) {
        await delay(MISSING_FILE_RECHECK_MS);
        continue;
      }
      throw err;
    }
  }
}

function inUseError(id: ProviderId): VaultError {
  return new VaultError("invalid", `Provider "${id}" is in use; switch to another provider before deleting it.`);
}

function sameMembers<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Strict parse: the first invalid entry fails the whole file. Used before writing it back. */
export function parseProvidersFile(text: string): ProvidersFile {
  const { providers, errors } = parseProviders(text);
  if (errors[0]) throw errors[0];
  return { providers };
}

/**
 * Parse the file structure strictly, but collect invalid entries instead of failing on the first.
 * An invalid entry falls back to `fallback[id]` (its last good version) when there is one.
 */
function parseProviders(
  text: string,
  fallback: Readonly<Record<string, ProviderConfigEntry>> = {},
): { providers: Record<string, ProviderConfigEntry>; errors: VaultError[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VaultError("corrupt", `${PROVIDERS_FILE} is not valid JSON.`);
  }
  if (!isPlainObject(raw)) {
    throw new VaultError("invalid", `${PROVIDERS_FILE} must contain a JSON object.`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "providers") {
      throw new VaultError("invalid", `Unknown top-level field "${key}" in ${PROVIDERS_FILE}.`);
    }
  }
  const providersRaw = raw.providers;
  if (providersRaw === undefined) return { providers: {}, errors: [] };
  if (!isPlainObject(providersRaw)) {
    throw new VaultError("invalid", `"providers" in ${PROVIDERS_FILE} must be an object.`);
  }
  const providers: Record<string, ProviderConfigEntry> = {};
  const errors: VaultError[] = [];
  for (const [id, entry] of Object.entries(providersRaw)) {
    try {
      providers[id] = validateProviderEntry(id, entry);
    } catch (err) {
      if (!(err instanceof VaultError)) throw err;
      errors.push(err);
      if (Object.hasOwn(fallback, id)) providers[id] = structuredClone(fallback[id] as ProviderConfigEntry);
    }
  }
  return { providers, errors };
}

export function validateProviderEntry(id: unknown, raw: unknown): ProviderConfigEntry {
  if (!isValidProviderId(id)) {
    throw new VaultError(
      "invalid",
      `Invalid provider id: ${String(id)}. Use lowercase letters, digits, '.', '_' or '-'.`,
    );
  }
  if (!isPlainObject(raw)) {
    throw new VaultError("invalid", `Provider "${id}" must be an object.`);
  }
  if ("apiKey" in raw || "authToken" in raw) {
    throw new VaultError(
      "invalid",
      `Provider "${id}" must not contain apiKey or authToken in ${PROVIDERS_FILE}. Store credentials in the Albireo vault via the panel or \`albireo keys set ${id}\`.`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_PROVIDER_KEYS.has(key)) {
      const hint = key === "baseUrl" ? ' (use "baseURL")' : "";
      throw new VaultError("invalid", `Unknown field "${key}" for provider "${id}"${hint}.`);
    }
  }

  const builtin = isBuiltinProviderId(id);
  const out: ProviderConfigEntry = {};

  if (raw.name !== undefined) {
    const name = validateText(raw.name, `providers.${id}.name`, 100);
    if (name) out.name = name;
  }

  let resolvedApi: WireApi;
  if (raw.api !== undefined) {
    if (typeof raw.api !== "string" || !VALID_WIRE_APIS.has(raw.api)) {
      throw new VaultError("invalid", `providers.${id}.api must be one of: ${[...VALID_WIRE_APIS].join(", ")}.`);
    }
    out.api = raw.api as WireApi;
    resolvedApi = out.api;
  } else if (builtin) {
    resolvedApi = BUILTIN_DEFAULTS[id].api;
  } else {
    throw new VaultError("invalid", `Custom provider "${id}" must set api (${[...VALID_WIRE_APIS].join(" or ")}).`);
  }

  if (raw.baseURL !== undefined) {
    const baseURL = validateBaseURL(raw.baseURL, `providers.${id}.baseURL`, resolvedApi);
    if (baseURL) out.baseURL = baseURL;
  }
  if (!builtin && !out.baseURL) {
    throw new VaultError("invalid", `Custom provider "${id}" must set baseURL.`);
  }

  if (raw.auth !== undefined) {
    if (typeof raw.auth !== "string" || !VALID_AUTH_MODES.has(raw.auth)) {
      throw new VaultError("invalid", `providers.${id}.auth must be one of: api-key, bearer, none.`);
    }
    out.auth = raw.auth as ProviderAuthMode;
  }

  if (raw.headers !== undefined) {
    out.headers = validateHeaders(raw.headers, `providers.${id}.headers`);
  }

  if (raw.compat !== undefined) {
    out.compat = validateCompat(raw.compat, resolvedApi, `providers.${id}.compat`);
  }

  if (raw.defaultModel !== undefined) {
    const model = validateText(raw.defaultModel, `providers.${id}.defaultModel`, 200);
    if (model) out.defaultModel = model;
  }

  if (raw.models !== undefined) {
    out.models = validateModels(raw.models, resolvedApi, `providers.${id}.models`);
  }

  if (!builtin && !out.defaultModel && !(out.models && out.models.length > 0)) {
    throw new VaultError("invalid", `Custom provider "${id}" must set defaultModel or a non-empty models list.`);
  }

  return out;
}

function resolveDefinitions(entries: Record<string, ProviderConfigEntry>): ResolvedProviderDefinition[] {
  const out: ResolvedProviderDefinition[] = [];
  for (const id of BUILTIN_PROVIDER_IDS) {
    out.push(resolveOne(id, entries[id]));
  }
  for (const [id, entry] of Object.entries(entries)) {
    if (isBuiltinProviderId(id)) continue;
    out.push(resolveOne(id, entry));
  }
  return out;
}

function resolveOne(id: ProviderId, entry?: ProviderConfigEntry): ResolvedProviderDefinition {
  if (isBuiltinProviderId(id)) {
    const base = BUILTIN_DEFAULTS[id];
    if (!entry) return structuredClone(base);
    const api = entry.api ?? base.api;
    const baseCompat =
      api === base.api ? base.compat : api === ANTHROPIC_MESSAGES_API ? CUSTOM_ANTHROPIC_COMPAT : DEFAULT_OPENAI_COMPAT;
    const models = entry.models ? structuredClone(entry.models) : [];
    const defaultModel = entry.defaultModel ?? base.defaultModel;
    return {
      id,
      name: entry.name ?? base.name,
      api,
      baseURL: entry.baseURL ?? base.baseURL,
      defaultModel,
      auth: entry.auth ?? base.auth,
      builtin: true,
      ...(entry.headers ? { headers: { ...entry.headers } } : {}),
      compat: { ...baseCompat, ...entry.compat },
      models,
    };
  }
  if (!entry?.api || !entry.baseURL) {
    throw new VaultError("invalid", `Custom provider "${id}" is incomplete.`);
  }
  const models = entry.models ? structuredClone(entry.models) : [];
  const defaultModel = entry.defaultModel ?? models[0]?.id;
  if (!defaultModel) {
    throw new VaultError("invalid", `Custom provider "${id}" has no defaultModel.`);
  }
  const baseCompat = entry.api === ANTHROPIC_MESSAGES_API ? CUSTOM_ANTHROPIC_COMPAT : DEFAULT_OPENAI_COMPAT;
  return {
    id,
    name: entry.name ?? id,
    api: entry.api,
    baseURL: entry.baseURL,
    defaultModel,
    auth: entry.auth ?? "api-key",
    builtin: false,
    ...(entry.headers ? { headers: { ...entry.headers } } : {}),
    compat: { ...baseCompat, ...entry.compat },
    models,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateText(v: unknown, label: string, max: number): string {
  if (typeof v !== "string") throw new VaultError("invalid", `${label} must be a string.`);
  const trimmed = v.trim();
  if (trimmed.length > max || CONTROL.test(trimmed)) {
    throw new VaultError("invalid", `${label} is not valid.`);
  }
  return trimmed;
}

function validateBaseURL(v: unknown, label: string, api: WireApi): string {
  const trimmed = validateText(v, label, 2048);
  if (trimmed) parseBaseURL(trimmed, label, api);
  return trimmed;
}

function validateHeaders(v: unknown, label: string): ProviderHeaders {
  if (!isPlainObject(v)) throw new VaultError("invalid", `${label} must be an object.`);
  const entries = Object.entries(v);
  if (entries.length > 64) throw new VaultError("invalid", `${label} has too many entries.`);
  const out: ProviderHeaders = {};
  for (const [name, value] of entries) {
    if (!name || name.length > 128 || !HEADER_NAME_PATTERN.test(name)) {
      throw new VaultError("invalid", `Invalid header name "${name}" in ${label}.`);
    }
    if (value === null) {
      // Null is how a provider suppresses an SDK default header; it carries no credential.
      out[name] = null;
      continue;
    }
    if (isCredentialHeader(name)) {
      throw new VaultError(
        "invalid",
        `Header "${name}" is not allowed in ${label}: it looks like a credential, and keys belong in the vault.`,
      );
    }
    if (typeof value !== "string" || value.length > 4096 || CONTROL.test(value)) {
      throw new VaultError("invalid", `Invalid header value for "${name}" in ${label}.`);
    }
    out[name] = value;
  }
  return out;
}

function validateCompat(v: unknown, api: WireApi, label: string): ProviderCompat {
  if (!isPlainObject(v)) throw new VaultError("invalid", `${label} must be an object.`);
  if (api === ANTHROPIC_MESSAGES_API) {
    const out: AnthropicCompat = {};
    for (const [key, val] of Object.entries(v)) {
      if (key === "supportsEagerToolInputStreaming" || key === "supportsFallbacks") {
        if (typeof val !== "boolean") throw new VaultError("invalid", `${label}.${key} must be a boolean.`);
        out[key] = val;
      } else if (key === "thinkingMode") {
        if (val !== "adaptive" && val !== "none") {
          throw new VaultError("invalid", `${label}.thinkingMode must be "adaptive" or "none".`);
        }
        out.thinkingMode = val;
      } else {
        throw new VaultError("invalid", `Unknown Anthropic compat field "${key}" in ${label}.`);
      }
    }
    return out;
  }

  const out: OpenAICompletionsCompat = {};
  for (const [key, val] of Object.entries(v)) {
    if (key === "maxTokensField") {
      if (val !== "max_completion_tokens" && val !== "max_tokens") {
        throw new VaultError("invalid", `${label}.maxTokensField must be "max_completion_tokens" or "max_tokens".`);
      }
      out.maxTokensField = val;
    } else if (
      key === "supportsUsageInStreaming" ||
      key === "supportsDeveloperRole" ||
      key === "requiresNonNullAssistantContent"
    ) {
      if (typeof val !== "boolean") throw new VaultError("invalid", `${label}.${key} must be a boolean.`);
      out[key] = val;
    } else {
      throw new VaultError("invalid", `Unknown OpenAI compat field "${key}" in ${label}.`);
    }
  }
  return out;
}

function validateModels(v: unknown, api: WireApi, label: string): ProviderModelConfig[] {
  if (!Array.isArray(v)) throw new VaultError("invalid", `${label} must be an array.`);
  if (v.length > 200) throw new VaultError("invalid", `${label} has too many entries.`);
  const seen = new Set<string>();
  const out: ProviderModelConfig[] = [];
  for (let i = 0; i < v.length; i++) {
    const item = v[i];
    const itemLabel = `${label}[${i}]`;
    if (!isPlainObject(item)) throw new VaultError("invalid", `${itemLabel} must be an object.`);
    for (const key of Object.keys(item)) {
      if (!ALLOWED_MODEL_KEYS.has(key)) {
        throw new VaultError("invalid", `Unknown field "${key}" in ${itemLabel}.`);
      }
    }
    const id = validateText(item.id, `${itemLabel}.id`, 200);
    if (!id) throw new VaultError("invalid", `${itemLabel}.id must be a non-empty string.`);
    if (seen.has(id)) throw new VaultError("invalid", `Duplicate model id "${id}" in ${label}.`);
    seen.add(id);

    const clean: ProviderModelConfig = { id };
    if (item.name !== undefined) {
      const name = validateText(item.name, `${itemLabel}.name`, 100);
      if (name) clean.name = name;
    }
    if (item.maxTokens !== undefined) {
      if (
        typeof item.maxTokens !== "number" ||
        !Number.isInteger(item.maxTokens) ||
        item.maxTokens <= 0 ||
        item.maxTokens > 1_000_000
      ) {
        throw new VaultError("invalid", `${itemLabel}.maxTokens must be a positive integer.`);
      }
      clean.maxTokens = item.maxTokens;
    }
    if (item.headers !== undefined) {
      clean.headers = validateHeaders(item.headers, `${itemLabel}.headers`);
    }
    if (item.compat !== undefined) {
      clean.compat = validateCompat(item.compat, api, `${itemLabel}.compat`);
    }
    out.push(clean);
  }
  return out;
}
