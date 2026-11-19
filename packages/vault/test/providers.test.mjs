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
