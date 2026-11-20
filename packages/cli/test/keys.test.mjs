import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryKeyProtector, VaultStore } from "@albireo/vault";
import { runKeysCommand } from "../dist/keys.js";
import { CancelledError } from "../dist/tty.js";

const KEY = "sk-ant-cli-0123456789abcdefWXYZ";
const OPENAI_KEY = "sk-openai-0123456789abcdef";
const PASS = "correct horse battery staple";

async function withDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "albireo-keys-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fake terminal: `prompts` answers hidden prompts in order; `stdin` is what a pipe would deliver. */
function fakeIO({ interactive = false, prompts = [], stdin = "" } = {}) {
  const io = {
    out: "",
    err: "",
    asked: [],
    stdinReads: 0,
    interactive,
    stdout: (text) => {
      io.out += text;
    },
    stderr: (text) => {
      io.err += text;
    },
    promptHidden: async (question) => {
      io.asked.push(question);
      if (prompts.length === 0) throw new Error(`unexpected prompt: ${question}`);
      const answer = prompts.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    readStdin: async () => {
      io.stdinReads++;
      return stdin;
    },
  };
  return io;
}

/** `protector: null` means no OS credential store (passphrase mode). */
function keys(dir, protector, argv, io) {
  return runKeysCommand(argv, io, () => VaultStore.open({ dir, protector }));
}

test("set reads the key from a pipe, creates an os-keychain vault and never prints the key", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const io = fakeIO({ stdin: `${KEY}\n` });
    assert.equal(await keys(dir, protector, ["set", "anthropic", "--model", "claude-x"], io), 0);
    assert.match(io.out, /Saved\. anthropic\s+key sk-••••WXYZ · model claude-x/);
    assert.ok(!io.out.includes(KEY) && !io.err.includes(KEY));
    assert.ok(!(await readFile(path.join(dir, "vault.enc.json"), "utf8")).includes(KEY));

    const store = await VaultStore.open({ dir, protector });
    assert.deepEqual(store.read().providers.anthropic, { apiKey: KEY, model: "claude-x" });

    const status = fakeIO();
    assert.equal(await keys(dir, protector, [], status), 0);
    assert.match(status.out, /Vault: unlocked, master key held by memory/);
    assert.match(status.out, /anthropic\s+key sk-••••WXYZ · model claude-x/);
    assert.match(status.out, /openai\s+no key/);
    assert.ok(!status.out.includes(KEY));
  }));

test("set --keep-key changes only the endpoint and model; '' removes them; clear drops the key", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    assert.equal(await keys(dir, protector, ["set", "openai"], fakeIO({ stdin: OPENAI_KEY })), 0);
    const read = async () => (await VaultStore.open({ dir, protector })).read().providers.openai;

    const io = fakeIO();
    const args = ["set", "openai", "--keep-key", "--base-url", "https://example.test/v1", "--model", "m1"];
    assert.equal(await keys(dir, protector, args, io), 0);
    assert.equal(io.stdinReads, 0);
    assert.deepEqual(await read(), { apiKey: OPENAI_KEY, baseURL: "https://example.test/v1", model: "m1" });

    assert.equal(await keys(dir, protector, ["set", "openai", "--keep-key", "--base-url", ""], fakeIO()), 0);
    assert.deepEqual(await read(), { apiKey: OPENAI_KEY, model: "m1" });

    const cleared = fakeIO();
    assert.equal(await keys(dir, protector, ["clear", "openai"], cleared), 0);
    assert.match(cleared.out, /Removed the openai key/);
    assert.deepEqual(await read(), { model: "m1" });

    const again = fakeIO();
    assert.equal(await keys(dir, protector, ["clear", "openai"], again), 0);
    assert.match(again.out, /No openai key is stored/);
  }));

test("an empty or invalid key changes nothing", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const empty = fakeIO({ stdin: "\n" });
    assert.equal(await keys(dir, protector, ["set", "anthropic"], empty), 1);
    assert.match(empty.err, /no API key given/);
    assert.deepEqual(await readdir(dir), []);

    const spaced = fakeIO({ stdin: "sk-one two" });
    assert.equal(await keys(dir, protector, ["set", "anthropic"], spaced), 1);
    assert.match(spaced.err, /must not contain whitespace/);
    assert.ok(!spaced.err.includes("sk-one"));
  }));

