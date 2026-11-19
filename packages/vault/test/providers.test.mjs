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

test("a provider deleted while locked has its vault entry purged on unlock", () =>
  withDir(async (dir) => {
    const passphrase = "a long enough passphrase";
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("ollama", {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      defaultModel: "q",
      auth: "none",
    });
    const vault = await VaultStore.open({ dir, protector: null });
    await vault.initialize(passphrase);
    await vault.updateProvider("ollama", { apiKey: KEY });
    const registry = createVaultRegistry(vault, {}, config);
    const manager = new SecretManager({ vault, registry, config });

    vault.lock();
    await manager.deleteCustomProvider("ollama");
    assert.equal(vault.state, "locked");
    assert.equal(config.has("ollama"), false);

    await manager.unlock({ passphrase });
    assert.equal(vault.state, "unlocked");
    assert.equal(vault.read().providers.ollama, undefined);
  }));

test("a deferred config reload is applied after switching away from a removed active provider", () =>
  withDir(async (dir) => {
    const ollama = {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      defaultModel: "q",
      auth: "none",
    };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("ollama", ollama);
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-deferred-"));
    try {
      const session = new Session({ providers: registry, provider: "ollama", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });

      await writeFile(
        config.file,
        JSON.stringify({
          providers: {
            newgw: { api: "openai-completions", baseURL: "https://gw.example/v1", defaultModel: "m", auth: "none" },
          },
        }),
      );
      const blocked = await manager.reloadProviderConfig();
      assert.match(blocked.configError, /Active provider "ollama" was removed/);
      assert.deepEqual(blocked.providerOrder, ["anthropic", "openai", "ollama"]);
      assert.equal(registry.has("newgw"), false);

      session.switchProvider("anthropic");
      const applied = await manager.reloadProviderConfig();
      assert.equal(applied.configError, undefined);
      assert.deepEqual(applied.providerOrder, ["anthropic", "openai", "newgw"]);
      assert.equal(registry.has("newgw"), true);
      assert.equal(registry.has("ollama"), false);
      session.switchProvider("newgw");
      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("reload keeps the last good config when the file is briefly corrupt", () =>
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
    manager.dispose();
  }));

test("credential detection rejects unknown query names and arbitrary header names", () =>
  withDir(async (dir) => {
    const store = await ProviderConfigStore.open({ dir });
    const base = { api: "openai-completions", baseURL: "https://api.example.com/v1", defaultModel: "m" };
    for (const name of ["secret_key", "bearer", "x-api-key", "private_token", "ak"]) {
      await assert.rejects(
        store.upsert("gw", { ...base, baseURL: `${base.baseURL}?${name}=SECRET` }),
        isVaultError("invalid"),
      );
    }
    for (const name of ["X-Access-Key", "X-Auth", "X-Session-Key", "X-Custom"]) {
      await assert.rejects(store.upsert("gw", { ...base, headers: { [name]: "sk-secret" } }), isVaultError("invalid"));
    }

    const safeURL = `${base.baseURL}?api-version=2026-01-01`;
    await store.upsert("gw", { ...base, baseURL: safeURL, headers: { "x-client": "albireo" } });
    assert.equal(store.get("gw").baseURL, safeURL);

    const registry = createVaultRegistry(
      await VaultStore.open({ dir, protector: new MemoryKeyProtector() }),
      {},
      store,
    );
    const manager = new SecretManager({
      vault: await VaultStore.open({ dir, protector: new MemoryKeyProtector() }),
      registry,
      config: store,
    });
    assert.equal(manager.status().providers.gw.headers["x-client"], "••••");
  }));

test("upsertProviderConfig refuses to change the active provider", () =>
  withDir(async (dir) => {
    const config = await ProviderConfigStore.open({ dir });
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, {}, config);
    const cwd = await mkdtemp(path.join(tmpdir(), "albireo-active-"));
    try {
      const session = new Session({ providers: registry, provider: "anthropic", tools: builtinTools, cwd });
      const manager = new SecretManager({ vault, registry, config, session });
      await assert.rejects(
        manager.upsertProviderConfig({ id: "anthropic", baseURL: "https://proxy.example/v1" }),
        isVaultError("invalid"),
      );
      manager.dispose();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }));

test("a pending delete does not remove the key of a re-added provider on unlock", () =>
  withDir(async (dir) => {
    const passphrase = "a long enough passphrase";
    const entry = {
      api: "openai-completions",
      baseURL: "http://127.0.0.1:11434/v1",
      defaultModel: "q",
      auth: "none",
    };
    const config = await ProviderConfigStore.open({ dir });
    await config.upsert("ollama", entry);
    const vault = await VaultStore.open({ dir, protector: null });
    await vault.initialize(passphrase);
    await vault.updateProvider("ollama", { apiKey: KEY });
    const manager = new SecretManager({ vault, registry: createVaultRegistry(vault, {}, config), config });

    vault.lock();
    await manager.deleteCustomProvider("ollama");
    await config.upsert("ollama", entry);
    await manager.unlock({ passphrase });
    assert.equal(vault.read().providers.ollama.apiKey, KEY);
  }));
