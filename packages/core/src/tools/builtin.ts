import { exec } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { type AnyTool, defineTool } from "../tool.js";

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

const MAX_OUT = 30_000;

const runCommandTool = defineTool({
  name: "run_command",
  description: "Run a shell command in the workspace root (60s timeout). Returns stdout, stderr and the exit code.",
  risk: "exec",
  input: z.object({ command: z.string() }),
  async run({ command }, { cwd, signal }) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
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

export const builtinTools: AnyTool[] = [readFileTool, listDirTool, writeFileTool, runCommandTool];
