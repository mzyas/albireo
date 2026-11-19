import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, ScriptedProvider, Session } from "@albireo/core";
import {
  createVaultRegistry,
  MemoryKeyProtector,
  ProviderConfigStore,
  SecretManager,
  VaultStore,
} from "@albireo/vault";
import { startPanelServer } from "../dist/index.js";

const KEY = "sk-ant-server-test-0123456789abcdef";

/** Raw request so the test controls the Host header. */
function request(base, { method = "GET", pathname, token, host, body }) {
  const url = new URL(pathname, base);
  if (token !== undefined) url.searchParams.set("token", token);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { host: host ?? url.host, "content-type": "application/json" } });
    req.on("response", (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function setup({ secrets = true, extraFactories = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-server-"));
  const used = [];
  const factories = {
    anthropic: (config) => {
      used.push(config.apiKey);
      return new ScriptedProvider([{ text: "hello" }], "anthropic");
    },
    ...extraFactories,
  };
  const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
  const config = await ProviderConfigStore.open({ dir });
  const registry = createVaultRegistry(vault, factories, config);
  const session = new Session({ providers: registry, provider: "anthropic", tools: builtinTools, cwd: dir });
  const manager = secrets ? new SecretManager({ vault, registry, config, session, factories }) : undefined;
  const panel = await startPanelServer(session, { secrets: manager });
  const url = new URL(panel.url);
  const token = url.searchParams.get("token");
  return {
    base: url.origin,
    token,
    vault,
    config,
    session,
    used,
    async cleanup() {
      await panel.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("/secrets requires the token and a loopback Host", async () => {
  const s = await setup();
  try {
    assert.equal((await request(s.base, { pathname: "/secrets" })).status, 401);
    assert.equal((await request(s.base, { pathname: "/secrets", token: "wrong" })).status, 401);
    assert.equal((await request(s.base, { pathname: "/secrets", token: s.token, host: "evil.example" })).status, 403);
    const post = await request(s.base, {
      method: "POST",
      pathname: "/secrets/provider",
      body: { provider: "anthropic", apiKey: KEY },
    });
    assert.equal(post.status, 401);
    assert.equal(s.vault.state, "uninitialized");
  } finally {
    await s.cleanup();
  }
});

test("saving a key encrypts it on disk, never echoes it, and the session uses it", async () => {
  const s = await setup();
  try {
    const before = await request(s.base, { pathname: "/secrets", token: s.token });
    assert.equal(before.status, 200);
    assert.equal(before.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(before.text).state, "uninitialized");

    const saved = await request(s.base, {
      method: "POST",
      pathname: "/secrets/provider",
      token: s.token,
      body: { provider: "anthropic", apiKey: KEY },
    });
    assert.equal(saved.status, 200);
    assert.ok(!saved.text.includes(KEY));
    assert.equal(JSON.parse(saved.text).providers.anthropic.hasKey, true);

    const status = await request(s.base, { pathname: "/secrets", token: s.token });
    assert.ok(!status.text.includes(KEY));
    assert.equal(JSON.parse(status.text).providers.anthropic.keyHint, "sk-••••cdef");

    const onDisk = await readFile(s.vault.file, "utf8");
    assert.ok(!onDisk.includes(KEY));

    await s.session.send("hi");
    assert.deepEqual(s.used, [KEY]);
    assert.equal(s.session.snapshot().log.findLast((e) => e.type === "assistant_end").text, "hello");
  } finally {
    await s.cleanup();
  }
});

test("bad input and state errors map to 4xx without leaking the body", async () => {
  const s = await setup();
  try {
    const bad = await request(s.base, {
      method: "POST",
      pathname: "/secrets/provider",
      token: s.token,
      body: { provider: "x" },
    });
    assert.equal(bad.status, 400);
    const lock = await request(s.base, { method: "POST", pathname: "/secrets/lock", token: s.token, body: {} });
    assert.equal(lock.status, 400); // an os-keychain vault can't be locked

    const notJson = await new Promise((resolve, reject) => {
      const url = new URL("/secrets/provider", s.base);
      url.searchParams.set("token", s.token);
      const req = http.request(url, { method: "POST" }, (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      });
      req.on("error", reject);
      req.end(`{"apiKey":"${KEY}"`);
    });
    assert.equal(notJson.status, 400);
    assert.ok(!notJson.text.includes(KEY));
  } finally {
    await s.cleanup();
  }
});

test("without a SecretManager the routes report that secrets are disabled", async () => {
  const s = await setup({ secrets: false });
  try {
    const res = await request(s.base, { pathname: "/secrets", token: s.token });
    assert.deepEqual(JSON.parse(res.text), { enabled: false });
    const post = await request(s.base, { method: "POST", pathname: "/secrets/unlock", token: s.token, body: {} });
    assert.equal(post.status, 404);
  } finally {
    await s.cleanup();
  }
});

test("connected panels are told when the vault changes", async () => {
  const s = await setup();
  try {
    const events = [];
    const url = new URL("/events", s.base);
    url.searchParams.set("token", s.token);
    const got = new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)).type);
          }
          if (events.includes("secrets_changed")) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (err) => (err.code === "ECONNRESET" ? resolve() : reject(err)));
    });
    while (!events.includes("snapshot")) await new Promise((r) => setTimeout(r, 5));
    await request(s.base, {
      method: "POST",
      pathname: "/secrets/provider",
      token: s.token,
      body: { provider: "openai", model: "m" },
    });
    await got;
    assert.ok(events.includes("secrets_changed"));
  } finally {
    await s.cleanup();
  }
});

