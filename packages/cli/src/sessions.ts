import path from "node:path";
import { parseArgs } from "node:util";
import { type ListFilter, type LoadedSession, type SessionMeta, type SessionStore, StoreError } from "@albireo/store";
import { defaultVaultDir } from "@albireo/vault";

export const SESSIONS_HELP = `albireo sessions — list and delete saved conversations

Usage: albireo sessions [list] [--all] [--cwd <dir>]
       albireo sessions delete <id>

Conversations are saved automatically, in your user config dir (outside every workspace).
Continue one with \`albireo --continue\` (the latest of this workspace) or \`albireo --resume <id>\`.

  list              show saved sessions of this workspace, newest first (the default command)
      --all         show the sessions of every workspace
      --cwd <dir>   the workspace to list         (default: current dir)
  delete <id>       delete a saved session for good
  -h, --help
`;

/** Where conversations are kept: beside the vault, never inside a workspace. */
export function defaultSessionsDir(): string {
  return path.join(defaultVaultDir(), "sessions");
}

export interface SessionsIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface ChooseOptions {
  /** `--continue`: the most recent session of `cwd`. */
  continueLast: boolean;
  /** `--resume <id>`. */
  id?: string;
  cwd: string;
}

export interface Choice {
  loaded?: LoadedSession;
  /** Something worth telling the user, e.g. that there was nothing to continue. */
  note?: string;
}

/**
 * Picks the session to continue, if any. An explicit id that can't be loaded is an error (a
 * `StoreError`); `--continue` with nothing to continue just starts a new session.
 */
export async function chooseSession(store: SessionStore, opts: ChooseOptions): Promise<Choice> {
  if (opts.id !== undefined) return { loaded: await store.load(opts.id) };
  if (!opts.continueLast) return {};
  const latest = await store.latest(opts.cwd);
  if (!latest) return { note: "no earlier session in this directory; starting a new one" };
  return { loaded: await store.load(latest.id) };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local time, to the minute: `2026-11-22 10:30`. */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatSessionList(sessions: SessionMeta[], showWorkspace: boolean): string {
  const idWidth = Math.max(2, ...sessions.map((s) => s.id.length));
  const row = (id: string, time: string, count: string, workspace: string, title: string) =>
    `${id.padEnd(idWidth)}  ${time.padEnd(16)}  ${count.padStart(4)}  ${showWorkspace ? `${workspace}  ` : ""}${title}`.trimEnd();
  const lines = [row("ID", "UPDATED", "MSGS", "WORKSPACE", "TITLE")];
  for (const s of sessions) {
    lines.push(row(s.id, formatTime(s.updatedAt), String(s.messageCount), s.cwd, clip(s.title || "(untitled)", 60)));
  }
  return `${lines.join("\n")}\n`;
}

function parseSessionsArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

/** `albireo sessions …`. Returns the exit code. */
export async function runSessionsCommand(
  argv: string[],
  io: SessionsIO,
  store: SessionStore,
  defaultCwd: string,
): Promise<number> {
  let parsed: ReturnType<typeof parseSessionsArgs>;
  try {
    parsed = parseSessionsArgs(argv);
  } catch (err) {
    io.stderr(`albireo: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { values } = parsed;
  const [command = "list", ...rest] = parsed.positionals;

  if (values.help) {
    io.stdout(SESSIONS_HELP);
    return 0;
  }

  try {
    if (command === "list") {
      if (rest.length > 0) {
        io.stderr("albireo: sessions list takes no arguments\n");
        return 2;
      }
      const cwd = path.resolve(values.cwd ?? defaultCwd);
      const filter: ListFilter = values.all ? {} : { cwd };
      const sessions = await store.list(filter);
      if (sessions.length === 0) {
        io.stdout(
          values.all ? "No saved sessions.\n" : `No saved sessions for ${cwd}. Use --all to see every workspace.\n`,
        );
        return 0;
      }
      io.stdout(formatSessionList(sessions, values.all));
      return 0;
    }
    if (command === "delete") {
      const [id, ...extra] = rest;
      if (id === undefined || extra.length > 0) {
        io.stderr("albireo: usage: albireo sessions delete <id>\n");
        return 2;
      }
      await store.delete(id);
      io.stdout(`Deleted session ${id}.\n`);
      return 0;
    }
  } catch (err) {
    // StoreError messages are written for users; anything else may carry paths, so keep it generic.
    io.stderr(`albireo: ${err instanceof StoreError ? err.message : "could not read the saved sessions"}\n`);
    return 1;
  }
  io.stderr(`albireo: unknown sessions command "${command}" (see albireo sessions --help)\n`);
  return 2;
}
