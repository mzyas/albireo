import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, matchCommands, parseCommand, resolveModelArgs } from "../src/lib/commands.ts";
import { activeTrigger, applyCompletion, formatMention } from "../src/lib/composer.ts";
import { parseDiff } from "../src/lib/diff.ts";
import { folderName, formatBytes, noChangesReason, splitPath } from "../src/lib/workspace.ts";

// ---- diff ---------------------------------------------------------------------------------------

const MODIFIED = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,4 +1,5 @@ function head",
  " one",
  "-two",
  "+TWO",
  "+two and a half",
  " three",
  " four",
  "@@ -20,2 +21,2 @@",
  " twenty",
  "-old",
  "+new",
  "\\ No newline at end of file",
  "",
].join("\n");

test("parseDiff numbers the lines of each hunk and counts what was added and removed", () => {
  const d = parseDiff(MODIFIED);
  assert.equal(d.hunks.length, 2);
  assert.equal(d.added, 3);
  assert.equal(d.removed, 2);
  assert.equal(d.binary, false);
  assert.equal(d.hunks[0]?.header, "@@ -1,4 +1,5 @@ function head");
  assert.deepEqual(d.hunks[0]?.lines, [
    { kind: "ctx", text: "one", oldNo: 1, newNo: 1 },
    { kind: "del", text: "two", oldNo: 2 },
    { kind: "add", text: "TWO", newNo: 2 },
    { kind: "add", text: "two and a half", newNo: 3 },
    { kind: "ctx", text: "three", oldNo: 3, newNo: 4 },
    { kind: "ctx", text: "four", oldNo: 4, newNo: 5 },
  ]);
  assert.deepEqual(d.hunks[1]?.lines, [
    { kind: "ctx", text: "twenty", oldNo: 20, newNo: 21 },
    { kind: "del", text: "old", oldNo: 21 },
    { kind: "add", text: "new", newNo: 22 },
    { kind: "note", text: "No newline at end of file" },
  ]);
});

test("parseDiff keeps lines that look like diff syntax inside a hunk as content", () => {
  const d = parseDiff(
    ["@@ -1,2 +1,2 @@", "--- not a header", "+++ not a header either", " @@ not a hunk", ""].join("\n"),
  );
  assert.equal(d.hunks.length, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.added, 1);
  assert.deepEqual(d.hunks[0]?.lines[0], { kind: "del", text: "-- not a header", oldNo: 1 });
});

test("parseDiff reads new files, deleted files, renames, binary files and mode changes", () => {
  const added = parseDiff(
    "diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n",
  );
  assert.deepEqual(added.notes, ["new file"]);
  assert.equal(added.added, 2);
  assert.deepEqual(added.hunks[0]?.lines[1], { kind: "add", text: "b", newNo: 2 });

  assert.deepEqual(parseDiff("deleted file mode 100644\n@@ -1 +0,0 @@\n-x\n").notes, ["deleted file"]);

  const renamed = parseDiff("diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n");
  assert.deepEqual(renamed.notes, ["renamed from old"]);
  assert.deepEqual(renamed.hunks, []);

  assert.equal(parseDiff("Binary files a/x and b/x differ\n").binary, true);
  assert.deepEqual(parseDiff("old mode 100644\nnew mode 100755\n").notes, ["mode 100644 → 100755"]);
  assert.deepEqual(parseDiff("new mode 100755\n").notes, ["mode ? → 100755"]);
});

test("parseDiff takes an empty diff and a context line stripped of its space", () => {
  const empty = parseDiff("");
  assert.deepEqual(empty, { hunks: [], added: 0, removed: 0, binary: false, notes: [] });
  const d = parseDiff("@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n");
  assert.deepEqual(d.hunks[0]?.lines[1], { kind: "ctx", text: "", oldNo: 2, newNo: 2 });
});

// ---- @ and / triggers ---------------------------------------------------------------------------

test("activeTrigger finds the @file the caret is in and ignores emails", () => {
  assert.deepEqual(activeTrigger("look at @src/ap", 15), { kind: "mention", query: "src/ap", start: 8, end: 15 });
  assert.deepEqual(activeTrigger("@", 1), { kind: "mention", query: "", start: 0, end: 1 });
  assert.equal(activeTrigger("mail me at a@b.com", 18), null);
  assert.equal(activeTrigger("look at @src/app.ts and", 23), null, "the caret is past the mention");
  assert.equal(activeTrigger("look at @src/app.ts ", 20), null, "right after a space there is no token");
  // The mention extends past the caret so completing it replaces the whole word.
  assert.deepEqual(activeTrigger("see @src/app.ts now", 8), { kind: "mention", query: "src", start: 4, end: 15 });
  assert.equal(activeTrigger('@"my', 4)?.query, "my", "a quote is not part of the query");
  assert.equal(
    activeTrigger('@"my f', 6),
    null,
    "a space ends the word: names with spaces are found by their first part",
  );
});

