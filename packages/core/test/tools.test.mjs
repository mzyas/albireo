import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyEdit,
  builtinTools,
  formatSearchResult,
  globToRegExp,
  matchesGlob,
  ProviderRegistry,
  runSearch,
  ScriptedProvider,
  Session,
} from "../dist/index.js";

const tool = (name) => builtinTools.find((t) => t.name === name);

/** Runs a built-in tool the way the session does: the input goes through the schema first. */
function call(name, input, ctx = {}) {
  const t = tool(name);
  return t.run(t.input.parse(input), ctx);
}

async function workspace(files = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "albireo-tools-"));
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, rel)), { recursive: true });
    await writeFile(path.join(cwd, rel), contents);
  }
  return {
    cwd,
    read: (rel) => readFile(path.join(cwd, rel), "utf8"),
    done: () => rm(cwd, { recursive: true, force: true }),
  };
}

// ---- edit_file -------------------------------------------------------------------------------

test("edit_file replaces a unique occurrence and says where", async () => {
  const w = await workspace({ "a.ts": "one\ntwo\nthree\n" });
  try {
    const out = await call("edit_file", { path: "a.ts", old_string: "two", new_string: "2" }, { cwd: w.cwd });
    assert.match(out, /replaced 1 occurrence at line 2/);
    assert.equal(await w.read("a.ts"), "one\n2\nthree\n");
  } finally {
    await w.done();
  }
});

test("edit_file refuses a missing or ambiguous match and leaves the file alone", async () => {
  const w = await workspace({ "a.txt": "x\nfoo\nx\nfoo\nfoo\n" });
  try {
    await assert.rejects(
      call("edit_file", { path: "a.txt", old_string: "bar", new_string: "z" }, { cwd: w.cwd }),
      /not found/,
    );
    await assert.rejects(
      call("edit_file", { path: "a.txt", old_string: "foo", new_string: "z" }, { cwd: w.cwd }),
      /appears 3 times \(lines 2, 4, 5\)/,
    );
    assert.equal(await w.read("a.txt"), "x\nfoo\nx\nfoo\nfoo\n");

    const out = await call(
      "edit_file",
      { path: "a.txt", old_string: "foo", new_string: "z", replace_all: true },
      { cwd: w.cwd },
    );
    assert.match(out, /replaced 3 occurrences \(the first at line 2\)/);
    assert.equal(await w.read("a.txt"), "x\nz\nx\nz\nz\n");
  } finally {
    await w.done();
  }
});

test("edit_file rejects empty and no-op edits", () => {
  assert.throws(() => applyEdit("abc", "", "x"), /must not be empty/);
  assert.throws(() => applyEdit("abc", "b", "b"), /identical/);
});

test("edit_file can delete text and keeps replacements literal", () => {
  assert.equal(applyEdit("a-b-c", "-b", "").text, "a-c");
  // `$&` and `$1` are not replacement patterns here.
  assert.equal(applyEdit("price", "price", "$& $1").text, "$& $1");
});

test("edit_file keeps CRLF files CRLF when the model writes LF", async () => {
  const w = await workspace({ "win.txt": "a\r\nb\r\nc\r\n" });
  try {
    await call("edit_file", { path: "win.txt", old_string: "a\nb", new_string: "a\nB\nB2" }, { cwd: w.cwd });
    assert.equal(await w.read("win.txt"), "a\r\nB\r\nB2\r\nc\r\n");
  } finally {
    await w.done();
  }
});

test("edit_file leaves LF files and exact-CRLF input alone", () => {
  assert.equal(applyEdit("a\nb\n", "a\nb", "x\ny").text, "x\ny\n");
  assert.equal(applyEdit("a\r\nb\r\n", "a\r\nb", "x\r\ny").text, "x\r\ny\r\n");
});

test("edit_file keeps a UTF-8 BOM", async () => {
  const w = await workspace({ "bom.txt": "﻿hello world" });
  try {
    await call("edit_file", { path: "bom.txt", old_string: "world", new_string: "there" }, { cwd: w.cwd });
    assert.equal(await w.read("bom.txt"), "﻿hello there");
  } finally {
    await w.done();
  }
});

test("edit_file refuses files that are not clean UTF-8 text", async () => {
  const w = await workspace();
  try {
    await writeFile(path.join(w.cwd, "latin1.txt"), Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]));
    await writeFile(path.join(w.cwd, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    for (const p of ["latin1.txt", "bin.dat"]) {
      await assert.rejects(
        call("edit_file", { path: p, old_string: "h", new_string: "j" }, { cwd: w.cwd }),
        /not a UTF-8 text file/,
      );
    }
    assert.deepEqual([...(await readFile(path.join(w.cwd, "latin1.txt")))], [0x68, 0xe9, 0x6c, 0x6c, 0x6f]);
  } finally {
    await w.done();
  }
});

