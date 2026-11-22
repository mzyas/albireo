import { stat } from "node:fs/promises";
import path from "node:path";
import { type AnyTool, loadInstructions, type Message, ProviderRegistry, type Risk, Session } from "@albireo/core";
import {
  newSessionId,
  type Recording,
  type SessionMeta,
  type SessionStore,
  StoreError,
  sameDir,
  titleFromMessage,
} from "@albireo/store";
import type { SessionSummary, SessionsResponse } from "./protocol.js";

export type ManagerErrorCode = "invalid" | "not_found" | "unsupported";

/** A request the manager can't carry out; the message is written for the panel's user. */
export class ManagerError extends Error {
  constructor(
    readonly code: ManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagerError";
  }
}

export interface ManagerOptions {
  registry: ProviderRegistry;
  tools: AnyTool[];
  /** Risk levels every session runs without asking. */
  autoApprove?: Risk[];
  /** Where conversations are saved and read from. Without it nothing is saved and nothing can be opened. */
  store?: SessionStore;
  /** Write conversations to `store` (default). False: saved sessions can still be opened, but nothing is changed on disk. */
  save?: boolean;
  /** The provider a new session uses unless asked otherwise. */
  provider: string;
  /** The workspace a new session uses unless asked otherwise. */
  cwd: string;
  /** Called for each failed write to the store; the conversation goes on. */
  onSaveError?: (error: Error) => void;
}

export interface ManagedSession {
  readonly id: string;
  readonly session: Session;
  readonly createdAt: number;
  /** Present while the conversation is being saved. */
  readonly recording?: Recording;
}

/** The provider and model a saved session goes back to. */
export interface ResumeChoice {
  provider: string;
  /** Only set when the session had chosen a model of its own. */
  model?: string;
  /** Something worth telling the user. */
  note?: string;
}

/**
 * A saved session returns to the provider it used, unless one is asked for. Its model comes back only
 * when it differs from that provider's default: otherwise a later change to the default would not
 * apply to it.
 */
export function resumeChoice(
  meta: Pick<SessionMeta, "provider" | "model">,
  registry: Pick<ProviderRegistry, "has" | "get">,
  fallback: string,
  explicit: { provider?: string; model?: string } = {},
): ResumeChoice {
  let provider = explicit.provider;
  let note: string | undefined;
  if (provider === undefined) {
    if (meta.provider && registry.has(meta.provider)) provider = meta.provider;
    else {
      provider = fallback;
      if (meta.provider) {
        note = `the saved session used provider "${meta.provider}", which is not available; using ${fallback}`;
      }
    }
  }
  const saved =
    provider === meta.provider && meta.model !== registry.get(provider).defaultModel ? meta.model : undefined;
  return { provider, model: explicit.model ?? saved, note };
}

/** What a caller can decide for a session it brings back, instead of what the session had. */
export interface OpenOverrides {
  cwd?: string;
  provider?: string;
  model?: string;
}

const MAX_SAVED_LISTED = 200;
const CHANGE_DELAY_MS = 40;

/**
 * The sessions one server runs. Each is an ordinary `Session` with its own workspace, history and
 * approvals; the manager starts them, brings saved ones back, saves them as they go, and tells
 * listeners when the list or a session's state changed.
 *
 * Several sessions can work at the same time. Nothing here limits where a session's workspace is
 * except that it must be a real folder and not a filesystem root, so whoever can reach the manager
 * can point an agent at any folder the user can: the server's token and loopback checks are what
 * guard that.
 */
export class SessionManager {
  private readonly live = new Map<string, ManagedSession>();
  private readonly opening = new Map<string, Promise<ManagedSession>>();
  private readonly stops = new Map<string, () => void>();
  private readonly changeListeners = new Set<() => void>();
  private readonly addedListeners = new Set<(m: ManagedSession) => void>();
  private readonly removedListeners = new Set<(m: ManagedSession) => void>();
  private changeTimer?: ReturnType<typeof setTimeout>;
  private primaryId: string | null = null;

