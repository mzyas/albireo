import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { builtinTools, commandEnv, ProviderRegistry, ScriptedProvider, Session } from "../dist/index.js";

class Named extends ScriptedProvider {
  constructor(id, defaultModel, steps = []) {
    super(steps, id);
    Object.defineProperty(this, "defaultModel", { value: defaultModel });
  }
}

async function makeSession(opts = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-"));
  const registry = new ProviderRegistry().register("p", () => new Named("p", "old-model", [{ text: "ok" }]));
  const session = new Session({ providers: registry, provider: "p", tools: builtinTools, cwd, ...opts });
  return { cwd, registry, session };
}

test("refreshProvider picks up a re-registered provider and its default model", async () => {
  const { cwd, registry, session } = await makeSession();
  const fresh = new Named("p", "new-model", [{ text: "from fresh" }]);
  registry.register("p", () => fresh);
  session.refreshProvider();
  assert.equal(session.model, "new-model");
  assert.equal(session.snapshot().log.at(-1).type, "provider_changed");
  await session.send("hi");
  assert.equal(fresh.requests.length, 1);
  await rm(cwd, { recursive: true, force: true });
});

test("refreshProvider keeps an explicitly chosen model and stays quiet when nothing changed", async () => {
  const { cwd, registry, session } = await makeSession({ model: "pinned" });
  registry.register("p", () => new Named("p", "new-model"));
  session.refreshProvider();
  assert.equal(session.model, "pinned");
  assert.equal(
    session.snapshot().log.some((e) => e.type === "provider_changed"),
    false,
  );
  await rm(cwd, { recursive: true, force: true });
});

test("refreshProvider is rejected while a turn is running", async () => {
  const { cwd, session } = await makeSession();
  let duringTurn;
  session.on((e) => {
    if (e.type === "user") {
      try {
        session.refreshProvider();
        duringTurn = "allowed";
      } catch (err) {
        duringTurn = err.message;
      }
    }
  });
  await session.send("hi");
  assert.match(duringTurn, /while a turn is running/);
  assert.doesNotThrow(() => session.refreshProvider());
  await rm(cwd, { recursive: true, force: true });
});

test("commandEnv drops LLM credentials regardless of name casing", () => {
  const env = commandEnv({ PATH: "/bin", OPENAI_API_KEY: "a", anthropic_api_key: "b", ANTHROPIC_AUTH_TOKEN: "c" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("run_command does not pass the parent's API keys to the child", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-"));
  const saved = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
  process.env.OPENAI_API_KEY = "sk-parent-openai";
  process.env.ANTHROPIC_API_KEY = "sk-parent-anthropic";
  try {
    const tool = builtinTools.find((t) => t.name === "run_command");
    const script =
      "console.log([process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, process.env.PATH ? 'path' : ''].join('|'))";
    const out = await tool.run({ command: `"${process.execPath}" -e "${script}"` }, { cwd });
    assert.match(out, /^exit 0\n\|\|path/);
  } finally {
    for (const [name, value] of [
      ["OPENAI_API_KEY", saved.openai],
      ["ANTHROPIC_API_KEY", saved.anthropic],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
