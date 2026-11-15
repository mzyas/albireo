import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, Session } from "@albireo/core";
import { newKdf, parseEnvelope, seal, unseal } from "../dist/crypto.js";
import {
  createVaultRegistry,
  DpapiProtector,
  MemoryKeyProtector,
  maskApiKey,
  redactError,
  SecretManager,
  UnconfiguredProvider,
  VaultError,
  VaultStore,
} from "../dist/index.js";

const KEY = "sk-ant-test-0123456789abcdefWXYZ";
const PASS = "correct horse battery staple";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "albireo-vault-"));
}

async function withDir(fn) {
  const dir = await tempDir();
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isVaultError = (code) => (err) => err instanceof VaultError && err.code === code;

test("passphrase vault: round trip, lock, wrong passphrase", () =>
  withDir(async (dir) => {
    const store = await VaultStore.open({ dir, protector: null });
    assert.equal(store.state, "uninitialized");
    assert.equal(store.protection, "passphrase");
    await store.initialize(PASS);
    await store.updateProvider("anthropic", { apiKey: KEY, model: "claude-x" });
    assert.equal(store.read().providers.anthropic.apiKey, KEY);

    const again = await VaultStore.open({ dir, protector: null });
    assert.equal(again.state, "locked");
    await assert.rejects(again.unlock("wrong passphrase!"), isVaultError("bad_key"));
    assert.equal(again.state, "locked");
    await again.unlock(PASS);
    assert.deepEqual(again.read().providers.anthropic, { apiKey: KEY, model: "claude-x" });

    again.lock();
    assert.equal(again.state, "locked");
    assert.throws(() => again.read(), isVaultError("locked"));
  }));

test("os-keychain vault reopens unlocked; a missing master key leaves it locked with an error", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const store = await VaultStore.open({ dir, protector });
    assert.equal(store.protection, "os-keychain");
    await store.initialize();
    await store.updateProvider("openai", { apiKey: KEY });

    const again = await VaultStore.open({ dir, protector });
    assert.equal(again.state, "unlocked");
    assert.equal(again.read().providers.openai.apiKey, KEY);

    const elsewhere = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    assert.equal(elsewhere.state, "locked");
    assert.match(elsewhere.error, /master key is missing/);
  }));

test("without an OS credential store the vault falls back to passphrase mode", () =>
  withDir(async (dir) => {
    const store = await VaultStore.open({ dir, protector: new MemoryKeyProtector(false) });
    assert.equal(store.protection, "passphrase");
    await assert.rejects(store.initialize(), isVaultError("unavailable"));
    await assert.rejects(store.initialize("short"), isVaultError("invalid"));
    await store.initialize(PASS);
    assert.equal(store.state, "unlocked");
  }));

test("the file on disk holds no plaintext, and writes leave no temp files", () =>
  withDir(async (dir) => {
    const store = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    await store.initialize();
    await store.updateProvider("anthropic", { apiKey: KEY, baseURL: "https://proxy.example/v1" });
    const text = await readFile(store.file, "utf8");
    assert.ok(!text.includes(KEY));
    assert.ok(!text.includes("proxy.example"));
    assert.deepEqual(await readdir(dir), ["vault.enc.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(store.file)).mode & 0o777, 0o600);
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
  }));

test("every write uses a fresh IV", () =>
  withDir(async (dir) => {
    const store = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    await store.initialize();
    const iv1 = JSON.parse(await readFile(store.file, "utf8")).iv;
    await store.updateProvider("openai", { model: "m" });
    const iv2 = JSON.parse(await readFile(store.file, "utf8")).iv;
    assert.notEqual(iv1, iv2);
  }));

test("tampering with the ciphertext or the header fails authentication", () => {
  const key = Buffer.alloc(32, 7);
  const kdf = newKdf("os-keychain");
  const env = seal(key, kdf, Buffer.from("secret payload"));
  assert.equal(unseal(key, env).toString(), "secret payload");

  const ct = Buffer.from(env.ciphertext, "base64");
  ct[0] ^= 1;
  assert.throws(() => unseal(key, { ...env, ciphertext: ct.toString("base64") }), isVaultError("bad_key"));
  // Same key, different header: only the AAD can catch this.
  assert.throws(() => unseal(key, { ...env, kdf: newKdf("os-keychain") }), isVaultError("bad_key"));
  assert.throws(
    () => unseal(key, { ...env, kdf: { ...newKdf("passphrase"), salt: kdf.salt } }),
    isVaultError("bad_key"),
  );
});

test("a tampered file is rejected before any key derivation", () =>
  withDir(async (dir) => {
    const store = await VaultStore.open({ dir, protector: null });
    await store.initialize(PASS);
    const env = JSON.parse(await readFile(store.file, "utf8"));
    assert.throws(
      () => parseEnvelope(JSON.stringify({ ...env, kdf: { ...env.kdf, scrypt: { N: 2 ** 30, r: 8, p: 1 } } })),
      isVaultError("corrupt"),
    );
    assert.throws(() => parseEnvelope(JSON.stringify({ ...env, version: 2 })), isVaultError("corrupt"));

    await writeFile(store.file, "not json");
    const broken = await VaultStore.open({ dir, protector: null });
    assert.equal(broken.state, "locked");
    assert.equal(broken.protection, "unknown");
    assert.ok(broken.error.includes(store.file));
    await assert.rejects(broken.unlock(PASS), isVaultError("corrupt"));
    await assert.rejects(broken.initialize(PASS), isVaultError("invalid"));
  }));

test("updates validate input and serialize", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const store = await VaultStore.open({ dir, protector });
    await store.initialize();
    await assert.rejects(store.updateProvider("anthropic", { baseURL: "ftp://x" }), isVaultError("invalid"));
    await assert.rejects(store.updateProvider("anthropic", { baseURL: "https://u:p@x" }), isVaultError("invalid"));
    await assert.rejects(store.updateProvider("anthropic", { apiKey: "sk with space" }), isVaultError("invalid"));
    await assert.rejects(store.updateProvider("other", { apiKey: KEY }), isVaultError("invalid"));

    await Promise.all([
      store.updateProvider("anthropic", { apiKey: KEY }),
      store.updateProvider("openai", { apiKey: `${KEY}-o` }),
      store.updateProvider("anthropic", { model: "m1" }),
    ]);
    // Reopen from disk: no update was lost to a concurrent write.
    const read = (await VaultStore.open({ dir, protector })).read();
    assert.deepEqual(read.providers.anthropic, { apiKey: KEY, model: "m1" });
    assert.equal(read.providers.openai.apiKey, `${KEY}-o`);

    await store.updateProvider("anthropic", { clearApiKey: true, model: "" });
    assert.equal(store.read().providers.anthropic, undefined);
  }));

