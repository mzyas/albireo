import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { builtinTools, Session } from "@albireo/core";
import {
  CUSTOM_ANTHROPIC_COMPAT,
  createVaultRegistry,
  DEFAULT_ANTHROPIC_COMPAT,
  DEFAULT_OPENAI_COMPAT,
  MemoryKeyProtector,
  PROVIDERS_FILE,
  ProviderConfigStore,
  providerProblem,
  SecretManager,
  UnconfiguredProvider,
  VAULT_FILE,
  VaultError,
  VaultStore,
} from "../dist/index.js";

const KEY = "sk-custom-0123456789abcdefWXYZ";

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-providers-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isVaultError = (code) => (err) => err instanceof VaultError && err.code === code;

const local = { api: "openai-completions", baseURL: "http://127.0.0.1:11434/v1", defaultModel: "q", auth: "none" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Long enough for a reload to find providers.json missing, and well inside the time the store
 * then waits for it to come back. A slow first read only means the reload sees the file anyway,
 * which every test using this still passes.
 */
const MISSING_FILE_SEEN_MS = 50;

/** Replace `file` the way editors do (temporary file, then rename), so no one reads it half-written. */
async function replaceFile(file, text) {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

/**
 * Open the stores on `dir`. `providers` is written to providers.json first; `keys` (provider ID to
 * vault patch) go into a vault created first, protected by `passphrase` if one is given.
 */
async function openStores(dir, { providers, keys, passphrase } = {}) {
  if (providers) await writeFile(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers }));
  const config = await ProviderConfigStore.open({ dir });
  const vault = await VaultStore.open({ dir, protector: passphrase ? null : new MemoryKeyProtector() });
  if (keys || passphrase) {
    await vault.initialize(passphrase);
    for (const [id, patch] of Object.entries(keys ?? {})) await vault.updateProvider(id, patch);
  }
  return { config, vault, registry: createVaultRegistry(vault, {}, config) };
}

const sessionOn = (registry, provider, cwd) => new Session({ providers: registry, provider, tools: builtinTools, cwd });

/** Switch `session` to `id`; false if the registry no longer has it. */
function switchTo(session, id) {
  try {
    session.switchProvider(id);
    return true;
  } catch (err) {
    assert.match(err.message, new RegExp(`Unknown provider "${id}"`));
    return false;
  }
}

/**
 * Race `act` against an operation at every point it can land: `start(dir)` begins the operation
 * (`run.operation`), `act(run)` runs after 0, 1, 2, … ticks and returns whether it took effect,
 * and `check(run, outcome, acted)` sees what both did. Stops at the first `act` that no longer
 * takes effect (the operation is past the point that matters), or once the operation finishes
 * before `act` runs. Fails unless `act` took effect in some runs and not in others, so both
 * orders were really checked.
 */
async function sweep({ start, act, check }) {
  const seen = new Set();
  for (let wait = 0, more = true; more; wait++) {
    await withDir(async (dir) => {
      const run = await start(dir);
      let settled = false;
      const outcome = run.operation.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      outcome.then(() => {
        settled = true;
      });
      for (let i = 0; i < wait && !settled; i++) await tick();
      const finishedFirst = settled;
      const acted = act(run);
      seen.add(acted);
      more = acted && !finishedFirst;
      await check(run, await outcome, acted);
    });
  }
  assert.ok(seen.has(true) && seen.has(false), "act should take effect in some runs and not in others");
}

test("ProviderConfigStore defaults to built-ins when providers.json is absent", () =>
  withDir(async (dir) => {
    const store = await ProviderConfigStore.open({ dir });
    assert.equal(store.error, undefined);
    assert.deepEqual(store.ids(), ["anthropic", "openai"]);
    const anthropic = store.get("anthropic");
    assert.equal(anthropic.builtin, true);
    assert.equal(anthropic.api, "anthropic-messages");
    assert.deepEqual(anthropic.compat, DEFAULT_ANTHROPIC_COMPAT);
    const openai = store.get("openai");
    assert.equal(openai.builtin, true);
    assert.equal(openai.api, "openai-completions");
    assert.deepEqual(openai.compat, DEFAULT_OPENAI_COMPAT);
  }));

