import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, ScriptedProvider, Session } from "@albireo/core";
import { createVaultRegistry, MemoryKeyProtector, SecretManager, VaultStore } from "@albireo/vault";
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

async function setup({ secrets = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-server-"));
  const used = [];
  const factories = {
    anthropic: (config) => {
      used.push(config.apiKey);
      return new ScriptedProvider([{ text: "hello" }], "anthropic");
    },
  };
  const vault = await VaultStore.open({ dir, protector: new MemoryKeyProtector() });
  const registry = createVaultRegistry(vault, factories);
  const session = new Session({ providers: registry, provider: "anthropic", tools: builtinTools, cwd: dir });
  const manager = secrets ? new SecretManager({ vault, registry, session, factories }) : undefined;
  const panel = await startPanelServer(session, { secrets: manager });
  const url = new URL(panel.url);
  const token = url.searchParams.get("token");
  return {
    base: url.origin,
    token,
    vault,
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