test("maskApiKey only ever shows a few characters", () => {
  assert.equal(maskApiKey(undefined), null);
  assert.equal(maskApiKey(""), null);
  assert.equal(maskApiKey("short"), "••••");
  assert.equal(maskApiKey("123456789012345"), "••••");
  assert.equal(maskApiKey("sk-proj-abcdefgh1234a1b2"), "sk-••••a1b2");
});

test("redactError removes the key from error messages", () => {
  const err = redactError(new Error(`401 invalid x-api-key ${KEY}`), KEY);
  assert.ok(!err.message.includes(KEY));
  assert.match(err.message, /sk-••••WXYZ/);
  const untouched = new Error("plain");
  assert.equal(redactError(untouched, KEY), untouched);
});

test("the vault registry never falls back to API keys in the environment", () =>
  withDir(async (dir) => {
    const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
    process.env.ANTHROPIC_API_KEY = "sk-env-anthropic-should-not-be-used";
    process.env.OPENAI_API_KEY = "sk-env-openai-should-not-be-used";
    try {
      const store = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
      const registry = createVaultRegistry(store);
      for (const id of ["anthropic", "openai"]) {
        const provider = registry.get(id);
        assert.ok(provider instanceof UnconfiguredProvider);
        await assert.rejects(
          provider.runTurn({}, () => {}),
          /not configured in the Albireo vault/,
        );
      }
    } finally {
      if (saved.a === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.o === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.o;
    }
  }));

test("a locked vault yields placeholder providers that say so", () =>
  withDir(async (dir) => {
    const store = await VaultStore.open({ dir, protector: null });
    await store.initialize(PASS);
    await store.updateProvider("openai", { apiKey: KEY });
    store.lock();
    const provider = createVaultRegistry(store).get("openai");
    await assert.rejects(
      provider.runTurn({}, () => {}),
      /vault is locked/,
    );
  }));

test("SecretManager rebuilds providers and refreshes the session, deferring while a turn runs", () =>
  withDir(async (dir) => {
    const built = [];
    let gate = null;
    const factories = {
      anthropic: (config) => {
        built.push(config);
        return {
          id: "anthropic",
          defaultModel: config.model ?? "claude-default",
          async runTurn() {
            if (gate) await gate;
            return {
              message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          },
        };
      },
    };
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
    const registry = createVaultRegistry(vault, factories);
    const cwd = await tempDir();
    const session = new Session({ providers: registry, provider: "anthropic", tools: builtinTools, cwd });
    const manager = new SecretManager({ vault, registry, session, factories });
    let changes = 0;
    manager.onChange(() => changes++);

    const status = await manager.setProvider({ provider: "anthropic", apiKey: KEY, model: "claude-custom" });
    assert.equal(status.state, "unlocked");
    assert.equal(status.protection, "os-keychain");
    assert.deepEqual(status.providers.anthropic, { hasKey: true, keyHint: "sk-••••WXYZ", model: "claude-custom" });
    assert.ok(!JSON.stringify(status).includes(KEY));
    assert.equal(session.model, "claude-custom");
    assert.equal(changes, 1);

    await session.send("hi");
    assert.equal(built.length, 1);
    assert.equal(built[0].apiKey, KEY);
    assert.equal(built[0].baseURL, "https://api.anthropic.com");

    // A change during a turn is applied once the turn ends.
    let release;
    gate = new Promise((r) => {
      release = r;
    });
    const turn = session.send("again");
    const during = await manager.setProvider({ provider: "anthropic", model: "later" });
    assert.equal(during.refreshPending, true);
    assert.equal(session.model, "claude-custom");
    release();
    await turn;
    assert.equal(manager.status().refreshPending, false);
    assert.equal(session.model, "later");
    assert.equal(changes, 3); // the save, then the deferred refresh

    await assert.rejects(manager.setProvider({ provider: "nope" }), isVaultError("invalid"));
    await assert.rejects(manager.lock(), isVaultError("invalid"));
    manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }));

test("SecretManager: passphrase vault is created and unlocked through unlock()", () =>
  withDir(async (dir) => {
    const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector(false) });
    const registry = createVaultRegistry(vault);
    const manager = new SecretManager({ vault, registry });
    await assert.rejects(manager.setProvider({ provider: "openai", apiKey: KEY }), isVaultError("unavailable"));
    await manager.unlock({ passphrase: PASS });
    await manager.setProvider({ provider: "openai", apiKey: KEY });
    assert.ok(!(registry.get("openai") instanceof UnconfiguredProvider));
    const locked = await manager.lock();
    assert.equal(locked.state, "locked");
    assert.equal(locked.providers.openai.hasKey, false);
    assert.ok(registry.get("openai") instanceof UnconfiguredProvider);
    await assert.rejects(manager.unlock({ passphrase: "nope nope nope" }), isVaultError("bad_key"));
    await manager.unlock({ passphrase: PASS });
    assert.equal(manager.status().providers.openai.hasKey, true);
  }));