test("providers.json merges built-in overrides and custom providers with per-API compat defaults", () =>
  withDir(async (dir) => {
    await writeFile(
      path.join(dir, PROVIDERS_FILE),
      JSON.stringify({
        providers: {
          anthropic: {
            baseURL: "https://proxy.example.com/anthropic",
            headers: { "X-Proxy": "1" },
            compat: { supportsFallbacks: false },
          },
          deepseek: {
            name: "DeepSeek",
            api: "openai-completions",
            baseURL: "https://api.deepseek.com/v1",
            compat: { maxTokensField: "max_tokens", requiresNonNullAssistantContent: true },
            models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner", maxTokens: 8192 }],
          },
          "claude-gw": {
            name: "Claude Gateway",
            api: "anthropic-messages",
            baseURL: "https://gw.example.com/v1",
            defaultModel: "claude-sonnet-4-5",
            auth: "bearer",
          },
          ollama: {
            name: "Ollama",
            api: "openai-completions",
            baseURL: "http://127.0.0.1:11434/v1",
            defaultModel: "qwen2.5-coder:14b",
            auth: "none",
          },
        },
      }),
    );

    const store = await ProviderConfigStore.open({ dir });
    assert.equal(store.error, undefined);
    assert.deepEqual(store.ids(), ["anthropic", "openai", "deepseek", "claude-gw", "ollama"]);

    const anthropic = store.get("anthropic");
    assert.equal(anthropic.baseURL, "https://proxy.example.com/anthropic");
    assert.deepEqual(anthropic.headers, { "X-Proxy": "1" });
    assert.deepEqual(anthropic.compat, { ...DEFAULT_ANTHROPIC_COMPAT, supportsFallbacks: false });

    const deepseek = store.get("deepseek");
    assert.equal(deepseek.builtin, false);
    assert.equal(deepseek.defaultModel, "deepseek-chat");
    assert.equal(deepseek.auth, "api-key");
    assert.deepEqual(deepseek.compat, {
      ...DEFAULT_OPENAI_COMPAT,
      maxTokensField: "max_tokens",
      requiresNonNullAssistantContent: true,
    });
    assert.equal(deepseek.models.length, 2);

    const gw = store.get("claude-gw");
    assert.equal(gw.auth, "bearer");
    assert.deepEqual(gw.compat, CUSTOM_ANTHROPIC_COMPAT);

    const ollama = store.get("ollama");
    assert.equal(ollama.auth, "none");
  }));

test("providers.json rejects plaintext apiKey/authToken and falls back to built-ins on corrupt files", () =>
  withDir(async (dir) => {
    await writeFile(
      path.join(dir, PROVIDERS_FILE),
      JSON.stringify({
        providers: {
          deepseek: {
            api: "openai-completions",
            baseURL: "https://api.deepseek.com/v1",
            defaultModel: "deepseek-chat",
            apiKey: "sk-plaintext-leak",
          },
        },
      }),
    );

    const store = await ProviderConfigStore.open({ dir });
    assert.match(store.error, /must not contain apiKey or authToken/);
    assert.deepEqual(store.ids(), ["anthropic", "openai"]);

    // Refuses to silently clobber a broken providers.json on disk.
    await assert.rejects(
      store.upsert("ollama", {
        api: "openai-completions",
        baseURL: "http://127.0.0.1:11434/v1",
        defaultModel: "qwen2.5",
        auth: "none",
      }),
      isVaultError("corrupt"),
    );
  }));

test("ProviderConfigStore.upsert validates schema strictly", () =>
  withDir(async (dir) => {
    const store = await ProviderConfigStore.open({ dir });
    await assert.rejects(
      store.upsert("deepseek", {
        api: "openai-completions",
        baseURL: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        apiKey: KEY,
      }),
      isVaultError("invalid"),
    );
    await assert.rejects(
      store.upsert("deepseek", {
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
      }),
      (err) => err instanceof VaultError && err.code === "invalid" && err.message.includes('use "baseURL"'),
    );
    await assert.rejects(
      store.upsert("deepseek", {
        api: "openai-completions",
        baseURL: "https://user:pass@api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
      }),
      isVaultError("invalid"),
    );
    await assert.rejects(
      store.upsert("deepseek", {
        api: "openai-completions",
        baseURL: "https://api.deepseek.com/v1",
      }),
      isVaultError("invalid"),
    );
    await assert.rejects(
      store.upsert("deepseek", {
        api: "openai-completions",
        baseURL: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        compat: { supportsFallbacks: false },
      }),
      isVaultError("invalid"),
    );
    await assert.rejects(
      store.upsert("deepseek", {
        api: "openai-completions",
        baseURL: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        headers: { "Bad Header": "1" },
      }),
      isVaultError("invalid"),
    );
    await assert.rejects(
      store.upsert("deepseek", {
        api: "openai-completions",
        baseURL: "https://api.deepseek.com/v1",
        models: [{ id: "m1" }, { id: "m1" }],
      }),
      isVaultError("invalid"),
    );
  }));