test("edit_file and grep stay inside the workspace", async () => {
  const w = await workspace({ "a.txt": "x" });
  try {
    await assert.rejects(
      call("edit_file", { path: "../outside.txt", old_string: "a", new_string: "b" }, { cwd: w.cwd }),
      /escapes the workspace/,
    );
    await assert.rejects(call("grep", { pattern: "x", path: ".." }, { cwd: w.cwd }), /escapes the workspace/);
  } finally {
    await w.done();
  }
});

test("edit_file needs approval; grep does not", async () => {
  assert.equal(tool("edit_file").risk, "write");
  assert.equal(tool("grep").risk, "read");

  const w = await workspace({ "a.txt": "hello" });
  try {
    const steps = [
      { toolCalls: [{ name: "grep", input: { pattern: "hello" } }] },
      { toolCalls: [{ name: "edit_file", input: { path: "a.txt", old_string: "hello", new_string: "bye" } }] },
      { text: "done" },
    ];
    const registry = new ProviderRegistry().register("scripted", () => new ScriptedProvider(steps));
    const session = new Session({ providers: registry, provider: "scripted", tools: builtinTools, cwd: w.cwd });
    const asked = [];
    session.on((e) => {
      if (e.type === "approval_request") {
        asked.push(e.name);
        session.approve(e.id, false);
      }
    });
    await session.send("go");
    assert.deepEqual(asked, ["edit_file"]);
    assert.equal(await w.read("a.txt"), "hello", "a denied edit must not touch the file");

    const result = session.snapshot().log.filter((e) => e.type === "tool_result");
    assert.equal(result[0].isError, false);
    assert.match(result[0].content, /a\.txt:1: hello/);
    assert.equal(result[1].isError, true);
  } finally {
    await w.done();
  }
});

// ---- grep ------------------------------------------------------------------------------------

test("grep reports path:line: text with workspace-relative forward-slash paths, in path order", async () => {
  const w = await workspace({
    "b.txt": "nothing\nTODO later\n",
    "src/a.ts": "// TODO first\nconst x = 1;\n// TODO second\n",
    "src/deep/c.ts": "TODO deep\r\n",
  });
  try {
    const out = await call("grep", { pattern: "TODO" }, { cwd: w.cwd });
    assert.equal(
      out.split("\n\n")[0],
      [
        "b.txt:2: TODO later",
        "src/a.ts:1: // TODO first",
        "src/a.ts:3: // TODO second",
        "src/deep/c.ts:1: TODO deep",
      ].join("\n"),
    );
    assert.match(out, /4 matches in 3 files\./);
  } finally {
    await w.done();
  }
});

test("grep skips .git, node_modules, binary files, symlinks and oversized files", async () => {
  const w = await workspace({
    "keep.txt": "needle\n",
    "node_modules/pkg/index.js": "needle\n",
    ".git/config": "needle\n",
    "big.txt": `${"x".repeat(1_100_000)}needle\n`,
  });
  try {
    await writeFile(
      path.join(w.cwd, "bin.dat"),
      Buffer.concat([Buffer.from("needle"), Buffer.from([0]), Buffer.from("needle")]),
    );
    try {
      await symlink(path.join(w.cwd, "node_modules"), path.join(w.cwd, "linked"), "junction");
    } catch {
      // No permission to create links here; the rest of the test still applies.
    }
    const out = await call("grep", { pattern: "needle" }, { cwd: w.cwd });
    assert.match(out, /^keep\.txt:1: needle\n/);
    assert.match(out, /1 matches in 1 files\./);
    assert.match(out, /Skipped 2 binary, oversized or unreadable files\./);
    assert.doesNotMatch(out, /node_modules|\.git|linked/);
  } finally {
    await w.done();
  }
});

test("grep include filters by file name at any depth, or by path below the search root", async () => {
  const w = await workspace({
    "a.ts": "hit\n",
    "a.js": "hit\n",
    "src/b.ts": "hit\n",
    "src/ui/c.tsx": "hit\n",
    "lib/d.ts": "hit\n",
  });
  try {
    const names = async (input) =>
      (await call("grep", { pattern: "hit", ...input }, { cwd: w.cwd }))
        .split("\n\n")[0]
        .split("\n")
        .map((l) => l.split(":")[0]);
    assert.deepEqual(await names({ include: "*.ts" }), ["a.ts", "lib/d.ts", "src/b.ts"]);
    assert.deepEqual(await names({ include: "src/**/*.{ts,tsx}" }), ["src/b.ts", "src/ui/c.tsx"]);
    // Paths are relative to `path`, and results stay relative to the workspace.
    assert.deepEqual(await names({ path: "src", include: "ui/*.tsx" }), ["src/ui/c.tsx"]);
  } finally {
    await w.done();
  }
});

test("grep searches a single file, ignoring include", async () => {
  const w = await workspace({ "a.txt": "x\nfind me\n", "b.txt": "find me\n" });
  try {
    const out = await call("grep", { pattern: "find", path: "a.txt", include: "*.md" }, { cwd: w.cwd });
    assert.match(out, /^a\.txt:2: find me/);
    assert.doesNotMatch(out, /b\.txt/);
  } finally {
    await w.done();
  }
});

