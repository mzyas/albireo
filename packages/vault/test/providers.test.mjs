import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, Session } from "@albireo/core";
import {
  CUSTOM_ANTHROPIC_COMPAT,
  createVaultRegistry,
  DEFAULT_ANTHROPIC_COMPAT,
  DEFAULT_OPENAI_COMPAT,
  isProviderReady,
  MemoryKeyProtector,
  PROVIDERS_FILE,
  ProviderConfigStore,
  SecretManager,
  UnconfiguredProvider,
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
    assert.equal(isProviderReady(vault, "ollama", config), true);
    assert.equal(isProviderReady(vault, "deepseek", config), false);

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
    assert.equal(isProviderReady(vault, "deepseek", config), true);

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

test("a locked vault refuses deleting and adding custom providers, so no key can outlive or leak into one", () =>
  withDir(async (dir) => {
    const passphrase = "a long enough passphrase";
    const entry = { api: "openai-completions", baseURL: "https://gw-a.example/v1", defaultModel: "q" };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("gw", entry);
    const vault = await VaultStore.open({ dir, protector: null });
    await vault.initialize(passphrase);
    await vault.updateProvider("gw", { apiKey: KEY, baseURL: "https://gw-a.example/override" });
    const manager = new SecretManager({ vault, registry: createVaultRegistry(vault, {}, config), config });

    vault.lock();
    await assert.rejects(manager.deleteCustomProvider("gw"), isVaultError("locked"));
    assert.equal(config.has("gw"), true);
    await assert.rejects(manager.upsertProviderConfig({ id: "new", ...entry }), isVaultError("locked"));
    assert.equal(config.has("new"), false);
    // A key for an existing provider can't be saved either, and then its entry isn't written.
    await assert.rejects(
      manager.upsertProviderConfig({ id: "openai", baseURL: "https://proxy.example/v1", apiKey: KEY }),
      isVaultError("locked"),
    );
    assert.equal(config.rawEntry("openai"), undefined);

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

test("re-adding a provider removed outside the panel does not pick up its old key or override", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw-a.example/v1", defaultModel: "q" };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("gw", entry);
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    await vault.initialize();
    await vault.updateProvider("gw", { apiKey: KEY, baseURL: "https://old.example/v1" });
    await vault.updateProvider("anthropic", { apiKey: KEY });
    const manager = new SecretManager({ vault, registry: createVaultRegistry(vault, {}, config), config });

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

test("an initial key is saved with the entry; a key that can't be saved leaves no entry", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" };
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const manager = new SecretManager({ vault, registry: createVaultRegistry(vault, {}, config), config });

    // A bad entry fails before the vault is touched (not even created).
    await assert.rejects(
      manager.upsertProviderConfig({ id: "gw", api: "openai-completions", apiKey: KEY }),
      isVaultError("invalid"),
    );
    assert.equal(vault.state, "uninitialized");

    await assert.rejects(
      manager.upsertProviderConfig({ id: "gw", ...entry, apiKey: "has space" }),
      isVaultError("invalid"),
    );
    assert.equal(config.has("gw"), false);
    await assert.rejects(
      manager.upsertProviderConfig({ id: "openai", baseURL: "https://proxy.example/v1", apiKey: "has space" }),
      isVaultError("invalid"),
    );
    assert.equal(config.rawEntry("openai"), undefined);

    const saved = await manager.upsertProviderConfig({ id: "gw", ...entry, apiKey: KEY });
    assert.equal(saved.providers.gw.hasKey, true);
    assert.ok(!JSON.stringify(saved).includes(KEY));
    assert.ok(!(await readFile(config.file, "utf8")).includes(KEY));
    assert.equal(vault.read().providers.gw.apiKey, KEY);
    manager.dispose();
  }));

test("deleting a provider removes its entry before its key, so a file that needs fixing loses nothing", () =>
  withDir(async (dir) => {
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("gw", { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    await vault.initialize();
    await vault.updateProvider("gw", { apiKey: KEY });
    const manager = new SecretManager({ vault, registry: createVaultRegistry(vault, {}, config), config });

    const file = JSON.parse(await readFile(config.file, "utf8"));
    file.providers.bad = { api: "nope" };
    await writeFile(config.file, JSON.stringify(file));
    await manager.reloadProviderConfig();

    await assert.rejects(manager.deleteCustomProvider("gw"), isVaultError("corrupt"));
    assert.equal(config.has("gw"), true);
    assert.equal(vault.read().providers.gw.apiKey, KEY);
    manager.dispose();
  }));

test("a file that drops the active provider keeps it defined until the session switches away", () =>
  withDir(async (dir) => {
    const ollama = {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      defaultModel: "q",
      auth: "none",
    };
    const newgw = { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "m", auth: "none" };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("ollama", ollama);
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-retained-"));
    try {
      const session = new Session({ providers: registry, provider: "ollama", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });
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

      // Writes go ahead and keep it too.
      await manager.upsertProviderConfig({ id: "other", ...ollama, baseURL: "https://other.example/v1" });
      assert.equal(registry.has("ollama"), true);
      session.refreshProvider();

      // Switching away drops it without waiting for another GET /secrets.
      const dropped = new Promise((resolve) => manager.onChange(resolve));
      session.switchProvider("anthropic");
      await dropped;
      const status = manager.status();
      assert.equal(status.configError, undefined);
      assert.deepEqual(status.providerOrder, ["anthropic", "openai", "newgw", "other"]);
      assert.equal(registry.has("ollama"), false);
      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("a switch made while a write is in flight still keeps the new active provider defined", () =>
  withDir(async (dir) => {
    const foo = { api: "openai-completions", baseURL: "http://127.0.0.1:11434/v1", defaultModel: "q", auth: "none" };

    const store = await ProviderConfigStore.open({ dir });
    await store.upsert("foo", foo);
    let active = "anthropic";
    store.retain(() => active);
    // Another process drops foo before this one has reloaded.
    await writeFile(store.file, JSON.stringify({ providers: {} }));
    const writing = store.upsert("bar", foo);
    active = "foo";
    await writing;
    assert.equal(store.has("foo"), true);
    assert.equal(store.retained, "foo");

    await writeFile(store.file, JSON.stringify({ providers: { foo } }));
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-inflight-"));
    try {
      const session = new Session({ providers: registry, provider: "anthropic", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });
      await writeFile(config.file, JSON.stringify({ providers: {} }));
      const adding = manager.upsertProviderConfig({ id: "bar", ...foo });
      session.switchProvider("foo");
      await adding;
      assert.equal(registry.has("foo"), true);
      assert.equal(registry.has("bar"), true);
      session.refreshProvider();
      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("reload keeps the last good config when the file is briefly corrupt or missing", () =>
  withDir(async (dir) => {
    const ollama = {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      defaultModel: "q",
      auth: "none",
    };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("ollama", ollama);
    const goodFile = JSON.stringify({ providers: { ollama: config.rawEntry("ollama") } });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const manager = new SecretManager({ vault, registry, config });
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

    // Editors that save by renaming leave the file missing for a moment.
    await rm(config.file);
    const missing = await manager.reloadProviderConfig();
    assert.match(missing.configError, /is missing/);
    assert.equal(registry.has("ollama"), true);
    await writeFile(config.file, goodFile);
    assert.equal((await manager.reloadProviderConfig()).configError, undefined);
    manager.dispose();
  }));

test("credential checks reject secret-looking query names and header names, and fit the wire API", () =>
  withDir(async (dir) => {
    const store = await ProviderConfigStore.open({ dir });
    const base = { api: "openai-completions", baseURL: "https://api.example.com/v1", defaultModel: "m" };
    for (const name of ["secret_key", "bearer", "x-api-key", "private_token", "ak"]) {
      await assert.rejects(
        store.upsert("gw", { ...base, baseURL: `${base.baseURL}?${name}=SECRET` }),
        isVaultError("invalid"),
      );
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
      await assert.rejects(store.upsert("gw", { ...base, headers: { [name]: "sk-secret" } }), isVaultError("invalid"));
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
    await store.upsert("gw", { ...base, baseURL: safeURL, headers });
    assert.equal(store.get("gw").baseURL, safeURL);

    // The Anthropic SDK appends the request path after the query, so those endpoints take none.
    const anthropic = { api: "anthropic-messages", baseURL: safeURL, defaultModel: "m" };
    await assert.rejects(store.upsert("claude-gw", anthropic), isVaultError("invalid"));
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const manager = new SecretManager({ vault, registry: createVaultRegistry(vault, {}, store), config: store });
    await assert.rejects(manager.setProvider({ provider: "anthropic", baseURL: safeURL }), isVaultError("invalid"));
    await manager.setProvider({ provider: "gw", baseURL: safeURL });

    assert.equal(manager.status().providers.gw.headers["x-client"], "••••");
    manager.dispose();
  }));

test("a stored base URL override is shown with non-version query values masked", () =>
  withDir(async (dir) => {
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("gw", { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "q" });
    // Overrides saved before query strings were checked can still hold a credential.
    const legacy = {
      state: "unlocked",
      protection: "os-keychain",
      keychainLabel: "test",
      error: undefined,
      read: () => ({
        providers: { gw: { apiKey: KEY, baseURL: "https://gw.example/v1?api-version=1&token=SECRET" } },
        updatedAt: 0,
      }),
    };
    const manager = new SecretManager({ vault: legacy, registry: createVaultRegistry(legacy, {}, config), config });
    const status = manager.status();
    assert.equal(status.providers.gw.baseURL, "https://gw.example/v1?api-version=1&token=••••");
    assert.ok(!JSON.stringify(status).includes("SECRET"));
    manager.dispose();
  }));

test("a provider saved while a reload is reading the file is not dropped by that reload", () =>
  withDir(async (dir) => {
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const manager = new SecretManager({ vault, registry, config });

    const reloading = manager.reloadProviderConfig();
    const adding = manager.upsertProviderConfig({
      id: "gw",
      api: "openai-completions",
      baseURL: "https://gw.example/v1",
      defaultModel: "m",
      auth: "none",
    });
    await Promise.all([reloading, adding]);
    assert.equal(config.has("gw"), true);
    assert.equal(registry.has("gw"), true);
    manager.dispose();
  }));

test("keeping the active provider is not fooled by IDs that match Object.prototype members", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "http://127.0.0.1:11434/v1", defaultModel: "q", auth: "none" };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("constructor", entry);
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-proto-"));
    try {
      const session = new Session({ providers: registry, provider: "constructor", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });

      await writeFile(config.file, JSON.stringify({ providers: {} }));
      const status = await manager.reloadProviderConfig();
      assert.match(status.configError, /Active provider "constructor" is no longer in providers.json/);
      assert.equal(registry.has("constructor"), true);
      session.refreshProvider();
      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("changing the active provider's config applies to the session", () =>
  withDir(async (dir) => {
    const entry = { api: "openai-completions", baseURL: "http://127.0.0.1:11434/v1", auth: "none" };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("gw", { ...entry, defaultModel: "m1" });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-active-"));
    try {
      const session = new Session({ providers: registry, provider: "gw", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });
      assert.equal(session.model, "m1");

      await manager.upsertProviderConfig({ id: "gw", ...entry, defaultModel: "m2" });
      assert.equal(session.model, "m2");
      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("common metadata headers are accepted; the status view masks every header value but keeps null", () =>
  withDir(async (dir) => {
    const store = await ProviderConfigStore.open({ dir });
    await store.upsert("openrouter", {
      api: "openai-completions",
      baseURL: "https://openrouter.example/api/v1",
      defaultModel: "m",
      headers: { "HTTP-Referer": "https://app.example", "X-Title": "Albireo", authorization: null },
      models: [{ id: "m", headers: { "anthropic-beta": "beta-flag" } }],
    });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const manager = new SecretManager({ vault, registry: createVaultRegistry(vault, {}, store), config: store });
    const status = manager.status();
    const view = status.providers.openrouter;
    assert.deepEqual(view.headers, { "HTTP-Referer": "••••", "X-Title": "••••", authorization: null });
    assert.deepEqual(view.models[0].headers, { "anthropic-beta": "••••" });
    assert.ok(!JSON.stringify(status).includes("beta-flag"));
    assert.ok(!JSON.stringify(status).includes("app.example"));
  }));

test("one invalid entry in providers.json does not hide the others", () =>
  withDir(async (dir) => {
    const good = { api: "openai-completions", baseURL: "http://127.0.0.1:11434/v1", defaultModel: "q", auth: "none" };
    await writeFile(
      path.join(dir, PROVIDERS_FILE),
      JSON.stringify({ providers: { ollama: good, gw: { ...good, headers: { "X-Secret-Token": "s" } } } }),
    );
    const store = await ProviderConfigStore.open({ dir });
    assert.deepEqual(store.ids(), ["anthropic", "openai", "ollama"]);
    assert.match(store.error, /Header "X-Secret-Token" is not allowed/);
    // Writing the file back would drop the invalid entry, so writes still ask for a fix first.
    await assert.rejects(store.upsert("other", good), isVaultError("corrupt"));

    // An entry that turns invalid on reload keeps its last good version.
    await writeFile(store.file, JSON.stringify({ providers: { ollama: good } }));
    await store.reload();
    assert.equal(store.error, undefined);
    await writeFile(store.file, JSON.stringify({ providers: { ollama: { ...good, baseURL: "ftp://nope" } } }));
    assert.equal(await store.reload(), true);
    assert.match(store.error, /must start with http/);
    assert.equal(store.get("ollama").baseURL, good.baseURL);
  }));