  constructor(
    private readonly options: ManagerOptions,
    /** False for a manager that only shows the one session it was handed (see `single`). */
    readonly canCreate = true,
  ) {}

  /** A manager for one fixed session that was built elsewhere: it can be listed and used, nothing else. */
  static single(session: Session): SessionManager {
    const manager = new SessionManager(
      { registry: new ProviderRegistry(), tools: [], provider: "", cwd: session.cwd },
      false,
    );
    manager.add({ id: newSessionId(), session, createdAt: Date.now() });
    return manager;
  }

  get cwd(): string {
    return this.options.cwd;
  }
  get provider(): string {
    return this.options.provider;
  }
  /** What a request without a session id means: the first session, or the one that took its place. */
  get primary(): ManagedSession | undefined {
    return this.primaryId ? this.live.get(this.primaryId) : undefined;
  }
  get(id: string): ManagedSession | undefined {
    return this.live.get(id);
  }
  /** Every session in memory, oldest first. */
  sessions(): ManagedSession[] {
    return [...this.live.values()];
  }

  // ---- starting, opening and ending sessions ---------------------------------------------------

  /** Starts a session in `cwd` (the manager's by default). Nothing is saved until the first message. */
  async create(opts: { cwd?: string; provider?: string; model?: string } = {}): Promise<ManagedSession> {
    this.requireCreate();
    const cwd = await checkWorkspace(opts.cwd ?? this.options.cwd);
    const provider = opts.provider ?? this.options.provider;
    if (!this.options.registry.has(provider)) throw new ManagerError("invalid", `Unknown provider "${provider}".`);
    const session = await this.build({ cwd, provider, model: opts.model || undefined });
    return this.start(session, cwd);
  }

  /**
   * Brings a saved session into memory (or returns it if it already is). It goes back to the workspace,
   * provider and model it had, unless `overrides` say otherwise (the command line does that).
   */
  async open(id: string, overrides: OpenOverrides = {}): Promise<ManagedSession> {
    this.requireCreate();
    const live = this.live.get(id);
    if (live) return live;
    let pending = this.opening.get(id);
    if (!pending) {
      // Two requests for the same session must not make two copies: both would write to one file.
      pending = this.restore(id, overrides).finally(() => this.opening.delete(id));
      this.opening.set(id, pending);
    }
    return pending;
  }

  /** Aborts and forgets a session, and deletes what was saved of it. */
  async delete(id: string): Promise<void> {
    this.requireCreate();
    const managed = this.live.get(id);
    if (!managed && !this.options.store) throw new ManagerError("not_found", "No session with that id.");
    if (managed) await this.stop(managed);
    if (this.options.store) {
      try {
        await this.options.store.delete(id);
      } catch (err) {
        // A session that never got a message was never written.
        if (!(managed && err instanceof StoreError && err.code === "not_found")) throw toManagerError(err);
      }
    }
  }

  /** Waits until everything written so far is on disk. */
  async flush(): Promise<void> {
    await Promise.all([...this.live.values()].map((m) => m.recording?.flush()));
  }

  /** Stops every session's recording and forgets them all, e.g. when the server shuts down. */
  async dispose(): Promise<void> {
    for (const managed of [...this.live.values()]) {
      managed.session.abort();
      managed.recording?.stop();
    }
    await this.flush();
    for (const managed of [...this.live.values()]) this.forget(managed);
    clearTimeout(this.changeTimer);
    this.changeTimer = undefined;
    this.changeListeners.clear();
  }

  // ---- listing ---------------------------------------------------------------------------------

