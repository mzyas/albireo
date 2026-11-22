import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderRegistry, ScriptedProvider, Session } from "@albireo/core";
import { startPanelServer } from "../dist/index.js";

function get(base, { pathname, token, host }) {
  const url = new URL(pathname, base);
  if (token !== undefined) url.searchParams.set("token", token);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { host: host ?? url.host } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        text += c;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function start(publicDir) {
  const registry = new ProviderRegistry().register("scripted", () => new ScriptedProvider([]));
  const session = new Session({ providers: registry, provider: "scripted", tools: [], cwd: tmpdir() });
  const panel = await startPanelServer(session, { publicDir });
  const url = new URL(panel.url);
  return { panel, base: url.origin, token: url.searchParams.get("token") };
}

test("GET / serves the built panel, and only with the token and a loopback Host", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-panel-"));
  await mkdir(path.join(dir, "dist"));
  await writeFile(path.join(dir, "dist", "index.html"), "<!doctype html><title>built panel</title>");
  const s = await start(new URL(`file:///${path.join(dir, "dist").replaceAll("\\", "/")}/`));
  try {
    assert.equal((await get(s.base, { pathname: "/" })).status, 401);
    assert.equal((await get(s.base, { pathname: "/", token: "wrong" })).status, 401);
    assert.equal((await get(s.base, { pathname: "/", token: s.token, host: "evil.example" })).status, 403);
    const ok = await get(s.base, { pathname: "/", token: s.token });
    assert.equal(ok.status, 200);
    assert.match(ok.headers["content-type"], /text\/html/);
    assert.equal(ok.headers["cache-control"], "no-store");
    assert.match(ok.text, /built panel/);
  } finally {
    await s.panel.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET / explains that the panel is not built instead of failing obscurely", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-panel-"));
  const s = await start(new URL(`file:///${dir.replaceAll("\\", "/")}/`));
  try {
    const res = await get(s.base, { pathname: "/", token: s.token });
    assert.equal(res.status, 503);
    assert.match(res.text, /pnpm build/);
    assert.doesNotMatch(res.text, new RegExp(dir.replaceAll("\\", "\\\\")), "the message must not reveal local paths");
  } finally {
    await s.panel.close();
    await rm(dir, { recursive: true, force: true });
  }
});