test("auth: none provider is ready without vault key; api-key custom provider uses vault and redacts errors", () =>
  withDir(async (dir) => {
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("ollama", {
      name: "Ollama",
      api: "openai-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      defaultModel: "qwen2.5-coder:14b",
      auth: "none",
      headers: { "X-Client": "albireo" },
    });
    await config.upsert("deepseek", {
      name: "DeepSeek",
      api: "openai-completions",
      baseURL: "https://api.deepseek.com/v1",
      defaultModel: "deepseek-chat",
      compat: { maxTokensField: "max_tokens" },
    });

    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    assert.equal(providerProblem(vault, config.get("ollama")), undefined);
    assert.equal(providerProblem(vault, config.get("deepseek")).cause, "key");

    const seen = {};
    const factories = {
      ollama: (cfg) => {
        seen.ollama = cfg;
        return {
          id: cfg.id,
          defaultModel: cfg.model,
          async runTurn() {
            return {
              message: { role: "assistant", content: [{ type: "text", text: "local" }] },
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        };
      },
      deepseek: (cfg) => {
        seen.deepseek = cfg;
        return {
          id: cfg.id,
          defaultModel: cfg.model,
          async runTurn() {
            throw new Error(`401 rejected ${KEY}`);
          },
        };
      },
    };

    const registry = createVaultRegistry(vault, factories, config);
    const ollama = registry.get("ollama");
    assert.ok(!(ollama instanceof UnconfiguredProvider));
    assert.equal(seen.ollama.apiKey, undefined);
    assert.equal(seen.ollama.auth, "none");
    assert.deepEqual(seen.ollama.headers, { "X-Client": "albireo" });

    assert.ok(registry.get("deepseek") instanceof UnconfiguredProvider);

    await vault.initialize();
    await vault.updateProvider("deepseek", { apiKey: KEY, baseURL: "https://override.example/v1" });
    assert.equal(providerProblem(vault, config.get("deepseek")), undefined);

    const registry2 = createVaultRegistry(vault, factories, config);
    const deepseek = registry2.get("deepseek");
    assert.ok(!(deepseek instanceof UnconfiguredProvider));
    assert.equal(seen.deepseek.baseURL, "https://override.example/v1");
    assert.equal(seen.deepseek.compat.maxTokensField, "max_tokens");
    await assert.rejects(
      deepseek.runTurn({}, () => {}),
      (err) => !err.message.includes(KEY) && err.message.includes("sk-••••WXYZ"),
    );
  }));

test("SecretManager upserts and deletes custom providers while guarding built-ins and active session provider", () =>
  withDir(async (dir) => {
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-cwd-"));
    try {
      const session = new Session({ providers: registry, provider: "anthropic", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });

      const added = await manager.upsertProviderConfig({
        id: "ollama",
        name: "Ollama",
        api: "openai-completions",
        baseURL: "http://127.0.0.1:11434/v1",
        defaultModel: "qwen2.5-coder:14b",
        auth: "none",
      });
      assert.deepEqual(added.providerOrder, ["anthropic", "openai", "ollama"]);
      assert.equal(added.providers.ollama.configured, true);
      assert.equal(added.providers.ollama.hasKey, false);
      assert.equal(added.providers.ollama.builtin, false);
      assert.equal(registry.has("ollama"), true);

      // Save an override in vault too so we can verify deletion cleans it up.
      await manager.setProvider({ provider: "ollama", model: "llama3.3" });
      assert.equal(vault.read().providers.ollama.model, "llama3.3");

      // Built-in cannot be deleted.
      await assert.rejects(manager.deleteCustomProvider("anthropic"), isVaultError("invalid"));

      // Active session provider cannot be deleted.
      session.switchProvider("ollama");
      await assert.rejects(manager.deleteCustomProvider("ollama"), isVaultError("invalid"));

      // Switch back and delete cleanly.
      session.switchProvider("anthropic");
      const after = await manager.deleteCustomProvider("ollama");
      assert.deepEqual(after.providerOrder, ["anthropic", "openai"]);
      assert.equal(after.providers.ollama, undefined);
      assert.equal(registry.has("ollama"), false);
      assert.equal(vault.read().providers.ollama, undefined);

      // Disk providers.json no longer contains ollama.
      const onDisk = JSON.parse(await readFile(config.file, "utf8"));
      assert.equal(onDisk.providers.ollama, undefined);

      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("providers.json rejects credentials hidden in headers or baseURL query", () =>
  withDir(async (dir) => {
    const store = await ProviderConfigStore.open({ dir });
    const base = {
      api: "openai-completions",
      baseURL: "https://api.example.com/v1",
      defaultModel: "m",
    };
    await assert.rejects(
      store.upsert("gw", { ...base, headers: { Authorization: `Bearer ${KEY}` } }),
      isVaultError("invalid"),
    );
    await assert.rejects(store.upsert("gw", { ...base, headers: { "x-api-key": KEY } }), isVaultError("invalid"));
    await assert.rejects(
      store.upsert("gw", { ...base, baseURL: "https://api.example.com/v1?api_key=plaintext" }),
      isVaultError("invalid"),
    );

    // Null is still allowed: it suppresses an SDK default header, it doesn't carry a credential.
    await store.upsert("gw", { ...base, headers: { authorization: null } });
    assert.equal(store.get("gw").headers.authorization, null);
  }));

test("reloadProviderConfig picks up external providers.json edits without spurious notifications", () =>
  withDir(async (dir) => {
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-reload-"));
    try {
      const session = new Session({ providers: registry, provider: "anthropic", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });
      let notifications = 0;
      manager.onChange(() => {
        notifications++;
      });

      const first = await manager.reloadProviderConfig();
      assert.deepEqual(first.providerOrder, ["anthropic", "openai"]);
      assert.equal(notifications, 0);

      await writeFile(
        config.file,
        JSON.stringify({
          providers: {
            ollama: {
              api: "openai-completions",
              baseURL: "http://127.0.0.1:11434/v1",
              defaultModel: "q",
              auth: "none",
            },
          },
        }),
      );
      const second = await manager.reloadProviderConfig();
      assert.deepEqual(second.providerOrder, ["anthropic", "openai", "ollama"]);
      assert.equal(registry.has("ollama"), true);
      assert.equal(notifications, 1);

      const third = await manager.reloadProviderConfig();
      assert.deepEqual(third.providerOrder, second.providerOrder);
      assert.equal(notifications, 1);
      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("a passphrase-locked vault refuses deleting and adding custom providers; POST /providers takes no key", () =>
  withDir(async (dir) => {
    const passphrase = "a long enough passphrase";
    const entry = { api: "openai-completions", baseURL: "https://gw-a.example/v1", defaultModel: "q" };
    const stores = await openStores(dir, {
      providers: { gw: entry },
      passphrase,
      keys: { gw: { apiKey: KEY, baseURL: "https://gw-a.example/override" } },
    });
    const { config, vault } = stores;
    const manager = new SecretManager(stores);

    vault.lock();
    assert.equal(manager.status().needsUnlock, true);
    await assert.rejects(manager.deleteCustomProvider("gw"), isVaultError("locked"));
    assert.equal(config.has("gw"), true);
    await assert.rejects(manager.upsertProviderConfig({ id: "new", ...entry }), isVaultError("locked"));
    assert.equal(config.has("new"), false);
    // Overriding a built-in is not "new", so it doesn't need the vault.
    await manager.upsertProviderConfig({ id: "openai", baseURL: "https://proxy.example/v1" });
    // Keys never go into providers.json, not even on the way to the vault.
    await assert.rejects(manager.upsertProviderConfig({ id: "x", ...entry, apiKey: KEY }), isVaultError("invalid"));

    await manager.unlock({ passphrase });
    await manager.deleteCustomProvider("gw");
    assert.equal(config.has("gw"), false);
    assert.equal(vault.read().providers.gw, undefined);

    // Re-adding the ID starts from scratch: no old key, no old endpoint override.
    await manager.upsertProviderConfig({ id: "gw", ...entry, baseURL: "https://gw-b.example/v1" });
    const view = manager.status().providers.gw;
    assert.equal(view.hasKey, false);
    assert.equal(view.baseURL, undefined);
    manager.dispose();
  }));

test("a vault that cannot be opened blocks adding custom providers, not changing or deleting them", () =>
  withDir(async (dir) => {
    await writeFile(path.join(dir, VAULT_FILE), "garbage");
    const stores = await openStores(dir, { providers: { ollama: local } });
    assert.equal(stores.vault.state, "locked");
    assert.ok(stores.vault.error);
    const manager = new SecretManager(stores);
    assert.equal(manager.status().needsUnlock, false);

    // A key left under the ID can't be cleared now, and the new provider would get it once the
    // vault opens again.
    await assert.rejects(manager.upsertProviderConfig({ id: "gw", ...local }), isVaultError("unavailable"));
    assert.equal(stores.config.has("gw"), false);

    await manager.upsertProviderConfig({ id: "ollama", ...local, defaultModel: "r" });
    assert.equal(stores.config.get("ollama").defaultModel, "r");
    await manager.deleteCustomProvider("ollama");
    assert.equal(stores.config.has("ollama"), false);
    manager.dispose();
  }));

test("re-adding a provider removed outside the panel does not pick up its old key or override", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw-a.example/v1", defaultModel: "q" };
    const stores = await openStores(dir, {
      providers: { gw: entry },
      keys: { gw: { apiKey: KEY, baseURL: "https://old.example/v1" }, anthropic: { apiKey: KEY } },
    });
    const { config, vault } = stores;
    const manager = new SecretManager(stores);

    await writeFile(config.file, JSON.stringify({ providers: {} }));
    await manager.reloadProviderConfig();
    assert.equal(config.has("gw"), false);

    const status = await manager.upsertProviderConfig({ id: "gw", ...entry, baseURL: "https://gw-b.example/v1" });
    assert.equal(status.providers.gw.hasKey, false);
    assert.equal(status.providers.gw.baseURL, undefined);
    assert.equal(vault.read().providers.gw, undefined);

    // A built-in override is never "new": its key stays.
    const builtin = await manager.upsertProviderConfig({ id: "anthropic", baseURL: "https://proxy.example" });
    assert.equal(builtin.providers.anthropic.hasKey, true);
    manager.dispose();
  }));

test("a provider the file no longer has is new when added again, even while it is still listed", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw-a.example/v1", defaultModel: "q" };
    const old = { apiKey: KEY, baseURL: "https://old.example/v1" };
    const stores = await openStores(dir, { providers: { gw: entry, active: entry }, keys: { gw: old, active: old } });
    const { config, vault } = stores;
    const session = sessionOn(stores.registry, "active", dir);
    const manager = new SecretManager({ ...stores, session });
    const again = { ...entry, baseURL: "https://gw-b.example/v1" };

    // Removed by hand, and nothing has reloaded since: still listed, but gone from the file.
    await writeFile(config.file, JSON.stringify({ providers: { active: entry } }));
    assert.equal(config.has("gw"), true);
    const readded = await manager.upsertProviderConfig({ id: "gw", ...again });
    assert.equal(readded.providers.gw.hasKey, false);
    assert.equal(readded.providers.gw.baseURL, undefined);

    // Removed by hand while in use: kept until the session moves on, but adding it starts over.
    await writeFile(config.file, JSON.stringify({ providers: { gw: again } }));
    await manager.reloadProviderConfig();
    assert.deepEqual([...config.retained], ["active"]);
    const restarted = await manager.upsertProviderConfig({ id: "active", ...again });
    assert.equal(config.retained.size, 0);
    assert.equal(restarted.providers.active.hasKey, false);
    assert.equal(vault.read().providers.active, undefined);
    assert.equal(restarted.providers.active.configured, false);
    manager.dispose();
  }));

test("re-adding a provider whose entry on disk is invalid fails without touching its key", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" };
    const stores = await openStores(dir, {
      providers: { gw: { ...entry, headers: { "X-Api-Key": "abc" } } },
      keys: { gw: { apiKey: KEY } },
    });
    assert.equal(stores.config.has("gw"), false);
    const manager = new SecretManager(stores);

    await assert.rejects(manager.upsertProviderConfig({ id: "gw", ...entry }), isVaultError("corrupt"));
    assert.equal(stores.vault.read().providers.gw.apiKey, KEY);
    manager.dispose();
  }));

test("deleting a provider removes its entry before its key, so a file that needs fixing loses nothing", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" };
    const stores = await openStores(dir, {
      providers: { gw: entry, bad: { api: "nope" } },
      keys: { gw: { apiKey: KEY } },
    });
    const manager = new SecretManager(stores);

    await assert.rejects(manager.deleteCustomProvider("gw"), isVaultError("corrupt"));
    assert.equal(stores.config.has("gw"), true);
    assert.equal(stores.vault.read().providers.gw.apiKey, KEY);
    manager.dispose();
  }));

test("a provider that comes into use while it is being deleted is not deleted", () =>
  sweep({
    async start(dir) {
      const stores = await openStores(dir, {
        providers: { gw: { ...local, auth: "api-key" } },
        keys: { gw: { apiKey: KEY } },
      });
      const session = sessionOn(stores.registry, "anthropic", dir);
      const manager = new SecretManager({ ...stores, session });
      const text = await readFile(stores.config.file, "utf8");
      return { ...stores, session, manager, text, operation: manager.deleteCustomProvider("gw") };
    },
    act: ({ session }) => switchTo(session, "gw"),
    async check({ config, vault, registry, session, manager, text }, { error }, switched) {
      if (switched) {
        // The switch came first: the delete fails and leaves the file (to the byte) and the key
        // as they were.
        assert.match(error?.message ?? "", /Provider "gw" is in use/);
        assert.equal(await readFile(config.file, "utf8"), text);
        assert.equal(vault.read().providers.gw.apiKey, KEY);
        assert.equal(config.retained.size, 0);
      } else {
        // The delete came first: gw was unregistered, so the switch was refused.
        assert.equal(error, undefined);
        assert.equal(config.has("gw"), false);
        assert.equal(vault.read().providers.gw, undefined);
      }
      assert.equal(registry.has(session.providerId), true);
      manager.dispose();
    },
  }));

test("a switch during a write never leaves the session on an unregistered provider", () =>
  sweep({
    async start(dir) {
      const stores = await openStores(dir, { providers: { y: local } });
      const session = sessionOn(stores.registry, "anthropic", dir);
      const manager = new SecretManager({ ...stores, session });
      // Another process drops y before this one has reloaded.
      await writeFile(stores.config.file, JSON.stringify({ providers: {} }));
      return { ...stores, session, manager, operation: manager.upsertProviderConfig({ id: "z", ...local }) };
    },
    // Before the commit y is kept as the active provider; after it, the switch itself is refused.
    act: ({ session }) => switchTo(session, "y"),
    check({ config, registry, session, manager }, { error }) {
      assert.equal(error, undefined);
      assert.equal(config.has("z"), true);
      assert.equal(registry.has(session.providerId), true);
      session.refreshProvider();
      manager.dispose();
    },
  }));

test("a file that drops the active provider keeps it defined until the session switches away", () =>
  withDir(async (dir) => {
    const newgw = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "m", auth: "none" };
    const stores = await openStores(dir, { providers: { ollama: local } });
    const { config, registry } = stores;
    const session = sessionOn(registry, "ollama", dir);
    const manager = new SecretManager({ ...stores, session });
    let notifications = 0;
    manager.onChange(() => {
      notifications++;
    });

    await writeFile(config.file, "{ not json");
    assert.match((await manager.reloadProviderConfig()).configError, /not valid JSON/);
    assert.equal(notifications, 1);

    await writeFile(config.file, JSON.stringify({ providers: { newgw } }));
    const kept = await manager.reloadProviderConfig();
    assert.match(kept.configError, /Active provider "ollama" is no longer in providers.json/);
    // The fixed parse error is gone; only the current state is reported.
    assert.doesNotMatch(kept.configError, /not valid JSON/);
    assert.deepEqual(kept.providerOrder, ["anthropic", "openai", "newgw", "ollama"]);
    assert.equal(registry.has("newgw"), true);
    assert.equal(registry.has("ollama"), true);
    assert.equal(notifications, 2);
    await manager.reloadProviderConfig();
    assert.equal(notifications, 2);

    // Breaking the file again does not forget that ollama is only kept.
    await writeFile(config.file, "{ not json");
    const broken = await manager.reloadProviderConfig();
    assert.match(broken.configError, /Active provider "ollama"/);
    assert.match(broken.configError, /not valid JSON/);
    await writeFile(config.file, JSON.stringify({ providers: { newgw } }));
    await manager.reloadProviderConfig();

    // Writes go ahead and keep it too, but it can't be deleted while in use.
    await manager.upsertProviderConfig({ id: "other", ...local, baseURL: "https://other.example/v1" });
    assert.equal(registry.has("ollama"), true);
    session.refreshProvider();
    await assert.rejects(manager.deleteCustomProvider("ollama"), /Provider "ollama" is in use/);

    // Switching away drops it without waiting for another GET /secrets.
    const dropped = new Promise((resolve) => manager.onChange(resolve));
    session.switchProvider("anthropic");
    await dropped;
    const status = manager.status();
    assert.equal(status.configError, undefined);
    assert.deepEqual(status.providerOrder, ["anthropic", "openai", "newgw", "other"]);
    assert.equal(registry.has("ollama"), false);
    manager.dispose();
  }));

test("watchers are independent and go away when their manager is disposed", () =>
  withDir(async (dir) => {
    const stores = await openStores(dir, { providers: { a: local, b: local } });
    const { config, registry } = stores;
    const m1 = new SecretManager({ ...stores, session: sessionOn(registry, "a", dir) });
    const m2 = new SecretManager({ ...stores, session: sessionOn(registry, "b", dir) });
    await writeFile(config.file, JSON.stringify({ providers: {} }));
    await config.reload();
    assert.deepEqual([...config.retained].sort(), ["a", "b"]);
    m1.dispose();
    await config.reload();
    assert.deepEqual([...config.retained], ["b"]);
    m2.dispose();
  }));

test("reload keeps the last good config when the file is briefly corrupt or missing", () =>
  withDir(async (dir) => {
    const goodFile = JSON.stringify({ providers: { ollama: local } });
    const stores = await openStores(dir, { providers: { ollama: local } });
    const { config, registry } = stores;
    const manager = new SecretManager(stores);
    let notifications = 0;
    manager.onChange(() => {
      notifications++;
    });

    await writeFile(config.file, "{ not json");
    const broken = await manager.reloadProviderConfig();
    assert.match(broken.configError, /not valid JSON/);
    assert.deepEqual(broken.providerOrder, ["anthropic", "openai", "ollama"]);
    assert.equal(registry.has("ollama"), true);
    assert.equal(notifications, 1);

    await writeFile(config.file, goodFile);
    const fixed = await manager.reloadProviderConfig();
    assert.equal(fixed.configError, undefined);
    assert.equal(notifications, 2);

    // Editors that save by renaming leave the file missing for a moment. The file comes back only
    // after the reload found it missing, so keeping ollama takes the second look.
    await rm(config.file);
    const reloading = manager.reloadProviderConfig();
    await delay(MISSING_FILE_SEEN_MS);
    await replaceFile(config.file, goodFile);
    assert.equal((await reloading).configError, undefined);
    assert.equal(registry.has("ollama"), true);
    assert.equal(notifications, 2);

    // A file that stays missing was deleted: back to the built-ins, nothing to report.
    await rm(config.file);
    const deleted = await manager.reloadProviderConfig();
    assert.deepEqual(deleted.providerOrder, ["anthropic", "openai"]);
    assert.equal(deleted.configError, undefined);
    manager.dispose();
  }));

test("credential checks reject secret-looking query names and header names, and fit the wire API", () =>
  withDir(async (dir) => {
    const stores = await openStores(dir);
    const { config } = stores;
    const base = { api: "openai-completions", baseURL: "https://api.example.com/v1", defaultModel: "m" };
    for (const name of ["secret_key", "bearer", "x-api-key", "private_token", "ak"]) {
      await assert.rejects(
        config.upsert("gw", { ...base, baseURL: `${base.baseURL}?${name}=SECRET` }),
        isVaultError("invalid"),
      );
    }
    // A fragment would swallow the request path (and could hide a token).
    for (const baseURL of [`${base.baseURL}#token=SECRET`, `${base.baseURL}#`]) {
      await assert.rejects(config.upsert("gw", { ...base, baseURL }), isVaultError("invalid"));
    }
    for (const name of [
      "X-Access-Key",
      "X-Auth",
      "X-Session-Key",
      "X-Api-Token",
      "Helicone-Auth",
      "cf-aig-authorization",
      "api-key",
      "X-Goog-Api-Key",
      "Cookie",
      "X-Client-Secret",
    ]) {
      await assert.rejects(config.upsert("gw", { ...base, headers: { [name]: "sk-secret" } }), isVaultError("invalid"));
    }

    // Gateway metadata headers are fine, whatever their name.
    const headers = {
      "x-client": "albireo",
      "X-Custom": "1",
      "OpenAI-Beta": "assistants=v2",
      "x-portkey-provider": "openai",
      "Helicone-Property-Session": "s1",
    };
    const safeURL = `${base.baseURL}?api-version=2026-01-01`;
    await config.upsert("gw", { ...base, baseURL: safeURL, headers });
    assert.equal(config.get("gw").baseURL, safeURL);

    // The Anthropic SDK appends the request path after any "?", so those endpoints take none.
    for (const baseURL of [safeURL, `${base.baseURL}?`]) {
      await assert.rejects(
        config.upsert("claude-gw", { api: "anthropic-messages", baseURL, defaultModel: "m" }),
        isVaultError("invalid"),
      );
    }
    const manager = new SecretManager(stores);
    await assert.rejects(manager.setProvider({ provider: "anthropic", baseURL: safeURL }), isVaultError("invalid"));
    await manager.setProvider({ provider: "gw", baseURL: safeURL });

    assert.equal(manager.status().providers.gw.headers["x-client"], "••••");
    manager.dispose();
  }));

test("a provider is only built with a base URL that passes today's checks", () =>
  withDir(async (dir) => {
    const stores = await openStores(dir, {
      providers: { gw: local },
      keys: { gw: { baseURL: "https://gw.example/v1?api-version=1" } },
    });
    const { config, registry, vault } = stores;
    const manager = new SecretManager(stores);
    assert.ok(!(registry.get("gw") instanceof UnconfiguredProvider));
    assert.equal(manager.status().providers.gw.configured, true);
    assert.equal(manager.status().providers.gw.problem, undefined);

    // Switching the wire API keeps the vault override, which anthropic-messages can't use.
    const status = await manager.upsertProviderConfig({ id: "gw", ...local, api: "anthropic-messages" });
    const provider = registry.get("gw");
    assert.ok(provider instanceof UnconfiguredProvider);
    assert.match(provider.reason, /query string/);
    // Status and the CLI's readiness check say the same, instead of a provider that looks ready.
    assert.equal(status.providers.gw.configured, false);
    assert.equal(status.providers.gw.problem, provider.reason);
    assert.deepEqual(providerProblem(vault, config.get("gw")), { cause: "base-url", message: provider.reason });
    manager.dispose();
  }));

test("a stored base URL override is shown with non-version query values, user info and fragments masked", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" };
    const { config } = await openStores(dir, { providers: { gw: entry, gw2: entry, gw3: entry } });
    // Overrides saved before these checks existed can still hold a credential, and the vault no
    // longer accepts them, so this stand-in serves them. It has just the members SecretManager
    // and the registry read.
    const legacy = {
      state: "unlocked",
      protection: "os-keychain",
      keychainLabel: "test",
      error: undefined,
      read: () => ({
        providers: {
          gw: { apiKey: KEY, baseURL: "https://gw.example/v1?api-version=1&token=SECRET" },
          gw2: { apiKey: KEY, baseURL: "https://gw.example/v1#SECRET" },
          gw3: { apiKey: KEY, baseURL: "https://user:SECRET@gw.example/v1" },
        },
        updatedAt: 0,
      }),
    };
    const registry = createVaultRegistry(legacy, {}, config);
    const manager = new SecretManager({ vault: legacy, registry, config });
    const status = manager.status();
    assert.equal(status.providers.gw.baseURL, "https://gw.example/v1?api-version=1&token=••••");
    assert.equal(status.providers.gw2.baseURL, "https://gw.example/v1#••••");
    // Masked, not dropped, so the URL shown still explains why it is refused.
    assert.equal(status.providers.gw3.baseURL, "https://••••@gw.example/v1");
    assert.match(status.providers.gw3.problem, /must not embed credentials/);
    assert.ok(!JSON.stringify(status).includes("SECRET"));
    // And the registry refuses to send requests there.
    for (const id of ["gw", "gw2", "gw3"]) assert.ok(registry.get(id) instanceof UnconfiguredProvider);
    manager.dispose();
  }));

