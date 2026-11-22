import { readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Message, Session } from "@albireo/core";
import {
  assertValidId,
  isValidId,
  newSessionId,
  parseHeader,
  parseMessageRecord,
  parseMeta,
  type SessionMeta,
  StoreError,
  sameDir,
  titleFromMessage,
} from "./format.js";
import { Recording, type RecordingOptions } from "./recording.js";

export interface LoadedSession {
  meta: SessionMeta;
  messages: Message[];
  /** Lines of the file that could not be read (cut off by a crash, or damaged) and were left out. */
  skipped: number;
}

export interface ListFilter {
  /** Only sessions that ran in this workspace. */
  cwd?: string;
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Sessions on disk, one `<id>.jsonl` (append-only: a header, then one line per message) and one
 * `<id>.json` (title, model, counts, so listing doesn't read whole conversations) per session.
 *
 * The `.jsonl` file is the truth: the `.json` file is a cache that is rebuilt from it if it is lost
 * or damaged. There is no cross-process lock; two processes recording into one session would
 * interleave their messages.
 */
export class SessionStore {
  constructor(readonly dir: string) {}

  private file(id: string, ext: "jsonl" | "json"): string {
    assertValidId(id);
    return path.join(this.dir, `${id}.${ext}`);
  }

  /** Starts recording a session that is new. Nothing is written until its first message. */
  record(session: Session, opts: { cwd: string } & RecordingOptions): Recording {
    const now = Date.now();
    const meta: SessionMeta = {
      id: newSessionId(),
      createdAt: now,
      updatedAt: now,
      cwd: path.resolve(opts.cwd),
      title: "",
      provider: session.providerId,
      model: session.model,
      messageCount: 0,
    };
    return new Recording(this.dir, session, meta, false, opts);
  }

  /** Continues recording a session that was loaded from here: new messages are appended to its file. */
  resume(session: Session, meta: SessionMeta, opts: RecordingOptions = {}): Recording {
    assertValidId(meta.id);
    return new Recording(this.dir, session, meta, true, opts);
  }

  async load(id: string): Promise<LoadedSession> {
    assertValidId(id);
    let raw: string;
    try {
      raw = await readFile(this.file(id, "jsonl"), "utf8");
    } catch (err) {
      if (isMissing(err)) throw new StoreError("not_found", "No session with that id.");
      throw new StoreError("corrupt", "The session file could not be read.");
    }

    const lines = raw.split("\n");
    let i = 0;
    while (i < lines.length && (lines[i] as string).trim() === "") i++;
    const header = parseHeader(lines[i] ?? "", id);

    const messages: Message[] = [];
    let skipped = 0;
    let lastAt = header.createdAt;
    for (const line of lines.slice(i + 1)) {
      if (line.trim() === "") continue;
      const record = parseMessageRecord(line);
      if (!record) {
        skipped++;
        continue;
      }
      messages.push(record.message);
      lastAt = record.at;
    }

    // The messages decide counts and times; the cache only knows what they can't: the title and the
    // provider or model chosen after the last message.
    const cached = await this.readMeta(id);
    const lastAssistant = messages.findLast((m) => m.role === "assistant");
    const meta: SessionMeta = {
      id,
      createdAt: header.createdAt,
      updatedAt: lastAt,
      cwd: header.cwd,
      title: cached?.title || (messages.map(titleFromMessage).find(Boolean) ?? ""),
      provider: cached?.provider ?? lastAssistant?.meta?.provider ?? lastAssistant?.native?.provider ?? "",
      model: cached?.model ?? lastAssistant?.meta?.model ?? lastAssistant?.native?.model ?? "",
      messageCount: messages.length,
    };
    return { meta, messages, skipped };
  }

  /** Newest first. Files that are not sessions, or are too damaged to describe, are left out. */
  async list(filter: ListFilter = {}): Promise<SessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
    const ids = names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length));
    const found = await Promise.all(
      ids.filter(isValidId).map(
        async (id) =>
          (await this.readMeta(id)) ??
          (await this.load(id).then(
            (l) => l.meta,
            () => undefined,
          )),
      ),
    );
    const cwd = filter.cwd;
    return found
      .filter((m): m is SessionMeta => m !== undefined)
      .filter((m) => cwd === undefined || sameDir(m.cwd, cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  }

  /** The most recently used session of a workspace. */
  async latest(cwd: string): Promise<SessionMeta | undefined> {
    return (await this.list({ cwd }))[0];
  }

  async delete(id: string): Promise<void> {
    const messages = this.file(id, "jsonl");
    const cache = this.file(id, "json");
    try {
      await unlink(messages);
    } catch (err) {
      if (isMissing(err)) throw new StoreError("not_found", "No session with that id.");
      throw err;
    }
    await unlink(cache).catch((err) => {
      if (!isMissing(err)) throw err;
    });
  }

  private async readMeta(id: string): Promise<SessionMeta | undefined> {
    try {
      return parseMeta(await readFile(this.file(id, "json"), "utf8"), id);
    } catch {
      return undefined;
    }
  }
}
