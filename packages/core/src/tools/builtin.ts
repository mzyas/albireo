import { exec } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type AnyTool, defineTool } from "../tool.js";
import { applyEdit } from "./edit.js";
import { formatSearchResult, runSearch } from "./search.js";

const execAsync = promisify(exec);

/** Model-supplied paths are untrusted: resolve and reject anything outside the workspace. */
export function resolveInside(cwd: string, p: string): string {
  const root = path.resolve(cwd);
  const target = path.resolve(root, p);
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${p}`);
  }
  return target;
}

const MAX_READ = 200_000;

const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace.",
  risk: "read",
  input: z.object({ path: z.string().describe("Path relative to the workspace root") }),
  async run({ path: p }, { cwd }) {
    const text = await readFile(resolveInside(cwd, p), "utf8");
    return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…[truncated]` : text;
  },
});

const listDirTool = defineTool({
  name: "list_dir",
  description: "List entries of a directory inside the workspace. Directories end with '/'.",
  risk: "read",
  input: z.object({ path: z.string().default(".").describe("Directory relative to the workspace root") }),
  async run({ path: p }, { cwd }) {
    const entries = await readdir(resolveInside(cwd, p), { withFileTypes: true });
    return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
  },
});

const writeFileTool = defineTool({
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file inside the workspace.",
  risk: "write",
  input: z.object({
    path: z.string().describe("Path relative to the workspace root"),
    contents: z.string(),
  }),
  async run({ path: p, contents }, { cwd }) {
    const target = resolveInside(cwd, p);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    return `wrote ${contents.length} chars to ${p}`;
  },
});

const MAX_EDIT_BYTES = 2_000_000;

const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Edit an existing UTF-8 text file in the workspace by replacing an exact string. old_string must match " +
    "the file exactly (whitespace and indentation included) and be unique: include enough surrounding lines " +
    "to make it so, or set replace_all to change every occurrence. Prefer this over write_file for changes " +
    "to existing files, and read the file first.",
  risk: "write",
  input: z.object({
    path: z.string().describe("Path relative to the workspace root"),
    old_string: z.string().describe("The exact text to replace"),
    new_string: z.string().describe("The replacement text; may be empty to delete"),
    replace_all: z.boolean().default(false).describe("Replace every occurrence instead of requiring a unique match"),
  }),
  async run({ path: p, old_string, new_string, replace_all }, { cwd }) {
    const target = resolveInside(cwd, p);
    const buf = await readFile(target);
    if (buf.length > MAX_EDIT_BYTES) throw new Error(`${p} is too large to edit (limit ${MAX_EDIT_BYTES} bytes).`);
    const text = buf.toString("utf8");
    // Writing back text that did not decode cleanly (binary, other encodings) would corrupt the file.
    if (buf.includes(0) || !Buffer.from(text, "utf8").equals(buf)) {
      throw new Error(`${p} is not a UTF-8 text file, so it cannot be edited safely.`);
    }
    const edit = applyEdit(text, old_string, new_string, replace_all);
    await writeFile(target, edit.text, "utf8");
    return edit.count === 1
      ? `Edited ${p}: replaced 1 occurrence at line ${edit.line}.`
      : `Edited ${p}: replaced ${edit.count} occurrences (the first at line ${edit.line}).`;
  },
});

const MAX_MATCHES = 100;

const grepTool = defineTool({
  name: "grep",
  description:
    "Search file contents in the workspace with a regular expression (JavaScript syntax, matched against " +
    "one line at a time). Returns one `path:line: text` line per match, with paths you can pass to read_file. " +
    "Skips .git and node_modules, binary files, files over 1 MB, and symbolic links.",
  risk: "read",
  input: z.object({
    pattern: z.string().min(1).describe("Regular expression, e.g. `function\\s+\\w+`"),
    path: z.string().default(".").describe("File or directory to search, relative to the workspace root"),
    include: z
      .string()
      .optional()
      .describe("Glob over paths below `path`, e.g. `*.ts` (any depth) or `src/**/*.tsx`; supports * ** ? {a,b}"),
    ignore_case: z.boolean().default(false),
  }),
  async run({ pattern, path: p, include, ignore_case }, { cwd, signal }) {
    const result = await runSearch(
      {
        target: resolveInside(cwd, p),
        root: path.resolve(cwd),
        pattern,
        ignoreCase: ignore_case,
        include,
        maxMatches: MAX_MATCHES,
      },
      { signal },
    );
    return formatSearchResult(result, MAX_MATCHES);
  },
});

const MAX_OUT = 30_000;

/** Credentials a parent shell may still export; commands run by the model never see them. */
const SECRET_ENV = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY"]);

/** Copy of `env` without known LLM credentials. Names compare case-insensitively (Windows). */
export function commandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!SECRET_ENV.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}

const runCommandTool = defineTool({
  name: "run_command",
  description: "Run a shell command in the workspace root (60s timeout). Returns stdout, stderr and the exit code.",
  risk: "exec",
  input: z.object({ command: z.string() }),
  async run({ command }, { cwd, signal }) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        env: commandEnv(),
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        signal,
      });
      return clip(`exit 0\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`);
    } catch (err) {
      const e = err as { code?: number | string; stdout?: string; stderr?: string; message: string };
      if (signal?.aborted) throw err;
      return clip(`exit ${e.code ?? "?"}\n${e.stdout ?? ""}\n[stderr]\n${e.stderr ?? e.message}`);
    }
  },
});

function clip(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n…[truncated]` : s;
}

export const builtinTools: AnyTool[] = [
  readFileTool,
  listDirTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
];