test("a save waits for a reload that is still reading the file, so that reload can't undo it", () =>
  withDir(async (dir) => {
    const stores = await openStores(dir, { providers: { ollama: local } });
    const { config, registry } = stores;
    const manager = new SecretManager(stores);
    const text = await readFile(config.file, "utf8");

    // A missing file holds the reload in its second look, so it is still running when the file is
    // back and the save starts; the save itself would be done in a few milliseconds.
    await rm(config.file);
    let reloaded = false;
    const reloading = manager.reloadProviderConfig().then(() => {
      reloaded = true;
    });
    await delay(MISSING_FILE_SEEN_MS);
    await replaceFile(config.file, text);
    await manager.upsertProviderConfig({ id: "gw", ...local, baseURL: "https://gw.example/v1" });
    assert.equal(reloaded, true, "the save must not run while the reload is in progress");
    await reloading;
    assert.equal(config.has("gw"), true);
    assert.equal(registry.has("gw"), true);
    manager.dispose();
  }));

test("keeping the active provider is not fooled by IDs that match Object.prototype members", () =>
  withDir(async (dir) => {
    const stores = await openStores(dir, { providers: { constructor: local } });
    const session = sessionOn(stores.registry, "constructor", dir);
    const manager = new SecretManager({ ...stores, session });
    await writeFile(stores.config.file, JSON.stringify({ providers: {} }));
    const status = await manager.reloadProviderConfig();
    assert.match(status.configError, /Active provider "constructor" is no longer in providers.json/);
    assert.equal(stores.registry.has("constructor"), true);
    session.refreshProvider();
    manager.dispose();
  }));

