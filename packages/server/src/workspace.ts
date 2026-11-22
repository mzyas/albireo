import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { commandEnv, resolveInside } from "@albireo/core";
import type { ChangedFile, ChangeStatus, Changes, FileDiff, FileList, FilePreview } from "./protocol.js";

// Read-only views of the workspace for the panel: what changed, one file's diff, the file list for `@`
// references and a file preview. Everything here works on the session's workspace root and nothing writes.

export type WorkspaceErrorCode = "invalid" | "not_found";

/** A request the workspace can't serve; the message is written for the panel's user. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export const MAX_CHANGED_FILES = 1000;
export const MAX_DIFF_CHARS = 200_000;
export const MAX_PREVIEW_BYTES = 200_000;
export const MAX_LISTED_FILES = 20_000;
const FILES_TTL_MS = 3000;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT = 4_000_000;

/**
 * Options for every git call. The repository may be one the user only just opened, so nothing in its
 * config may make `git status` run a program (`core.fsmonitor` does); the index is not locked, so a
 * git command the agent runs at the same time is never blocked; pathspecs are plain paths.
 */
const GIT_SAFETY = [
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.quotepath=false",
];
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "--find-renames"];

interface GitResult {
  stdout: string;
  code: number;
}

class GitMissingError extends Error {}

function git(cwd: string, args: string[], okCodes: number[] = [0]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...GIT_SAFETY, ...args],
      {
        cwd,
        // Not the agent's credentials, and no prompt or pager to wait on.
        env: { ...commandEnv(), GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (!err) {
          resolve({ stdout, code: 0 });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        if (e.code === "ENOENT") reject(new GitMissingError());
        // Output past the buffer is cut rather than failed: callers clip it further anyway.
        else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ stdout, code: 0 });
        else if (typeof e.code === "number" && okCodes.includes(e.code)) resolve({ stdout, code: e.code });
        else reject(new Error("git failed"));
      },
    );
  });
}

/** The prefix of the workspace inside its repository ("" at the root), or undefined outside one. */
async function repoPrefix(cwd: string): Promise<string | undefined> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-prefix"], [0, 128]);
    return out.code === 0 ? out.stdout.trim() : undefined;
  } catch (err) {
    if (err instanceof GitMissingError) return undefined;
    throw err;
  }
}

function parseBranch(line: string): { branch?: string; detached: boolean } {
  if (line.startsWith("HEAD (no branch)")) return { detached: true };
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(line);
  if (unborn) return { branch: unborn[1], detached: false };
  const name = line.split("...")[0]?.split(" [")[0];
  return { branch: name || undefined, detached: false };
}

function statusOf(x: string, y: string): ChangeStatus {
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "?" && y === "?") return "untracked";
  if (x === "A" || x === "C") return "added";
  if (x === "R") return "renamed";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

/**
 * Reads `git status --porcelain=v1 -z --branch` output. `prefix` is where the workspace sits inside the
 * repository: git reports repository-relative paths and the panel wants workspace-relative ones.
 */
export function parseStatus(raw: string, prefix = ""): Changes {
  const parts = raw.split("\0");
  const out: Changes = { git: true, files: [], truncated: false };
  let i = 0;
  const first = parts[0];
  if (first?.startsWith("## ")) {
    Object.assign(out, parseBranch(first.slice(3)));
    i = 1;
  }
  const inside = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  while (i < parts.length) {
    const record = parts[i++];
    if (!record || record.length < 4) continue;
    const x = record[0] as string;
    const y = record[1] as string;
    const file: ChangedFile = {
      path: inside(record.slice(3)),
      status: statusOf(x, y),
      staged: x !== " " && x !== "?" && x !== "!",
      unstaged: y !== " " && y !== "!",
    };
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const from = parts[i++];
      if (from) file.from = inside(from);
    }
    if (file.status === "untracked") {
      file.staged = false;
      file.unstaged = true;
    }
    if (out.files.length >= MAX_CHANGED_FILES) {
      out.truncated = true;
      continue;
    }
    out.files.push(file);
  }
  out.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function isSubsequence(text: string, query: string): boolean {
  let j = 0;
  for (let i = 0; i < text.length && j < query.length; i++) if (text[i] === query[j]) j++;
  return j === query.length;
}

/** Paths matching `query` (case-insensitive), best first: file name, then path, then loose letter order. */
export function rankPaths(paths: readonly string[], query: string, limit: number): string[] {
  const q = query.trim().toLowerCase().replaceAll("\\", "/");
  if (!q) {
    // Nothing typed yet: the files closest to the root first, as they are the ones people mean most often.
    const depth = (p: string) => p.split("/").length;
    return [...paths].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1)).slice(0, limit);
  }
  const scored: { path: string; score: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number;
    if (name === q) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (name.includes(q)) score = 2;
    else if (lower.includes(q)) score = 3;
    else if (isSubsequence(lower, q)) score = 4;
    else continue;
    scored.push({ path: p, score });
  }
  scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.path);
}

/** Without git: every file under the root except `.git` and `node_modules`, links not followed. */
async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const skip = new Set([".git", "node_modules"]);
  const queue = [""];
  while (queue.length > 0 && found.length < MAX_LISTED_FILES) {
    const dir = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) queue.push(rel);
      } else if (entry.isFile() && found.length < MAX_LISTED_FILES) {
        found.push(rel);
      }
    }
  }
  return found;
}

