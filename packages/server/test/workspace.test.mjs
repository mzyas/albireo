import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderRegistry, ScriptedProvider, Session } from "@albireo/core";
import { startPanelServer } from "../dist/index.js";
import { MAX_CHANGED_FILES, parseStatus, rankPaths, Workspace, WorkspaceError } from "../dist/workspace.js";

let hasGit = true;
try {
  execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
  hasGit = false;
}
const needsGit = { skip: hasGit ? false : "git is not installed" };

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** A temp directory that no repository above it can claim, so "not a repo" really is one. */
async function tempDir() {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "albireo-ws-")));
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  return dir;
}

async function repo() {
  const dir = await tempDir();
  git(dir, "init", "-q");
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(dir, "gone.txt"), "bye\n");
  await writeFile(path.join(dir, "old-name.txt"), "a long enough file\nso that git sees a rename\nwhen it moves\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f]));

test("parseStatus reads branch lines, renames, untracked files and conflicts", () => {
  const raw = [
    "## main...origin/main [ahead 1]",
    " M src/a.ts",
    "M  staged.ts",
    "MM both.ts",
    "A  new.ts",
    " D removed.ts",
    "R  renamed-to.ts",
    "renamed-from.ts",
    "UU conflict.ts",
    "?? loose.ts",
    "",
  ].join("\0");
  const result = parseStatus(raw);
  assert.equal(result.git, true);
  assert.equal(result.branch, "main");
  assert.equal(result.detached, false);
  const files = byPath(result.files);
  assert.deepEqual(files["src/a.ts"], { path: "src/a.ts", status: "modified", staged: false, unstaged: true });
  assert.deepEqual(files["staged.ts"], { path: "staged.ts", status: "modified", staged: true, unstaged: false });
  assert.equal(files["both.ts"].staged && files["both.ts"].unstaged, true);
  assert.equal(files["new.ts"].status, "added");
  assert.equal(files["removed.ts"].status, "deleted");
  assert.deepEqual(files["renamed-to.ts"], {
    path: "renamed-to.ts",
    from: "renamed-from.ts",
    status: "renamed",
    staged: true,
    unstaged: false,
  });
  assert.equal(files["conflict.ts"].status, "conflicted");
  assert.deepEqual(files["loose.ts"], { path: "loose.ts", status: "untracked", staged: false, unstaged: true });
  assert.deepEqual(
    result.files.map((f) => f.path),
    [...result.files.map((f) => f.path)].sort(),
    "listed in path order",
  );
});

test("parseStatus understands an unborn branch and a detached HEAD", () => {
  assert.equal(parseStatus("## No commits yet on trunk\0").branch, "trunk");
  assert.equal(parseStatus("## Initial commit on trunk\0").branch, "trunk");
  const detached = parseStatus("## HEAD (no branch)\0");
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, undefined);
  assert.equal(parseStatus("## feature/x\0").branch, "feature/x");
});

test("parseStatus makes paths relative to a workspace inside the repository, and caps the list", () => {
  const raw = [
    "## main",
    " M packages/app/src/a.ts",
    " M packages/app/b.ts",
    "R  packages/app/new.ts",
    "packages/app/old.ts",
    "",
  ].join("\0");
  const result = parseStatus(raw, "packages/app/");
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["b.ts", "new.ts", "src/a.ts"],
  );
  assert.equal(byPath(result.files)["new.ts"].from, "old.ts");

  const many = ["## main", ...Array.from({ length: MAX_CHANGED_FILES + 5 }, (_, i) => `?? f${i}.txt`), ""].join("\0");
  const capped = parseStatus(many);
  assert.equal(capped.files.length, MAX_CHANGED_FILES);
  assert.equal(capped.truncated, true);
});

test("rankPaths puts file-name matches first and falls back to loose letter order", () => {
  const paths = ["docs/readme-notes.md", "src/app.ts", "src/lib/app-state.ts", "README.md", "src/a/p/p.ts"];
  assert.deepEqual(rankPaths(paths, "readme", 10).slice(0, 2), ["README.md", "docs/readme-notes.md"]);
  assert.deepEqual(rankPaths(paths, "app.ts", 10)[0], "src/app.ts");
  assert.deepEqual(rankPaths(paths, "SRC/LIB", 10), ["src/lib/app-state.ts"], "case and slashes do not matter");
  assert.ok(rankPaths(paths, "app", 10).includes("src/a/p/p.ts"), "letters in order still match");
  assert.deepEqual(rankPaths(paths, "zzz", 10), []);
  assert.deepEqual(
    rankPaths(paths, "", 2),
    ["README.md", "docs/readme-notes.md"],
    "with nothing typed, the files closest to the root come first",
  );
  assert.equal(rankPaths(paths, "s", 1).length, 1);
});