  async list(): Promise<SessionsResponse> {
    let saved: SessionMeta[] = [];
    if (this.options.store) {
      try {
        saved = (await this.options.store.list()).slice(0, MAX_SAVED_LISTED);
      } catch {
        // An unreadable store leaves the live sessions listable.
      }
    }
    const rows = new Map<string, SessionSummary>();
    for (const meta of saved) {
      rows.set(meta.id, {
        id: meta.id,
        title: meta.title,
        cwd: meta.cwd,
        provider: meta.provider,
        model: meta.model,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        messageCount: meta.messageCount,
        live: false,
        status: "idle",
        pending: 0,
      });
    }
    for (const managed of this.live.values()) rows.set(managed.id, this.summarize(managed));
    const sessions = [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));

    const workspaces: string[] = [];
    for (const { cwd } of sessions) if (!workspaces.some((w) => sameDir(w, cwd))) workspaces.push(cwd);
    if (!workspaces.some((w) => sameDir(w, this.options.cwd))) workspaces.push(this.options.cwd);
    return { sessions, workspaces, primary: this.primaryId, canCreate: this.canCreate, cwd: this.options.cwd };
  }

  summarize(managed: ManagedSession): SessionSummary {
    const { session } = managed;
    const info = managed.recording?.info;
    const history = session.history;
    const firstUser = history.find((m) => m.role === "user");
    const lastAt = history.reduce((at, m) => Math.max(at, m.meta?.at ?? 0), 0);
    return {
      id: managed.id,
      title: info?.title ?? (firstUser ? titleFromMessage(firstUser) : ""),
      cwd: session.cwd,
      provider: session.providerId,
      model: session.model,
      createdAt: managed.createdAt,
      updatedAt: info?.updatedAt ?? (lastAt || managed.createdAt),
      messageCount: info?.messageCount ?? history.length,
      live: true,
      status: session.status,
      pending: session.pendingApprovals,
    };
  }

  // ---- watching --------------------------------------------------------------------------------

  /**
   * Called (soon, and once for a burst) when the list or any session's state changed: a session was
   * added or removed, started or finished a turn, asked for or got an answer to an approval, got a
   * message or switched model.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * Runs `visit` for every session now and for each one that starts later. What `visit` returns is
   * called when that session is forgotten. Returns a function that stops visiting (and cleans up).
   */
  each(visit: (session: Session, id: string) => (() => void) | undefined): () => void {
    const cleanups = new Map<string, () => void>();
    const added = (m: ManagedSession) => {
      const cleanup = visit(m.session, m.id);
      if (cleanup) cleanups.set(m.id, cleanup);
    };
    const removed = (m: ManagedSession) => {
      cleanups.get(m.id)?.();
      cleanups.delete(m.id);
    };
    for (const m of this.live.values()) added(m);
    this.addedListeners.add(added);
    this.removedListeners.add(removed);
    return () => {
      this.addedListeners.delete(added);
      this.removedListeners.delete(removed);
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    };
  }

  /** Ends the SSE-style streams of a session when it goes away. */
  onRemoved(listener: (m: ManagedSession) => void): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  // ---- internals -------------------------------------------------------------------------------

  private requireCreate(): void {
    if (!this.canCreate) throw new ManagerError("unsupported", "This server runs a single session.");
  }

  private async build(opts: { cwd: string; provider: string; model?: string; history?: Message[] }): Promise<Session> {
    try {
      return new Session({
        providers: this.options.registry,
        provider: opts.provider,
        model: opts.model,
        tools: this.options.tools,
        cwd: opts.cwd,
        autoApprove: this.options.autoApprove,
        instructions: await loadInstructions(opts.cwd),
        history: opts.history,
      });
    } catch (err) {
      throw new ManagerError("invalid", err instanceof Error ? err.message : "The session could not be started.");
    }
  }

  private save(): boolean {
    return this.options.store !== undefined && this.options.save !== false;
  }

  /** Adds a session that has no saved file yet. */
  private start(session: Session, cwd: string): ManagedSession {
    const recording = this.save()
      ? this.options.store?.record(session, { cwd, onError: this.options.onSaveError })
      : undefined;
    return this.add({ id: recording?.id ?? newSessionId(), session, createdAt: Date.now(), recording });
  }

  private async restore(id: string, overrides: OpenOverrides): Promise<ManagedSession> {
    const store = this.options.store;
    if (!store) throw new ManagerError("not_found", "Sessions are not saved on this server.");
    let loaded: Awaited<ReturnType<SessionStore["load"]>>;
    try {
      loaded = await store.load(id);
    } catch (err) {
      throw toManagerError(err);
    }
    let cwd = loaded.meta.cwd;
    if (overrides.cwd !== undefined) cwd = await checkWorkspace(overrides.cwd);
    else if (!(await isFolder(cwd))) {
      throw new ManagerError("invalid", `This session's workspace (${cwd}) no longer exists.`);
    }
    const choice = resumeChoice(loaded.meta, this.options.registry, this.options.provider, overrides);
    const session = await this.build({
      cwd,
      provider: choice.provider,
      model: choice.model,
      history: loaded.messages,
    });
    const recording = this.save()
      ? store.resume(session, loaded.meta, { onError: this.options.onSaveError })
      : undefined;
    return this.add({ id, session, createdAt: loaded.meta.createdAt, recording });
  }

  private add(managed: ManagedSession): ManagedSession {
    this.live.set(managed.id, managed);
    this.primaryId ??= managed.id;
    const { session } = managed;
    const offs = [
      session.on((e) => {
        if (
          e.type === "status" ||
          e.type === "approval_request" ||
          e.type === "approval_resolved" ||
          e.type === "provider_changed"
        ) {
          this.changed();
        }
      }),
      session.onMessage(() => this.changed()),
    ];
    this.stops.set(managed.id, () => {
      for (const off of offs) off();
    });
    for (const listener of [...this.addedListeners]) listener(managed);
    this.changed();
    return managed;
  }

  /** Aborts the session, lets its turn unwind, finishes its writes and forgets it. */
  private async stop(managed: ManagedSession): Promise<void> {
    const { session } = managed;
    if (session.status === "running") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5000);
        const off = session.on((e) => {
          if (e.type === "status" && e.state === "idle") {
            clearTimeout(timer);
            off();
            resolve();
          }
        });
        session.abort();
      });
    }
    managed.recording?.stop();
    await managed.recording?.flush();
    this.forget(managed);
  }

  private forget(managed: ManagedSession): void {
    if (this.live.get(managed.id) !== managed) return;
    this.live.delete(managed.id);
    this.stops.get(managed.id)?.();
    this.stops.delete(managed.id);
    if (this.primaryId === managed.id) this.primaryId = [...this.live.keys()].pop() ?? null;
    for (const listener of [...this.removedListeners]) listener(managed);
    this.changed();
  }

  private changed(): void {
    if (this.changeTimer || this.changeListeners.size === 0) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      for (const listener of [...this.changeListeners]) listener();
    }, CHANGE_DELAY_MS);
    this.changeTimer.unref();
  }
}

/** The absolute path of an existing folder that may be a workspace. */
export async function checkWorkspace(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.trim() === "")
    throw new ManagerError("invalid", "A workspace folder is required.");
  if (!path.isAbsolute(value)) throw new ManagerError("invalid", "The workspace must be an absolute path.");
  const resolved = path.resolve(value);
  if (path.parse(resolved).root === resolved) {
    throw new ManagerError("invalid", "A drive or filesystem root can't be a workspace; pick a folder inside it.");
  }
  if (!(await isFolder(resolved))) throw new ManagerError("invalid", "That folder does not exist.");
  return resolved;
}

async function isFolder(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function toManagerError(err: unknown): ManagerError {
  if (err instanceof ManagerError) return err;
  if (err instanceof StoreError) {
    // Store messages are written for users and never quote file contents.
    return new ManagerError(err.code === "not_found" ? "not_found" : "invalid", err.message);
  }
  return new ManagerError("invalid", "The session could not be read.");
}