test("changing the active provider's config applies to the session", () =>
  withDir(async (dir) => {
    const stores = await openStores(dir, { providers: { gw: { ...local, defaultModel: "m1" } } });
    const session = sessionOn(stores.registry, "gw", dir);
    const manager = new SecretManager({ ...stores, session });
    assert.equal(session.model, "m1");
    await manager.upsertProviderConfig({ id: "gw", ...local, defaultModel: "m2" });
    assert.equal(session.model, "m2");
    manager.dispose();
  }));

test("common metadata headers are accepted; the status view masks every header value but keeps null", () =>
  withDir(async (dir) => {
    const stores = await openStores(dir, {
      providers: {
        openrouter: {
          api: "openai-completions",
          baseURL: "https://openrouter.example/api/v1",
          defaultModel: "m",
          headers: { "HTTP-Referer": "https://app.example", "X-Title": "Albireo", authorization: null },
          models: [{ id: "m", headers: { "anthropic-beta": "beta-flag" } }],
        },
      },
    });
    const status = new SecretManager(stores).status();
    const view = status.providers.openrouter;
    assert.deepEqual(view.headers, { "HTTP-Referer": "••••", "X-Title": "••••", authorization: null });
    assert.deepEqual(view.models[0].headers, { "anthropic-beta": "••••" });
    assert.ok(!JSON.stringify(status).includes("beta-flag"));
    assert.ok(!JSON.stringify(status).includes("app.example"));
  }));

