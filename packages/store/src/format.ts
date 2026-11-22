import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ContentPart, Message } from "@albireo/core";

/** Version of the file format. Bump it when the records change in a way old readers can't handle. */
export const FORMAT_VERSION = 1;

/** What is known about a stored session without reading its messages. */
export interface SessionMeta {
  id: string;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** The workspace the session ran in. */
  cwd: string;
  /** The first line the user wrote, until something better exists. */
  title: string;
  provider: string;
  model: string;
  messageCount: number;
}

export type StoreErrorCode = "invalid_id" | "not_found" | "corrupt" | "unsupported";

/** `message` is safe to show to a user; it never quotes file contents. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

// ---- ids -------------------------------------------------------------------------------------

// An id becomes a file name, and it arrives from the command line: no separators, no leading dot, no
// trailing dot (Windows drops it), and not a Windows device name (`CON.jsonl` opens the console).
const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id) && !DEVICE_NAME.test(id);
}

export function assertValidId(id: string): void {
  if (!isValidId(id)) throw new StoreError("invalid_id", "Invalid session id.");
}

/** Sortable and readable: `20261122-103045-a1b2c3` (UTC date and time, then a random suffix). */
export function newSessionId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

// ---- records ---------------------------------------------------------------------------------

/** Line 1 of a session file. */
export interface HeaderRecord {
  type: "session";
  v: number;
  id: string;
  createdAt: number;
  cwd: string;
}

export interface MessageRecord {
  type: "message";
  at: number;
  message: Message;
}

export function encodeRecord(record: HeaderRecord | MessageRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPart(p: unknown): p is ContentPart {
  if (!isObject(p)) return false;
  switch (p.type) {
    case "text":
      return typeof p.text === "string";
    case "tool_call":
      return typeof p.id === "string" && typeof p.name === "string";
    case "tool_result":
      return typeof p.callId === "string" && typeof p.content === "string";
    default:
      return false;
  }
}

/**
 * A message from disk is fed to a model provider, so check its shape instead of trusting it. The
 * payload of `native` is opaque (it belongs to a provider adapter), but its identity fields are checked.
 */
export function isMessage(m: unknown): m is Message {
  if (!isObject(m)) return false;
  if (m.role !== "user" && m.role !== "assistant") return false;
  if (!Array.isArray(m.content) || !m.content.every(isPart)) return false;
  if (m.native !== undefined) {
    if (!isObject(m.native) || typeof m.native.provider !== "string" || typeof m.native.model !== "string")
      return false;
  }
  if (m.meta !== undefined && !isObject(m.meta)) return false;
  return true;
}

export function parseHeader(line: string, expectedId: string): HeaderRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new StoreError("corrupt", "The session file does not start with a valid header.");
  }
  if (!isObject(value) || value.type !== "session" || typeof value.v !== "number") {
    throw new StoreError("corrupt", "The session file does not start with a valid header.");
  }
  if (value.v > FORMAT_VERSION) {
    throw new StoreError("unsupported", "This session was saved by a newer version of Albireo.");
  }
  if (value.id !== expectedId || typeof value.createdAt !== "number" || typeof value.cwd !== "string") {
    throw new StoreError("corrupt", "The session file does not match its name.");
  }
  return { type: "session", v: value.v, id: value.id, createdAt: value.createdAt, cwd: value.cwd };
}

export function parseMessageRecord(line: string): MessageRecord | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (isObject(value) && value.type === "message" && typeof value.at === "number" && isMessage(value.message)) {
      return { type: "message", at: value.at, message: value.message };
    }
  } catch {
    // A line cut off by a crash, or garbage: the caller counts it as skipped.
  }
  return undefined;
}

export function parseMeta(text: string, id: string): SessionMeta | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (
      isObject(v) &&
      v.id === id &&
      typeof v.createdAt === "number" &&
      typeof v.updatedAt === "number" &&
      typeof v.cwd === "string" &&
      typeof v.title === "string" &&
      typeof v.provider === "string" &&
      typeof v.model === "string" &&
      typeof v.messageCount === "number"
    ) {
      return {
        id,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
        cwd: v.cwd,
        title: v.title,
        provider: v.provider,
        model: v.model,
        messageCount: v.messageCount,
      };
    }
  } catch {
    // Treated as missing: the meta file is only a cache of what the messages say.
  }
  return undefined;
}

// ---- titles and paths ------------------------------------------------------------------------

const TITLE_MAX = 80;

/** The first non-empty line of what the user wrote, squeezed to one short line. */
export function titleFromMessage(message: Message): string {
  if (message.role !== "user") return "";
  const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const squeezed = line.replace(/\s+/g, " ").trim();
  return squeezed.length > TITLE_MAX ? `${squeezed.slice(0, TITLE_MAX - 1)}…` : squeezed;
}

/** Whether two workspace paths name the same directory (case-insensitive on Windows). */
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}