test("without an OS credential store, set creates a passphrase vault, in a terminal only", () =>
  withDir(async (dir) => {
    const piped = fakeIO({ stdin: KEY });
    assert.equal(await keys(dir, null, ["set", "anthropic"], piped), 1);
    assert.match(piped.err, /needs a passphrase; run this in a terminal/);
    assert.equal(piped.stdinReads, 0);

    const mismatch = fakeIO({ interactive: true, prompts: [PASS, `${PASS}!`] });
    assert.equal(await keys(dir, null, ["set", "anthropic"], mismatch), 1);
    assert.match(mismatch.err, /do not match/);
    assert.deepEqual(await readdir(dir), []);

    const io = fakeIO({ interactive: true, prompts: [PASS, PASS, KEY] });
    assert.equal(await keys(dir, null, ["set", "anthropic"], io), 0);
    assert.deepEqual(io.asked, ["New vault passphrase: ", "Repeat the passphrase: ", "API key for anthropic: "]);

    const locked = await VaultStore.open({ dir, protector: null });
    assert.equal(locked.state, "locked");
    await locked.unlock(PASS);
    assert.equal(locked.read().providers.anthropic.apiKey, KEY);
  }));

test("a passphrase vault: unlock prompt, wrong passphrase, piped stdin, status without a terminal", () =>
  withDir(async (dir) => {
    const store = await VaultStore.open({ dir, protector: null });
    await store.initialize(PASS);

    const wrong = fakeIO({ interactive: true, prompts: ["not the passphrase"] });
    assert.equal(await keys(dir, null, ["set", "openai"], wrong), 1);
    assert.deepEqual(wrong.asked, ["Vault passphrase: "]);

    const piped = fakeIO({ stdin: KEY });
    assert.equal(await keys(dir, null, ["set", "openai"], piped), 1);
    assert.match(piped.err, /protected by a passphrase; run this in a terminal/);
    assert.equal(piped.stdinReads, 0);

    const ok = fakeIO({ interactive: true, prompts: [PASS, OPENAI_KEY] });
    assert.equal(await keys(dir, null, ["set", "openai"], ok), 0);

    const plain = fakeIO();
    assert.equal(await keys(dir, null, ["status"], plain), 0);
    assert.match(plain.out, /Vault: locked, encrypted with a passphrase/);
    assert.doesNotMatch(plain.out, /openai/);

    const tty = fakeIO({ interactive: true, prompts: [PASS] });
    assert.equal(await keys(dir, null, ["status"], tty), 0);
    assert.match(tty.out, /openai\s+key sk-••••cdef/);
  }));

test("status of a missing vault does not create it", () =>
  withDir(async (dir) => {
    const io = fakeIO();
    assert.equal(await keys(dir, new MemoryKeyProtector(), ["status"], io), 0);
    assert.match(io.out, /not created yet/);
    assert.deepEqual(await readdir(dir), []);
  }));

test("usage errors exit with 2, read nothing and never echo stray arguments", () =>
  withDir(async (dir) => {
    const protector = new MemoryKeyProtector();
    const cases = [
      [["set", "anthropic", KEY], /too many arguments/],
      [["set"], /needs a provider/],
      [["set", "gemini"], /unknown provider/],
      [["frobnicate"], /unknown command/],
      [["status", "openai"], /takes no provider/],
      [["clear", "openai", "--model", "x"], /only apply to `set`/],
      [["set", "openai", "--keep-key"], /nothing to change/],
      [["set", "openai", `--key=${KEY}`], /Unknown option '--key'/],
    ];
    for (const [argv, message] of cases) {
      const io = fakeIO({ stdin: KEY });
      assert.equal(await keys(dir, protector, argv, io), 2, argv.join(" "));
      assert.match(io.err, message);
      assert.ok(!io.err.includes(KEY), argv.join(" "));
      assert.equal(io.stdinReads, 0);
    }
    assert.deepEqual(await readdir(dir), []);

    const help = fakeIO();
    assert.equal(await keys(dir, protector, ["--help"], help), 0);
    assert.match(help.out, /albireo keys set <provider>/);
  }));

