import { readFile } from "node:fs/promises";
import path from "node:path";
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
import { assertSafeBaseURLQuery, isAllowedHeader } from "./credentials.js";
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

/** Parsed configuration before it is committed to memory, so callers can validate guards first. */
export interface ProviderConfigSnapshot {
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
 * Never holds API keys or tokens; files containing `apiKey` or `authToken` are rejected.
 */
export class ProviderConfigStore {
  readonly dir: string;
  readonly file: string;
  private entries: Record<string, ProviderConfigEntry> = {};
  private problem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(opts: ProviderConfigStoreOptions) {
    this.dir = opts.dir ?? defaultVaultDir();
    this.file = path.join(this.dir, PROVIDERS_FILE);
  }

  /**
   * Read and validate `providers.json`. Never throws for a missing or invalid file: a missing
   * file leaves only built-in providers; a broken file records `error` and falls back to built-ins.
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

  /** All resolved providers: built-ins first, then custom providers in file order. */
  list(): ResolvedProviderDefinition[] {
    return resolveDefinitions(this.entries);
  }

  /** Read `providers.json` without committing it, so a caller can check guards before applying it. */
  snapshot(): Promise<ProviderConfigSnapshot> {
    return this.exclusive(() => this.readSnapshot());
  }

  /** Commit a snapshot read earlier. Returns whether definitions or the parse error changed. */
  applySnapshot(snapshot: ProviderConfigSnapshot): Promise<boolean> {
    return this.exclusive(async () => this.commitSnapshot(snapshot));
  }

  /** Read and commit `providers.json` in one step. */
  reload(): Promise<boolean> {
    return this.exclusive(async () => this.commitSnapshot(await this.readSnapshot()));
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
    const entry = this.entries[id];
    return entry ? structuredClone(entry) : undefined;
  }

  /** Validate and save a provider entry (custom provider or built-in override). */
  upsert(id: ProviderId, entry: ProviderConfigEntry): Promise<ResolvedProviderDefinition> {
    return this.exclusive(async () => {
      const clean = validateProviderEntry(id, entry);
      const current = await this.readForWrite();
      const next: Record<string, ProviderConfigEntry> = { ...current, [id]: clean };
      await this.persist(next);
      this.entries = next;
      this.problem = undefined;
      return resolveOne(id, clean);
    });
  }

  /** Remove an entry from `providers.json`. Returns true if the entry existed. */
  remove(id: ProviderId): Promise<boolean> {
    return this.exclusive(async () => {
      if (!isValidProviderId(id)) {
        throw new VaultError("invalid", `Invalid provider id: ${String(id)}.`);
      }
      const current = await this.readForWrite();
      if (!(id in current)) return false;
      const next: Record<string, ProviderConfigEntry> = { ...current };
      delete next[id];
      await this.persist(next);
      this.entries = next;
      this.problem = undefined;
      return true;
    });
  }

  // ---- internals -----------------------------------------------------------

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async loadFromDisk(): Promise<void> {
    await this.commitSnapshot(await this.readSnapshot());
  }

  private commitSnapshot(snapshot: ProviderConfigSnapshot): boolean {
    const before = JSON.stringify(this.entries);
    const beforeProblem = this.problem;
    this.entries = snapshot.entries;
    this.problem = snapshot.problem;
    return JSON.stringify(this.entries) !== before || this.problem !== beforeProblem;
  }

  /**
   * Parse the file without mutating state. On a read/parse failure the last good entries are kept
   * (a half-written file must not make the running kernel forget its custom providers).
   */
  private async readSnapshot(): Promise<ProviderConfigSnapshot> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: {}, problem: undefined };
      return { entries: structuredClone(this.entries), problem: `Cannot read ${this.file}.` };
    }
    try {
      return { entries: parseProvidersFile(text).providers, problem: undefined };
    } catch (err) {
      const problem = err instanceof VaultError ? `${err.message} (${this.file})` : `Cannot parse ${this.file}.`;
      return { entries: structuredClone(this.entries), problem };
    }
  }

  private async readForWrite(): Promise<Record<string, ProviderConfigEntry>> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new VaultError("corrupt", `Cannot read ${this.file}.`);
    }
    try {
      return parseProvidersFile(text).providers;
    } catch (err) {
      const msg = err instanceof VaultError ? `${err.message} (${this.file})` : `Cannot parse ${this.file}.`;
      throw new VaultError("corrupt", `Fix or remove ${this.file} before saving provider settings: ${msg}`);
    }
  }

  private async persist(providers: Record<string, ProviderConfigEntry>): Promise<void> {
    const file: ProvidersFile = { providers };
    await writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`);
  }
}

export function parseProvidersFile(text: string): ProvidersFile {
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
  if (providersRaw === undefined) return { providers: {} };
  if (!isPlainObject(providersRaw)) {
    throw new VaultError("invalid", `"providers" in ${PROVIDERS_FILE} must be an object.`);
  }
  const providers: Record<string, ProviderConfigEntry> = {};
  for (const [id, entry] of Object.entries(providersRaw)) {
    providers[id] = validateProviderEntry(id, entry);
  }
  return { providers };
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
    const baseURL = validateBaseURL(raw.baseURL, `providers.${id}.baseURL`);
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

function validateBaseURL(v: unknown, label: string): string {
  const trimmed = validateText(v, label, 2048);
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new VaultError("invalid", `${label} is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new VaultError("invalid", `${label} must start with http:// or https://.`);
  }
  if (url.username || url.password) {
    throw new VaultError("invalid", `${label} must not embed credentials; put keys in the vault.`);
  }
  assertSafeBaseURLQuery(url, label);
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
    if (!isAllowedHeader(name)) {
      throw new VaultError(
        "invalid",
        `Header "${name}" is not allowed in ${label}; only non-credential metadata headers are accepted, keys belong in the vault.`,
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
