import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  builtinTools,
  INSTRUCTION_FILE,
  loadInstructions,
  MAX_INSTRUCTION_CHARS,
  ProviderRegistry,
  ScriptedProvider,
  Session,
  withInstructions,
} from "../dist/index.js";

async function workspace() {
  return mkdtemp(path.join(tmpdir(), "albireo-instr-"));
}

test("loadInstructions reads the workspace's AGENTS.md", async () => {
  const cwd = await workspace();
  try {
    assert.deepEqual(await loadInstructions(cwd), [], "no file, nothing loaded");
    await writeFile(path.join(cwd, INSTRUCTION_FILE), "Use tabs.\n");
    const [file] = await loadInstructions(cwd);
    assert.equal(file.path, INSTRUCTION_FILE);
    assert.equal(file.content, "Use tabs.\n");
    assert.equal(file.bytes, 10);
    assert.equal(file.truncated, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a long instruction file is cut and says so", async () => {
  const cwd = await workspace();
  try {
    await writeFile(path.join(cwd, INSTRUCTION_FILE), "x".repeat(MAX_INSTRUCTION_CHARS + 500));
    const [file] = await loadInstructions(cwd);
    assert.equal(file.content.length, MAX_INSTRUCTION_CHARS);
    assert.equal(file.bytes, MAX_INSTRUCTION_CHARS + 500);
    assert.equal(file.truncated, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a directory or a symlink named AGENTS.md is not loaded", async (t) => {
  const cwd = await workspace();
  const outside = await workspace();
  try {
    await mkdir(path.join(cwd, INSTRUCTION_FILE));
    assert.deepEqual(await loadInstructions(cwd), []);
    await rm(path.join(cwd, INSTRUCTION_FILE), { recursive: true });

    await writeFile(path.join(outside, "secret.txt"), "not for the model");
    try {
      await symlink(path.join(outside, "secret.txt"), path.join(cwd, INSTRUCTION_FILE));
    } catch {
      t.skip("symlinks are not available here");
      return;
    }
    assert.deepEqual(await loadInstructions(cwd), [], "a link out of the workspace is never followed");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("withInstructions appends the files to the prompt and leaves it alone when there are none", () => {
  assert.equal(withInstructions("base", []), "base");
  assert.equal(withInstructions("base", [{ path: "AGENTS.md", content: "  \n", bytes: 3, truncated: false }]), "base");
  const out = withInstructions("base", [
    { path: "AGENTS.md", content: "Run the tests.\n", bytes: 15, truncated: false },
  ]);
  assert.ok(out.startsWith("base\n\n"));
  assert.ok(out.includes('<file path="AGENTS.md">\nRun the tests.\n</file>'));
  assert.ok(out.includes("never override the user's requests"));
});

test("a session sends the instructions to the model but shows clients only names and sizes", async () => {
  const cwd = await workspace();
  try {
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const registry = new ProviderRegistry().register("scripted", () => provider);
    const session = new Session({
      providers: registry,
      provider: "scripted",
      tools: builtinTools,
      cwd,
      instructions: [{ path: "AGENTS.md", content: "Always run pnpm test.", bytes: 21, truncated: false }],
    });
    await session.send("hi");
    assert.ok(provider.requests[0].system.includes("Always run pnpm test."));

    const snap = session.snapshot();
    assert.deepEqual(snap.instructions, [{ path: "AGENTS.md", bytes: 21, truncated: false }]);
    assert.equal(snap.cwd, cwd);
    assert.ok(!JSON.stringify(snap).includes("Always run pnpm test."), "the text stays in the kernel");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
