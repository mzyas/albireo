import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { MemoryKeyProtector } from "@albireo/vault";
import { openStores, recentUse, startKernel } from "../dist/kernel.js";

/** Answers every turn by echoing the message. */
class EchoProvider {
  id = "echo";
  defaultModel = "m1";
  async runTurn(req, onEvent) {
    const last = req.messages[req.messages.length - 1];
    const reply = `echo: ${last.content.map((p) => (p.type === "text" ? p.text : "")).join("")}`;
    onEvent({ type: "text_delta", text: reply });
    return {
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "albireo-desktop-"));
  const dir = path.join(root, "config");
  const workspace = path.join(root, "work");
  const publicDir = path.join(root, "public");
  await mkdir(workspace);
  await mkdir(publicDir);
  await writeFile(path.join(publicDir, "index.html"), "<!doctype html><title>panel</title>");
  const stores = await openStores({ dir, protector: new MemoryKeyProtector() });
  stores.registry.register("echo", () => new EchoProvider());
  const started = [];
  return {
    root,
    dir,
    workspace,
    stores,
    publicDir: new URL(`${pathToFileURL(publicDir).href}/`),
    async start(opts = {}) {
      const kernel = await startKernel(stores, {
        cwd: workspace,
        provider: "echo",
        publicDir: new URL(`${pathToFileURL(publicDir).href}/`),
        ...opts,
      });
      started.push(kernel);
      return kernel;
    },
    async cleanup() {
      for (const kernel of started) await kernel.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const call = (kernel, route, init) => {
  const url = new URL(kernel.url);
  const target = new URL(route, url.origin);
  return fetch(target, { ...init, headers: { "x-albireo-token": url.searchParams.get("token"), ...init?.headers } });
};

test("the kernel serves the panel and starts its first session in the workspace", async () => {
  const t = await setup();
  try {
    const kernel = await t.start();
    const page = await call(kernel, "/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>panel<\/title>/);

    const list = await (await call(kernel, "/sessions")).json();
    assert.equal(list.canCreate, true, "the panel can start more sessions");
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].cwd, t.workspace);
    assert.equal(list.sessions[0].provider, "echo");

    // The server is the locked-down one: no token, no answer.
    assert.equal((await fetch(new URL("/sessions", kernel.url))).status, 401);
  } finally {
    await t.cleanup();
  }
});

test("a folder that is not usable stops the kernel from starting, and leaves nothing running", async () => {
  const t = await setup();
  try {
    await assert.rejects(t.start({ cwd: path.join(t.root, "missing") }), { name: "ManagerError" });
    await assert.rejects(t.start({ cwd: "relative/dir" }), { name: "ManagerError" });
    await assert.rejects(t.start({ provider: "nobody" }), { name: "ManagerError" });
  } finally {
    await t.cleanup();
  }
});

test("the port of the last run is used again, or any free one if it is taken", async () => {
  const t = await setup();
  const blocker = net.createServer();
  try {
    // A port that was free a moment ago comes back as it was.
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const wanted = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const first = await t.start({ port: wanted });
    assert.equal(Number(new URL(first.url).port), wanted);
    await first.close();

    // Now something else holds it.
    await new Promise((resolve) => blocker.listen(wanted, "127.0.0.1", resolve));
    const second = await t.start({ port: wanted });
    assert.notEqual(Number(new URL(second.url).port), wanted);
    assert.equal((await call(second, "/sessions")).status, 200);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await t.cleanup();
  }
});

test("the app opens where the user left off", async () => {
  const t = await setup();
  try {
    assert.deepEqual(await recentUse(t.stores), {}, "nothing saved yet");

    const kernel = await t.start();
    const managed = kernel.manager.primary;
    await managed.session.send("remember me");
    await kernel.manager.flush();
    assert.deepEqual(await recentUse(t.stores), { cwd: t.workspace, provider: "echo" });

    // The folder is gone: the app does not open there.
    await kernel.close();
    await rm(t.workspace, { recursive: true });
    assert.deepEqual(await recentUse(t.stores), {});
  } finally {
    await t.cleanup();
  }
});

test("the newest saved session whose folder still exists wins", async () => {
  const t = await setup();
  try {
    const older = path.join(t.root, "older");
    await mkdir(older);
    const first = await t.start({ cwd: older });
    await first.manager.primary.session.send("one");
    await first.close();
    // Saved times have a resolution of a millisecond, and the order of two sessions made in the same one is not defined.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await t.start();
    await second.manager.primary.session.send("two");
    await second.close();

    assert.equal((await recentUse(t.stores)).cwd, t.workspace);
    await rm(t.workspace, { recursive: true });
    assert.equal((await recentUse(t.stores)).cwd, older, "falls back to an older one that still exists");
  } finally {
    await t.cleanup();
  }
});

test("saving a conversation does not need anything in the workspace", async () => {
  const t = await setup();
  try {
    const kernel = await t.start();
    await kernel.manager.primary.session.send("hello");
    await kernel.manager.flush();
    assert.equal((await readdir(t.workspace)).length, 0, "nothing is written into the workspace");
  } finally {
    await t.cleanup();
  }
});

test("closing stops the server", async () => {
  const t = await setup();
  try {
    const kernel = await t.start();
    assert.equal((await call(kernel, "/sessions")).status, 200);
    await kernel.close();
    await assert.rejects(call(kernel, "/sessions"));
  } finally {
    await t.cleanup();
  }
});