test("one invalid entry in providers.json does not hide the others", () =>
  withDir(async (dir) => {
    const { config } = await openStores(dir, {
      providers: { ollama: local, gw: { ...local, headers: { "X-Secret-Token": "s" } } },
    });
    assert.deepEqual(config.ids(), ["anthropic", "openai", "ollama"]);
    assert.match(config.error, /Header "X-Secret-Token" is not allowed/);
    // Writing the file back would drop the invalid entry, so writes still ask for a fix first.
    await assert.rejects(config.upsert("other", local), isVaultError("corrupt"));

    // An entry that turns invalid on reload keeps its last good version.
    await writeFile(config.file, JSON.stringify({ providers: { ollama: local } }));
    await config.reload();
    assert.equal(config.error, undefined);
    await writeFile(config.file, JSON.stringify({ providers: { ollama: { ...local, baseURL: "ftp://nope" } } }));
    assert.equal(await config.reload(), true);
    assert.match(config.error, /must start with http/);
    assert.equal(config.get("ollama").baseURL, local.baseURL);
  }));

test("re-adding a removed provider with the same definition updates registry, session, and listeners", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" };
    const stores = await openStores(dir, { providers: { gw: entry }, keys: { gw: { apiKey: KEY } } });
    const session = sessionOn(stores.registry, "gw", dir);
    const manager = new SecretManager({ ...stores, session });
    let notifications = 0;
    manager.onChange(() => {
      notifications++;
    });

    try {
      await writeFile(stores.config.file, JSON.stringify({ providers: {} }));
      const readded = await manager.upsertProviderConfig({ id: "gw", ...entry });
      assert.equal(readded.providers.gw.hasKey, false);
      assert.equal(readded.providers.gw.configured, false);
      assert.equal(notifications, 1);
      assert.ok(stores.registry.get("gw") instanceof UnconfiguredProvider);
      assert.equal(stores.vault.read().providers.gw, undefined);

      // Even if writing providers.json fails after beforeCreate cleared the vault, registry/session stay in sync.
      await manager.setProvider({ provider: "gw", apiKey: KEY });
      assert.ok(!(stores.registry.get("gw") instanceof UnconfiguredProvider));
      const failingConfig = {
        watch: (w) => stores.config.watch(w),
        list: () => stores.config.list(),
        get retained() {
          return stores.config.retained;
        },
        get error() {
          return stores.config.error;
        },
        async upsert(_id, _entry, opts) {
          await opts?.beforeCreate?.();
          throw new Error("disk full");
        },
      };
      const failingManager = new SecretManager({
        vault: stores.vault,
        registry: stores.registry,
        config: failingConfig,
        session,
      });
      let failNotifications = 0;
      failingManager.onChange(() => {
        failNotifications++;
      });
      try {
        await assert.rejects(failingManager.upsertProviderConfig({ id: "gw", ...entry }), /disk full/);
      } finally {
        failingManager.dispose();
      }
      assert.ok(stores.registry.get("gw") instanceof UnconfiguredProvider);
      assert.equal(stores.vault.read().providers.gw, undefined);
      assert.equal(failNotifications, 1);
    } finally {
      manager.dispose();
    }
  }));