test("a write merges with what another process saved since this store was opened", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const kernel = await VaultStore.open({ dir, protector });
    await kernel.initialize();
    await kernel.updateProvider("anthropic", { apiKey: KEY });

    // e.g. `albireo keys set openai` while the kernel keeps running
    const cli = await VaultStore.open({ dir, protector });
    await cli.updateProvider("openai", { apiKey: "sk-openai-0123456789abcdef" });

    await kernel.updateProvider("anthropic", { model: "claude-x" });
    const merged = (await VaultStore.open({ dir, protector })).read().providers;
    assert.equal(merged.openai.apiKey, "sk-openai-0123456789abcdef");
    assert.deepEqual(merged.anthropic, { apiKey: KEY, model: "claude-x" });
    assert.equal(kernel.read().providers.openai.apiKey, "sk-openai-0123456789abcdef");
  }));

test("initialize refuses to overwrite a vault another process created meanwhile", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const stale = await VaultStore.open({ dir, protector });
    const other = await VaultStore.open({ dir, protector });
    await other.initialize();
    await other.updateProvider("anthropic", { apiKey: KEY });
    const file = path.join(dir, "vault.enc.json");
    const before = await readFile(file, "utf8");

    await assert.rejects(stale.initialize(), isVaultError("invalid"));
    await assert.rejects(stale.initialize(PASS), isVaultError("invalid"));
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal((await VaultStore.open({ dir, protector })).read().providers.anthropic.apiKey, KEY);
  }));

test("a write fails instead of clobbering a vault that was replaced on disk", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const store = await VaultStore.open({ dir, protector: null });
    await store.initialize(PASS);
    await rm(path.join(dir, "vault.enc.json"));
    const other = await VaultStore.open({ dir, protector });
    await other.initialize();
    await assert.rejects(store.updateProvider("anthropic", { apiKey: KEY }), isVaultError("invalid"));
    assert.equal((await VaultStore.open({ dir, protector })).read().providers.anthropic, undefined);
  }));

test("Windows DPAPI protector round-trips a key", { skip: process.platform !== "win32" }, () =>
  withDir(async (dir) => {
    const protector = new DpapiProtector(path.join(dir, "master.dpapi"));
    assert.equal(await protector.available(), true);
    assert.equal(await protector.load(), null);
    const key = Buffer.alloc(32, 9);
    await protector.save(key);
    const wrapped = await readFile(path.join(dir, "master.dpapi"), "utf8");
    assert.ok(!wrapped.includes(key.toString("base64")));
    assert.ok((await protector.load()).equals(key));
    await protector.clear();
    assert.equal(await protector.load(), null);
  }),
);
