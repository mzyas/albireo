import { appendFile, open } from "node:fs/promises";
import path from "node:path";
import type { Message, Session } from "@albireo/core";
import { ensurePrivateDir, writeFileAtomic } from "./files.js";
import { encodeRecord, FORMAT_VERSION, type HeaderRecord, type SessionMeta, titleFromMessage } from "./format.js";

export interface RecordingOptions {
  /** Called for each failed write. Recording keeps going; the conversation is never interrupted. */
  onError?: (error: Error) => void;
}

/**
 * Writes a live session to disk as it happens: each message is appended to `<id>.jsonl` the moment
 * the session commits it, and `<id>.json` (title, model, counts) follows. Writes run one after
 * another in order; `flush()` waits for them. Nothing is created until the first message exists, so
 * starting and quitting leaves no empty sessions behind.
 */
export class Recording {
  readonly id: string;
  private meta: SessionMeta;
  private headerWritten: boolean;
  /** An existing file may end in a line cut off by a crash; the first append must not join onto it. */
  private lineStartChecked: boolean;
  private tail: Promise<void> = Promise.resolve();
  private metaQueued = false;
  private readonly stops: (() => void)[] = [];

  constructor(
    private readonly dir: string,
    session: Session,
    meta: SessionMeta,
    headerWritten: boolean,
    private readonly options: RecordingOptions = {},
  ) {
    this.id = meta.id;
    this.meta = { ...meta, provider: session.providerId, model: session.model };
    this.headerWritten = headerWritten;
    this.lineStartChecked = !headerWritten;
    this.stops.push(session.onMessage((m) => this.add(m)));
    this.stops.push(
      session.on((e) => {
        if (e.type !== "provider_changed") return;
        this.meta.provider = e.provider;
        this.meta.model = e.model;
        if (this.meta.messageCount > 0) this.queueMeta();
      }),
    );
  }

  /** What is currently known about the session (a copy). */
  get info(): SessionMeta {
    return { ...this.meta };
  }

  /** Resolves once everything queued so far has been written (or has failed and been reported). */
  async flush(): Promise<void> {
    for (let t = this.tail; ; t = this.tail) {
      await t;
      if (t === this.tail) return;
    }
  }

  /** Stops listening. Pending writes still complete; `flush()` to wait for them. */
  stop(): void {
    for (const off of this.stops.splice(0)) off();
  }

  private add(message: Message): void {
    const now = Date.now();
    let line: string;
    try {
      line = encodeRecord({ type: "message", at: now, message });
    } catch (err) {
      this.fail(err);
      return;
    }
    this.meta.messageCount++;
    this.meta.updatedAt = now;
    if (!this.meta.title) this.meta.title = titleFromMessage(message);
    this.enqueue(async () => {
      await this.ensureHeader();
      await this.ensureLineStart();
      await appendFile(this.file("jsonl"), line, { mode: 0o600 });
    });
    this.queueMeta();
  }

  /** Ends a line left unfinished by a crash, so the next record starts on its own line. */
  private async ensureLineStart(): Promise<void> {
    if (this.lineStartChecked) return;
    const handle = await open(this.file("jsonl"), "r");
    try {
      const { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) await appendFile(this.file("jsonl"), "\n", { mode: 0o600 });
      }
    } finally {
      await handle.close();
    }
    this.lineStartChecked = true;
  }

  private async ensureHeader(): Promise<void> {
    if (this.headerWritten) return;
    await ensurePrivateDir(this.dir);
    const header: HeaderRecord = {
      type: "session",
      v: FORMAT_VERSION,
      id: this.id,
      createdAt: this.meta.createdAt,
      cwd: this.meta.cwd,
    };
    // `wx`: never append to a file that already exists under this id.
    await appendFile(this.file("jsonl"), encodeRecord(header), { mode: 0o600, flag: "wx" });
    this.headerWritten = true;
  }

  /** One meta write covers every change made before it runs. */
  private queueMeta(): void {
    if (this.metaQueued) return;
    this.metaQueued = true;
    this.enqueue(async () => {
      this.metaQueued = false;
      await writeFileAtomic(this.file("json"), `${JSON.stringify({ v: FORMAT_VERSION, ...this.meta })}\n`);
    });
  }

  private enqueue(task: () => Promise<void>): void {
    this.tail = this.tail.then(task).catch((err) => this.fail(err));
  }

  private fail(err: unknown): void {
    this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  private file(ext: "jsonl" | "json"): string {
    return path.join(this.dir, `${this.id}.${ext}`);
  }
}
