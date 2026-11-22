import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { globToRegExp, matchesGlob } from "./glob.js";

/** Directories that are never searched below the search root. */
const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 200;
const BINARY_PROBE = 8000;

/** Plain data only: it is copied to the worker thread. */
export interface SearchOptions {
  /** Absolute path of the file or directory to search. */
  target: string;
  /** Absolute workspace root; reported paths are relative to it, so they work as tool arguments. */
  root: string;
  /** JavaScript regular expression, matched against one line at a time. */
  pattern: string;
  ignoreCase: boolean;
  /** Glob over paths below `target`; without a `/` it matches file names at any depth. */
  include?: string;
  maxMatches: number;
}

export interface SearchResult {
  /** `path:line: text`, in path order. */
  lines: string[];
  filesWithMatches: number;
  filesSearched: number;
  /** Binary files, files over the size limit, and files that could not be read. */
  skipped: number;
  /** True when the search stopped at `maxMatches`. */
  truncated: boolean;
}

function compile(pattern: string, ignoreCase: boolean): RegExp {
  // Try Unicode mode first so `\p{L}` works, then fall back for patterns it rejects (`\-`, `\ `).
  const flags = ignoreCase ? "i" : "";
  try {
    return new RegExp(pattern, `${flags}u`);
  } catch {
    try {
      return new RegExp(pattern, flags);
    } catch (err) {
      throw new Error(`Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The line, cut to a readable length around the first match. */
function excerpt(line: string, matchIndex: number): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const start = Math.max(0, Math.min(matchIndex - 60, line.length - MAX_LINE_CHARS));
  const end = start + MAX_LINE_CHARS;
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

async function* walk(dir: string, rel: string): AsyncGenerator<{ abs: string; rel: string }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    // Links are not followed: one could lead out of the workspace.
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(abs, relPath);
    } else if (e.isFile()) {
      yield { abs, rel: relPath };
    }
  }
}

/** Searches the files; runs inside the worker thread (see `runSearch`). */
export async function searchFiles(o: SearchOptions): Promise<SearchResult> {
  const re = compile(o.pattern, o.ignoreCase);
  const include = o.include ? { re: globToRegExp(o.include), slash: o.include.includes("/") } : undefined;
  const shown = (abs: string) => path.relative(o.root, abs).split(path.sep).join("/") || ".";

  let info: Stats;
  try {
    info = await stat(o.target);
  } catch {
    throw new Error(`path not found: ${shown(o.target)}`);
  }

  const result: SearchResult = { lines: [], filesWithMatches: 0, filesSearched: 0, skipped: 0, truncated: false };
  const files = info.isDirectory()
    ? walk(o.target, "")
    : (async function* () {
        yield { abs: o.target, rel: path.basename(o.target) };
      })();

  for await (const file of files) {
    if (include && info.isDirectory() && !matchesGlob(include.re, include.slash, file.rel)) continue;

    let buf: Buffer;
    try {
      if ((await stat(file.abs)).size > MAX_FILE_BYTES) {
        result.skipped++;
        continue;
      }
      buf = await readFile(file.abs);
    } catch {
      result.skipped++;
      continue;
    }
    if (buf.subarray(0, BINARY_PROBE).includes(0)) {
      result.skipped++;
      continue;
    }

    result.filesSearched++;
    const lines = buf.toString("utf8").split("\n");
    let hit = false;
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] as string).replace(/\r$/, "");
      const m = re.exec(line);
      if (!m) continue;
      if (result.lines.length >= o.maxMatches) {
        result.truncated = true;
        if (hit) result.filesWithMatches++;
        return result;
      }
      hit = true;
      result.lines.push(`${shown(file.abs)}:${i + 1}: ${excerpt(line, m.index)}`);
    }
    if (hit) result.filesWithMatches++;
  }
  return result;
}

export interface RunSearchOptions {
  signal?: AbortSignal;
  /** Default 30 s. */
  timeoutMs?: number;
}

/**
 * Runs `searchFiles` in a worker thread. The pattern comes from the model, and a pattern with
 * catastrophic backtracking would otherwise freeze the whole kernel (event stream included); here it
 * can be stopped by the timeout or by the user aborting the turn.
 */
export function runSearch(options: SearchOptions, run: RunSearchOptions = {}): Promise<SearchResult> {
  const timeoutMs = run.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    if (run.signal?.aborted) {
      reject(new Error("Search aborted."));
      return;
    }
    const worker = new Worker(new URL("./search-worker.js", import.meta.url), {
      workerData: options,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      settle();
    };
    const onAbort = () => finish(() => reject(new Error("Search aborted.")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(
              `Search timed out after ${+(timeoutMs / 1000).toFixed(1)}s; the pattern may be too expensive. Use a simpler pattern or a narrower path or include.`,
            ),
          ),
        ),
      timeoutMs,
    );
    run.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (msg: { result?: SearchResult; error?: string }) =>
      finish(() => (msg.result ? resolve(msg.result) : reject(new Error(msg.error ?? "Search failed.")))),
    );
    worker.once("error", (err: unknown) =>
      finish(() => reject(new Error(`Search failed: ${err instanceof Error ? err.message : String(err)}`))),
    );
    worker.once("exit", (code) => finish(() => reject(new Error(`Search stopped unexpectedly (exit code ${code}).`))));
  });
}

/** What the model sees. */
export function formatSearchResult(r: SearchResult, maxMatches: number): string {
  const skipped = r.skipped > 0 ? ` Skipped ${r.skipped} binary, oversized or unreadable files.` : "";
  if (r.lines.length === 0) return `No matches in ${r.filesSearched} files.${skipped}`;
  const limit = r.truncated
    ? ` Stopped at the limit of ${maxMatches} matches; narrow the pattern, path or include to see the rest.`
    : "";
  return `${r.lines.join("\n")}\n\n${r.lines.length} matches in ${r.filesWithMatches} files.${limit}${skipped}`;
}