test("activeTrigger finds a command only in the first word", () => {
  assert.deepEqual(activeTrigger("/mod", 4), { kind: "command", query: "mod", start: 0, end: 4 });
  assert.deepEqual(activeTrigger("/", 1), { kind: "command", query: "", start: 0, end: 1 });
  assert.equal(activeTrigger("/model gpt", 10), null, "an argument is not a command");
  assert.equal(activeTrigger("run /model", 10), null);
  assert.equal(activeTrigger("hello", 5), null);
  assert.equal(activeTrigger("", 0), null);
});

test("applyCompletion replaces the token and puts the caret after a space", () => {
  const trigger = activeTrigger("see @src/ap now", 11);
  assert.ok(trigger);
  const done = applyCompletion("see @src/ap now", trigger, "@src/app.ts");
  assert.equal(done.text, "see @src/app.ts now");
  assert.equal(done.caret, 16);

  const end = activeTrigger("see @sr", 7);
  assert.ok(end);
  assert.deepEqual(applyCompletion("see @sr", end, "@src/a.ts"), { text: "see @src/a.ts ", caret: 14 });

  const command = activeTrigger("/mo", 3);
  assert.ok(command);
  assert.deepEqual(applyCompletion("/mo", command, "/model"), { text: "/model ", caret: 7 });
});

test("formatMention quotes a path that has spaces", () => {
  assert.equal(formatMention("src/app.ts"), "@src/app.ts");
  assert.equal(formatMention("my docs/a b.md"), '@"my docs/a b.md"');
});

// ---- slash commands -----------------------------------------------------------------------------

test("parseCommand only knows the commands it has; anything else is an ordinary message", () => {
  assert.deepEqual(parseCommand("/retry"), { name: "retry", args: [] });
  assert.deepEqual(parseCommand("  /RETRY  "), { name: "retry", args: [] });
  assert.deepEqual(parseCommand("/model openai gpt-x"), { name: "model", args: ["openai", "gpt-x"] });
  assert.equal(parseCommand("/usr/bin/env is missing"), null);
  assert.equal(parseCommand("/nosuchcommand"), null);
  assert.equal(parseCommand("please /retry"), null);
  assert.equal(parseCommand("retry"), null);
  for (const c of COMMANDS) assert.ok(parseCommand(`/${c.name}`), c.name);
});

test("matchCommands lists prefix matches before the others", () => {
  assert.equal(matchCommands("")?.length, COMMANDS.length);
  assert.deepEqual(
    matchCommands("c").map((c) => c.name),
    ["changes", "context"],
  );
  assert.ok(
    matchCommands("e")
      .map((c) => c.name)
      .includes("keys"),
    "contains-matches come after",
  );
  assert.equal(matchCommands("e")[0]?.name.startsWith("e"), false, "no command starts with e");
  assert.deepEqual(matchCommands("zzz"), []);
});

test("resolveModelArgs tells a provider from a model of the current provider", () => {
  const providers = ["anthropic", "openai"];
  assert.deepEqual(resolveModelArgs([], providers, "anthropic"), { open: true });
  assert.deepEqual(resolveModelArgs(["openai"], providers, "anthropic"), {
    open: false,
    provider: "openai",
    model: "",
  });
  assert.deepEqual(resolveModelArgs(["some-model"], providers, "anthropic"), {
    open: false,
    provider: "anthropic",
    model: "some-model",
  });
  assert.deepEqual(resolveModelArgs(["openai", "m1"], providers, "anthropic"), {
    open: false,
    provider: "openai",
    model: "m1",
  });
  assert.ok("error" in resolveModelArgs(["nope", "m1"], providers, "anthropic"));
  assert.ok("error" in resolveModelArgs(["openai", "m1", "extra"], providers, "anthropic"));
});

// ---- workspace helpers --------------------------------------------------------------------------

test("splitPath, folderName and formatBytes", () => {
  assert.deepEqual(splitPath("src/lib/a.ts"), { dir: "src/lib/", name: "a.ts" });
  assert.deepEqual(splitPath("README.md"), { dir: "", name: "README.md" });
  assert.equal(folderName("D:\\GitHub.com-project\\albireo"), "albireo");
  assert.equal(folderName("/home/me/project/"), "project");
  assert.equal(folderName("/"), "/");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(20 * 1024), "20 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("noChangesReason explains why there is no list", () => {
  assert.equal(noChangesReason({ git: true, files: [], truncated: false }), null);
  assert.match(
    noChangesReason({ git: false, reason: "no-repo", files: [], truncated: false }) ?? "",
    /not a git repository/,
  );
  assert.match(noChangesReason({ git: false, reason: "no-git", files: [], truncated: false }) ?? "", /not installed/);
});