test("cancelling a prompt exits with 130 and changes nothing", () =>
  withDir(async (dir) => {
    const io = fakeIO({ interactive: true, prompts: [new CancelledError()] });
    assert.equal(await keys(dir, new MemoryKeyProtector(), ["set", "anthropic"], io), 130);
    assert.deepEqual(await readdir(dir), []);
  }));

test("custom providers from providers.json work with set, clear, and status (including auth: none)", () =>
  withDir(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(dir, "providers.json"),
      JSON.stringify({
        providers: {
          deepseek: {
            name: "DeepSeek",
            api: "openai-completions",
            baseURL: "https://api.deepseek.com/v1",
            defaultModel: "deepseek-chat",
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

    const protector = new MemoryKeyProtector();
    const setIo = fakeIO({ stdin: `${KEY}\n` });
    assert.equal(await keys(dir, protector, ["set", "deepseek", "--model", "deepseek-reasoner"], setIo), 0);
    assert.match(setIo.out, /Saved\. deepseek\s+key sk-••••WXYZ · model deepseek-reasoner/);

    const statusIo = fakeIO();
    assert.equal(await keys(dir, protector, ["status"], statusIo), 0);
    assert.match(statusIo.out, /deepseek\s+key sk-••••WXYZ · model deepseek-reasoner/);
    assert.match(statusIo.out, /ollama\s+no key needed/);

    const clearIo = fakeIO();
    assert.equal(await keys(dir, protector, ["clear", "deepseek"], clearIo), 0);
    assert.match(clearIo.out, /Removed the deepseek key/);
  }));

test("rejected provider in providers.json reports config.error in keys set", () =>
  withDir(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(dir, "providers.json"),
      JSON.stringify({
        providers: {
          gw: {
            api: "openai-completions",
            baseURL: "https://gw.example/v1",
            defaultModel: "m",
            headers: { "X-Api-Key": "secret" },
          },
        },
      }),
    );

    const io = fakeIO({ stdin: KEY });
    assert.equal(await keys(dir, new MemoryKeyProtector(), ["set", "gw"], io), 2);
    assert.match(io.err, /unknown provider "gw"/);
    assert.match(io.err, /Header "X-Api-Key" is not allowed/);
  }));

test("keys status and keys set report an unusable base-URL override", () =>
  withDir(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    const providersFile = path.join(dir, "providers.json");
    await writeFile(
      providersFile,
      JSON.stringify({
        providers: {
          gw: {
            api: "openai-completions",
            baseURL: "https://gw.example/v1",
            defaultModel: "m",
          },
        },
      }),
    );

    const protector = new MemoryKeyProtector();
    assert.equal(
      await keys(
        dir,
        protector,
        ["set", "gw", "--base-url", "https://gw.example/v1?api-version=1"],
        fakeIO({ stdin: KEY }),
      ),
      0,
    );

    await writeFile(
      providersFile,
      JSON.stringify({
        providers: {
          gw: {
            api: "anthropic-messages",
            baseURL: "https://gw.example/v1",
            defaultModel: "m",
          },
        },
      }),
    );

    const statusIo = fakeIO();
    assert.equal(await keys(dir, protector, ["status"], statusIo), 0);
    assert.match(
      statusIo.out,
      /gw\s+key sk-••••WXYZ · base URL https:\/\/gw\.example\/v1\?api-version=1 · unusable: .*query string/,
    );

    const setIo = fakeIO();
    assert.equal(await keys(dir, protector, ["set", "gw", "--keep-key", "--model", "m2"], setIo), 0);
    assert.match(
      setIo.out,
      /Saved\. gw\s+key sk-••••WXYZ · base URL https:\/\/gw\.example\/v1\?api-version=1 · model m2 · unusable:/,
    );
  }));