function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const lineEnd = cut.lastIndexOf("\n");
  return { text: lineEnd > max / 2 ? cut.slice(0, lineEnd + 1) : cut, truncated: true };
}

export class Workspace {
  private listing?: { at: number; paths: Promise<string[]> };

  constructor(readonly cwd: string) {}

  async changes(): Promise<Changes> {
    const prefix = await repoPrefix(this.cwd);
    if (prefix === undefined) {
      return { git: false, reason: (await gitInstalled()) ? "no-repo" : "no-git", files: [], truncated: false };
    }
    const status = await git(this.cwd, [
      "status",
      "--porcelain=v1",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--",
      ".",
    ]);
    return parseStatus(status.stdout, prefix);
  }

  /** The workspace-relative path git should be given for `p`, checked to stay inside the workspace. */
  private relative(p: string): string {
    if (typeof p !== "string" || p === "" || p.includes("\0"))
      throw new WorkspaceError("invalid", "A path is required.");
    let target: string;
    try {
      target = resolveInside(this.cwd, p);
    } catch {
      throw new WorkspaceError("invalid", "That path is outside the workspace.");
    }
    const rel = path.relative(path.resolve(this.cwd), target);
    if (rel === "") throw new WorkspaceError("invalid", "A file path is required.");
    return rel.split(path.sep).join("/");
  }

  /** One file's changes against HEAD (staged and unstaged together). */
  async diff(file: string, from?: string): Promise<FileDiff> {
    const target = this.relative(file);
    const paths = from ? [this.relative(from), target] : [target];
    if ((await repoPrefix(this.cwd)) === undefined)
      throw new WorkspaceError("not_found", "This workspace is not a git repository.");

    const hasHead = (await git(this.cwd, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1])).code === 0;
    // A repository without a commit has no HEAD to compare with; what is staged is all that can be shown.
    let out = await git(this.cwd, ["diff", ...DIFF_FLAGS, ...(hasHead ? ["HEAD"] : ["--cached"]), "--", ...paths]);
    if (out.stdout.trim() === "") {
      const untracked = await git(this.cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", target]);
      if (untracked.stdout !== "") {
        out = await git(this.cwd, ["diff", ...DIFF_FLAGS, "--no-index", "--", "/dev/null", target], [0, 1]);
      }
    }
    const { text, truncated } = truncateText(out.stdout, MAX_DIFF_CHARS);
    return { path: target, diff: text, truncated };
  }

  private async allFiles(): Promise<string[]> {
    const now = Date.now();
    if (this.listing && now - this.listing.at < FILES_TTL_MS) return this.listing.paths;
    const paths = this.readListing();
    this.listing = { at: now, paths };
    paths.catch(() => {
      if (this.listing?.paths === paths) this.listing = undefined;
    });
    return paths;
  }

  private async readListing(): Promise<string[]> {
    try {
      const [listed, deleted] = await Promise.all([
        git(this.cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], [0, 128]),
        // Tracked files that are gone from the disk are still in the index, but there is nothing to mention.
        git(this.cwd, ["ls-files", "-z", "--deleted"], [0, 128]),
      ]);
      if (listed.code === 0) {
        const gone = new Set(deleted.stdout.split("\0"));
        const files = new Set(listed.stdout.split("\0").filter((p) => p !== "" && !gone.has(p)));
        return [...files].sort().slice(0, MAX_LISTED_FILES);
      }
    } catch (err) {
      if (!(err instanceof GitMissingError)) throw err;
    }
    return (await walk(path.resolve(this.cwd))).sort();
  }

  /** Files whose path matches `query`, for `@` references and the file list. */
  async files(query: string, limit: number): Promise<FileList> {
    const all = await this.allFiles();
    const files = rankPaths(all, query, Math.max(1, Math.min(limit, 200)));
    return { files, total: all.length };
  }

  async preview(file: string): Promise<FilePreview> {
    const rel = this.relative(file);
    if (rel === ".git" || rel.startsWith(".git/"))
      throw new WorkspaceError("invalid", "Git's own files are not shown.");
    const root = await realpath(path.resolve(this.cwd));
    let real: string;
    try {
      real = await realpath(path.join(root, rel));
    } catch {
      throw new WorkspaceError("not_found", "No such file.");
    }
    // A link inside the workspace must not lead out of it.
    const back = path.relative(root, real);
    if (back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
      throw new WorkspaceError("invalid", "That path is outside the workspace.");
    }
    const info = await lstat(real);
    if (!info.isFile()) throw new WorkspaceError("invalid", "That is not a file.");

    const handle = await open(real, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_PREVIEW_BYTES));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.subarray(0, 8000).includes(0)) {
        return { path: rel, content: "", binary: true, size: info.size, truncated: false };
      }
      return {
        path: rel,
        content: bytes.toString("utf8"),
        binary: false,
        size: info.size,
        truncated: info.size > bytesRead,
      };
    } finally {
      await handle.close();
    }
  }
}

async function gitInstalled(): Promise<boolean> {
  try {
    await git(process.cwd(), ["--version"]);
    return true;
  } catch {
    return false;
  }
}