test("grep handles case, Unicode and invalid patterns", async () => {
  const w = await workspace({ "a.txt": "Hello\n你好世界\n" });
  try {
    assert.match(await call("grep", { pattern: "hello" }, { cwd: w.cwd }), /^No matches in 1 files\./);
    assert.match(await call("grep", { pattern: "hello", ignore_case: true }, { cwd: w.cwd }), /a\.txt:1: Hello/);
    assert.match(await call("grep", { pattern: "\\p{Script=Han}+" }, { cwd: w.cwd }), /a\.txt:2: 你好世界/);
    // `\-` is an error in Unicode mode but fine in a plain regular expression.
    assert.match(await call("grep", { pattern: "o\\-?\\n?" }, { cwd: w.cwd }), /a\.txt:1/);
    await assert.rejects(call("grep", { pattern: "(" }, { cwd: w.cwd }), /Invalid regular expression/);
    await assert.rejects(call("grep", { pattern: "x", path: "missing" }, { cwd: w.cwd }), /path not found: missing/);
  } finally {
    await w.done();
  }
});

test("grep stops at the match limit and says so", async () => {
  const w = await workspace({ "many.txt": `${"line\n".repeat(150)}` });
  try {
    const out = await call("grep", { pattern: "line" }, { cwd: w.cwd });
    assert.equal(out.split("\n\n")[0].split("\n").length, 100);
    assert.match(out, /Stopped at the limit of 100 matches/);

    const exact = await workspace({ "ok.txt": `${"line\n".repeat(100)}` });
    try {
      assert.doesNotMatch(await call("grep", { pattern: "line" }, { cwd: exact.cwd }), /Stopped at the limit/);
    } finally {
      await exact.done();
    }
  } finally {
    await w.done();
  }
});

test("grep shows a long line around the match", async () => {
  const w = await workspace({ "min.js": `${"a".repeat(500)}NEEDLE${"b".repeat(500)}\n` });
  try {
    const out = (await call("grep", { pattern: "NEEDLE" }, { cwd: w.cwd })).split("\n\n")[0];
    assert.ok(out.includes("NEEDLE"));
    assert.ok(out.length < 260, `excerpt was ${out.length} characters`);
    assert.match(out, /^min\.js:1: …a+NEEDLEb+…$/);
  } finally {
    await w.done();
  }
});

test("a catastrophic pattern cannot freeze the kernel: it times out and can be aborted", async () => {
  const w = await workspace({ "evil.txt": `${"a".repeat(40)}b\n` });
  const options = { target: w.cwd, root: w.cwd, pattern: "(a+)+$", ignoreCase: false, maxMatches: 10 };
  try {
    // The event loop keeps running while the search burns CPU in its worker.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = Date.now();
    await assert.rejects(runSearch(options, { timeoutMs: 400 }), /timed out after 0\.4s/);
    clearInterval(timer);
    assert.ok(Date.now() - started < 5000);
    assert.ok(ticks >= 5, `the main thread was blocked (${ticks} ticks)`);

    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    await assert.rejects(runSearch(options, { signal: ctl.signal, timeoutMs: 10_000 }), /aborted/);

    const already = new AbortController();
    already.abort();
    await assert.rejects(runSearch(options, { signal: already.signal }), /aborted/);
  } finally {
    await w.done();
  }
});

test("formatSearchResult explains an empty result", () => {
  const empty = { lines: [], filesWithMatches: 0, filesSearched: 3, skipped: 1, truncated: false };
  assert.equal(
    formatSearchResult(empty, 100),
    "No matches in 3 files. Skipped 1 binary, oversized or unreadable files.",
  );
});

// ---- glob ------------------------------------------------------------------------------------

test("globToRegExp supports *, **, ? and {a,b}, and treats the rest literally", () => {
  const m = (glob, p) => globToRegExp(glob).test(p);
  assert.ok(m("*.ts", "a.ts"));
  assert.ok(!m("*.ts", "dir/a.ts"), "* stays inside one segment");
  assert.ok(m("**/*.ts", "a.ts"));
  assert.ok(m("**/*.ts", "x/y/a.ts"));
  assert.ok(m("src/**", "src/a/b.txt"));
  assert.ok(m("a?c", "abc") && !m("a?c", "a/c"));
  assert.ok(m("*.{ts,tsx}", "a.tsx") && !m("*.{ts,tsx}", "a.js"));
  assert.ok(m("a.b+c(1)", "a.b+c(1)"), "regex characters are literal");
  assert.ok(!m("a.b", "axb"));
  assert.throws(() => globToRegExp("*.{ts"), /unclosed/);
});

test("matchesGlob matches a bare pattern against the file name only", () => {
  const re = globToRegExp("*.ts");
  assert.ok(matchesGlob(re, false, "deep/er/a.ts"));
  assert.ok(!matchesGlob(re, true, "deep/er/a.ts"));
});