test("deleting a custom provider re-syncs registry with vault updates picked up from another process", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    await writeFile(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { foo: local, bar: local } }));
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector });
    await vault.initialize();
    await vault.updateProvider("foo", { apiKey: KEY });
    const registry = createVaultRegistry(vault, {}, config);
    const manager = new SecretManager({ vault, registry, config });

    try {
      assert.ok(registry.get("openai") instanceof UnconfiguredProvider);

      const other = await VaultStore.open({ dir, protector });
      await other.updateProvider("openai", { apiKey: KEY });

      const afterSet = await manager.deleteCustomProvider("foo");
      assert.equal(afterSet.providers.openai.configured, true);
      assert.ok(!(registry.get("openai") instanceof UnconfiguredProvider));

      await other.updateProvider("openai", { clearApiKey: true });

      const afterClear = await manager.deleteCustomProvider("bar");
      assert.equal(afterClear.providers.openai.configured, false);
      assert.ok(registry.get("openai") instanceof UnconfiguredProvider);
    } finally {
      manager.dispose();
    }
  }));

test("adding or deleting a custom provider is refused when another process created the vault meanwhile", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" };
    await writeFile(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { gw: entry } }));
    const protector = new MemoryKeyProtector();
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector });
    const registry = createVaultRegistry(vault, {}, config);
    const manager = new SecretManager({ vault, registry, config });

    try {
      const other = await VaultStore.open({ dir, protector });
      await other.initialize();
      await other.updateProvider("gw", { apiKey: KEY });

      await assert.rejects(manager.deleteCustomProvider("gw"), isVaultError("unavailable"));
      assert.equal(config.has("gw"), true);

      await writeFile(config.file, JSON.stringify({ providers: {} }));
      await assert.rejects(manager.upsertProviderConfig({ id: "gw", ...entry }), isVaultError("unavailable"));
      const onDisk = JSON.parse(await readFile(config.file, "utf8"));
      assert.equal(onDisk.providers.gw, undefined);
    } finally {
      manager.dispose();
    }
  }));