test("changes lists modified, added, deleted, renamed and untracked files", needsGit, async () => {
  const dir = await repo();
  try {
    assert.deepEqual((await new Workspace(dir).changes()).files, [], "a clean repository has no changes");

    await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
    await writeFile(path.join(dir, "fresh.txt"), "new file\n");
    await rm(path.join(dir, "gone.txt"));
    git(dir, "mv", "old-name.txt", "new-name.txt");
    await mkdir(path.join(dir, "sub"));
    await writeFile(path.join(dir, "sub", "inner.txt"), "inner\n");

    const result = await new Workspace(dir).changes();
    assert.equal(result.git, true);
    assert.equal(typeof result.branch, "string");
    const files = byPath(result.files);
    assert.equal(files["a.txt"].status, "modified");
    assert.equal(files["a.txt"].unstaged, true);
    assert.equal(files["fresh.txt"].status, "untracked");
    assert.equal(files["sub/inner.txt"].status, "untracked", "files in new directories are listed one by one");
    assert.equal(files["gone.txt"].status, "deleted");
    assert.equal(files["new-name.txt"].status, "renamed");
    assert.equal(files["new-name.txt"].from, "old-name.txt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a workspace inside a repository only sees its own changes, with its own paths", needsGit, async () => {
  const dir = await repo();
  try {
    await mkdir(path.join(dir, "pkg"));
    await writeFile(path.join(dir, "pkg", "in.txt"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "pkg");
    await writeFile(path.join(dir, "pkg", "in.txt"), "y\n");
    await writeFile(path.join(dir, "a.txt"), "changed outside\n");

    const ws = new Workspace(path.join(dir, "pkg"));
    const result = await ws.changes();
    assert.deepEqual(
      result.files.map((f) => f.path),
      ["in.txt"],
    );
    assert.match((await ws.diff("in.txt")).diff, /\+y/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("outside a repository changes says so", needsGit, async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await new Workspace(dir).changes(), {
      git: false,
      reason: "no-repo",
      files: [],
      truncated: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diff shows modified, staged, untracked and deleted files against HEAD", needsGit, async () => {
  const dir = await repo();
  try {
    await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
    await writeFile(path.join(dir, "fresh.txt"), "brand new\n");
    await rm(path.join(dir, "gone.txt"));
    git(dir, "mv", "old-name.txt", "new-name.txt");
    const ws = new Workspace(dir);

    const modified = await ws.diff("a.txt");
    assert.equal(modified.path, "a.txt");
    assert.match(modified.diff, /^diff --git/m);
    assert.match(modified.diff, /^-two$/m);
    assert.match(modified.diff, /^\+TWO$/m);

    git(dir, "add", "a.txt");
    await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
    const both = (await ws.diff("a.txt")).diff;
    assert.match(both, /^\+TWO$/m, "staged changes are included");
    assert.match(both, /^\+four$/m, "and so are unstaged ones");

    const untracked = await ws.diff("fresh.txt");
    assert.match(untracked.diff, /^\+brand new$/m);
    assert.match(untracked.diff, /new file mode/);

    assert.match((await ws.diff("gone.txt")).diff, /^-bye$/m);

    const renamed = await ws.diff("new-name.txt", "old-name.txt");
    assert.match(renamed.diff, /rename from old-name\.txt/);

    assert.equal((await ws.diff("a.txt")).truncated, false);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "all");
    assert.equal((await ws.diff("a.txt")).diff, "", "no changes, no diff");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diff works in a repository that has no commit yet", needsGit, async () => {
  const dir = await tempDir();
  try {
    git(dir, "init", "-q");
    await writeFile(path.join(dir, "first.txt"), "hello\n");
    await writeFile(path.join(dir, "second.txt"), "world\n");
    git(dir, "add", "first.txt");
    const ws = new Workspace(dir);
    assert.equal((await ws.changes()).git, true);
    assert.match((await ws.diff("first.txt")).diff, /^\+hello$/m, "staged");
    assert.match((await ws.diff("second.txt")).diff, /^\+world$/m, "untracked");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a huge diff is cut at a line end and says so", needsGit, async () => {
  const dir = await repo();
  try {
    await writeFile(path.join(dir, "big.txt"), `${"0123456789".repeat(9)}\n`.repeat(5000));
    const result = await new Workspace(dir).diff("big.txt");
    assert.equal(result.truncated, true);
    assert.ok(result.diff.length <= 200_000);
    assert.ok(result.diff.endsWith("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("diff and preview refuse paths outside the workspace and do not echo them", needsGit, async () => {
  const dir = await repo();
  try {
    const ws = new Workspace(dir);
    for (const bad of ["../x", "..", "", "sub/../../x", path.resolve(dir, "..", "x")]) {
      await assert.rejects(ws.diff(bad), (err) => err instanceof WorkspaceError && err.code === "invalid");
      await assert.rejects(ws.preview(bad), (err) => err instanceof WorkspaceError && err.code === "invalid");
    }
    await assert.rejects(ws.preview("a\0.txt"), WorkspaceError);
    await assert.rejects(
      ws.diff("../secret-name"),
      (err) => err instanceof WorkspaceError && !err.message.includes("secret-name"),
    );
    // Git's own pathspec syntax is not interpreted: this is a file name that matches nothing.
    assert.equal((await ws.diff(":(top)a.txt")).diff, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changes and diff never run a program named in the repository's config", needsGit, async () => {
  const dir = await repo();
  const marker = path.join(dir, "..", `ran-${path.basename(dir)}`);
  const script = path.join(dir, "..", `hook-${path.basename(dir)}.cjs`);
  await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
  try {
    git(dir, "config", "core.fsmonitor", `node ${JSON.stringify(script.replaceAll("\\", "/"))}`);

    // Control: without the safeguards git does run it, so the check below proves something.
    try {
      git(dir, "status");
    } catch {
      // a failing hook is fine, it only has to have run
    }
    if (!existsSync(marker)) return;
    await rm(marker);

    const ws = new Workspace(dir);
    await writeFile(path.join(dir, "a.txt"), "changed\n");
    await ws.changes();
    await ws.diff("a.txt");
    assert.equal(existsSync(marker), false, "the configured program was not run");
  } finally {
    await rm(marker, { force: true });
    await rm(script, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("files lists tracked and untracked files but not ignored ones, ranked by the query", needsGit, async () => {
  const dir = await repo();
  try {
    await writeFile(path.join(dir, ".gitignore"), "dist/\n");
    await mkdir(path.join(dir, "dist"));
    await writeFile(path.join(dir, "dist", "bundle.js"), "x");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "app.ts"), "x");
    await writeFile(path.join(dir, "src", "application-notes.md"), "x");

    await rm(path.join(dir, "gone.txt"));

    const ws = new Workspace(dir);
    const all = (await ws.files("", 100)).files;
    assert.ok(all.includes("a.txt"));
    assert.ok(!all.includes("gone.txt"), "a tracked file that was deleted from the disk is not offered");
    assert.ok(all.includes("src/app.ts"), "untracked files count");
    assert.ok(!all.includes("dist/bundle.js"), "ignored files do not");
    assert.ok(!all.some((f) => f.startsWith(".git/")));

    const hits = (await ws.files("app", 100)).files;
    assert.equal(hits[0], "src/app.ts");
    assert.deepEqual((await ws.files("app", 1)).files, ["src/app.ts"]);
    assert.equal((await ws.files("", 100)).total, all.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("without git, files walks the directory and skips node_modules", async () => {
  const dir = await tempDir();
  try {
    await mkdir(path.join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "dep", "index.js"), "x");
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "main.ts"), "x");
    await writeFile(path.join(dir, "top.txt"), "x");
    const { files } = await new Workspace(dir).files("", 100);
    assert.deepEqual(files.sort(), ["src/main.ts", "top.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("preview reads text, flags binary files, cuts big ones and refuses links that lead out", async (t) => {
  const dir = await tempDir();
  const outside = await tempDir();
  try {
    await writeFile(path.join(dir, "note.txt"), "héllo\n");
    await writeFile(path.join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3, 4]));
    await writeFile(path.join(dir, "big.txt"), "x".repeat(250_000));
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, ".git", "config"), "[remote]\n");
    await mkdir(path.join(dir, "folder"));
    const ws = new Workspace(dir);

    assert.deepEqual(await ws.preview("note.txt"), {
      path: "note.txt",
      content: "héllo\n",
      binary: false,
      size: 7,
      truncated: false,
    });
    const blob = await ws.preview("blob.bin");
    assert.equal(blob.binary, true);
    assert.equal(blob.content, "");
    const big = await ws.preview("big.txt");
    assert.equal(big.truncated, true);
    assert.equal(big.size, 250_000);
    assert.equal(big.content.length, 200_000);

    await assert.rejects(ws.preview(".git/config"), (err) => err.code === "invalid");
    await assert.rejects(ws.preview("folder"), (err) => err.code === "invalid");
    await assert.rejects(ws.preview("missing.txt"), (err) => err.code === "not_found");

    await writeFile(path.join(outside, "secret.txt"), "top secret");
    try {
      await symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
    } catch {
      t.diagnostic("symlinks are not available here; the link check was skipped");
      return;
    }
    await assert.rejects(ws.preview("link.txt"), (err) => err.code === "invalid");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---- over HTTP ---------------------------------------------------------------------------------

function request(base, { method = "GET", pathname, token, body }) {
  const url = new URL(pathname, base);
  const headers = { host: url.host };
  if (token !== undefined) headers["x-albireo-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
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

async function serve(cwd) {
  const registry = new ProviderRegistry().register("scripted", () => new ScriptedProvider([]));
  const session = new Session({ providers: registry, provider: "scripted", tools: [], cwd });
  const panel = await startPanelServer(session, { publicDir: new URL("file:///nonexistent/") });
  const url = new URL(panel.url);
  return { panel, session, base: url.origin, token: url.searchParams.get("token") };
}

test("workspace routes need the token and answer with no-store JSON", needsGit, async () => {
  const dir = await repo();
  const s = await serve(dir);
  try {
    await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
    for (const p of [
      "/workspace/changes",
      "/workspace/files?q=a",
      "/workspace/diff?path=a.txt",
      "/workspace/file?path=a.txt",
    ]) {
      assert.equal((await request(s.base, { pathname: p })).status, 401, `${p} without a token`);
    }
    const changes = await request(s.base, { pathname: "/workspace/changes", token: s.token });
    assert.equal(changes.status, 200);
    assert.equal(changes.headers["cache-control"], "no-store");
    assert.deepEqual(
      JSON.parse(changes.text).files.map((f) => f.path),
      ["a.txt"],
    );

    const diff = JSON.parse((await request(s.base, { pathname: "/workspace/diff?path=a.txt", token: s.token })).text);
    assert.match(diff.diff, /^\+TWO$/m);

    const files = JSON.parse(
      (await request(s.base, { pathname: "/workspace/files?q=gone&limit=5", token: s.token })).text,
    );
    assert.deepEqual(files.files, ["gone.txt"]);

    const file = JSON.parse((await request(s.base, { pathname: "/workspace/file?path=a.txt", token: s.token })).text);
    assert.equal(file.content, "one\nTWO\nthree\n");

    const outside = await request(s.base, { pathname: "/workspace/file?path=..%2Fsecret", token: s.token });
    assert.equal(outside.status, 400);
    assert.ok(!outside.text.includes("secret"), "the error does not repeat the path");
    assert.equal((await request(s.base, { pathname: "/workspace/file?path=nope.txt", token: s.token })).status, 404);
    assert.equal((await request(s.base, { pathname: "/workspace/other", token: s.token })).status, 404);
    assert.equal(
      (await request(s.base, { method: "POST", pathname: "/workspace/changes", token: s.token, body: {} })).status,
      404,
      "workspace routes only read",
    );
  } finally {
    await s.panel.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the retry command reaches the session", async () => {
  const dir = await tempDir();
  const s = await serve(dir);
  try {
    const res = await request(s.base, {
      method: "POST",
      pathname: "/command",
      token: s.token,
      body: { type: "retry" },
    });
    assert.equal(res.status, 202);
    assert.equal(s.session.snapshot().log.at(-1).type, "error", "nothing to retry in a fresh session");
  } finally {
    await s.panel.close();
    await rm(dir, { recursive: true, force: true });
  }
});