test("POST /providers and DELETE /providers/:id manage custom providers behind auth", async () => {
  const s = await setup({
    extraFactories: {
      ollama: () => new ScriptedProvider([{ text: "from-ollama" }], "ollama"),
    },
  });
  try {
    assert.equal(
      (
        await request(s.base, {
          method: "POST",
          pathname: "/providers",
          body: {
            id: "ollama",
            api: "openai-completions",
            baseURL: "http://127.0.0.1:11434/v1",
            defaultModel: "qwen2.5",
            auth: "none",
          },
        })
      ).status,
      401,
    );

    const leaked = await request(s.base, {
      method: "POST",
      pathname: "/providers",
      token: s.token,
      body: {
        id: "deepseek",
        api: "openai-completions",
        baseURL: "https://api.deepseek.com/v1",
        defaultModel: "deepseek-chat",
        apiKey: KEY,
      },
    });
    assert.equal(leaked.status, 400);
    assert.ok(!leaked.text.includes(KEY));

    const created = await request(s.base, {
      method: "POST",
      pathname: "/providers",
      token: s.token,
      body: {
        id: "ollama",
        name: "Ollama Local",
        api: "openai-completions",
        baseURL: "http://127.0.0.1:11434/v1",
        defaultModel: "qwen2.5-coder:14b",
        auth: "none",
      },
    });
    assert.equal(created.status, 200);
    assert.equal(created.headers["cache-control"], "no-store");
    const status = JSON.parse(created.text);
    assert.deepEqual(status.providerOrder, ["anthropic", "openai", "ollama"]);
    assert.equal(status.providers.ollama.configured, true);
    assert.equal(status.providers.ollama.builtin, false);

    // Switch session to the new auth: "none" provider and run a turn with no vault key.
    const sw = await request(s.base, {
      method: "POST",
      pathname: "/command",
      token: s.token,
      body: { type: "switch", provider: "ollama" },
    });
    assert.equal(sw.status, 202);
    await s.session.send("ping");
    assert.equal(s.session.snapshot().log.findLast((e) => e.type === "assistant_end").text, "from-ollama");

    // Cannot delete active provider or built-in.
    assert.equal(
      (await request(s.base, { method: "DELETE", pathname: "/providers/ollama", token: s.token })).status,
      400,
    );
    assert.equal(
      (await request(s.base, { method: "DELETE", pathname: "/providers/anthropic", token: s.token })).status,
      400,
    );

    // Switch away and delete.
    await request(s.base, {
      method: "POST",
      pathname: "/command",
      token: s.token,
      body: { type: "switch", provider: "anthropic" },
    });
    const deleted = await request(s.base, { method: "DELETE", pathname: "/providers/ollama", token: s.token });
    assert.equal(deleted.status, 200);
    assert.deepEqual(JSON.parse(deleted.text).providerOrder, ["anthropic", "openai"]);
  } finally {
    await s.cleanup();
  }
});

test("GET /secrets picks up external providers.json edits", async () => {
  const s = await setup();
  try {
    const before = await request(s.base, { pathname: "/secrets", token: s.token });
    assert.deepEqual(JSON.parse(before.text).providerOrder, ["anthropic", "openai"]);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      s.config.file,
      JSON.stringify({
        providers: {
          ollama: {
            api: "openai-completions",
            baseURL: "http://127.0.0.1:11434/v1",
            defaultModel: "qwen2.5",
            auth: "none",
          },
        },
      }),
    );

    const after = await request(s.base, { pathname: "/secrets", token: s.token });
    assert.equal(after.status, 200);
    assert.deepEqual(JSON.parse(after.text).providerOrder, ["anthropic", "openai", "ollama"]);
  } finally {
    await s.cleanup();
  }
});
