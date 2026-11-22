import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Session } from "@albireo/core";
import { type SecretManager, VaultError, type VaultErrorCode } from "@albireo/vault";
import { type ManagedSession, ManagerError, type ManagerErrorCode, SessionManager } from "./manager.js";
import { Workspace, WorkspaceError } from "./workspace.js";

export { defaultSessionsDir } from "./dirs.js";
export {
  type ManagedSession,
  ManagerError,
  type ManagerErrorCode,
  type ManagerOptions,
  type OpenOverrides,
  type ResumeChoice,
  resumeChoice,
  SessionManager,
} from "./manager.js";
export type * from "./protocol.js";

export interface PanelServerOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  /** Directory holding the built index.html. Defaults to the sibling @albireo/panel package's `dist/`. */
  publicDir?: URL;
  /** Enables the /secrets routes. Without it, GET /secrets answers `{ enabled: false }`. */
  secrets?: SecretManager;
}

export interface PanelServer {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY = 1_000_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const VAULT_STATUS: Record<VaultErrorCode, number> = {
  invalid: 400,
  bad_key: 401,
  uninitialized: 409,
  locked: 409,
  corrupt: 409,
  unavailable: 503,
};

function replyJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
}

function parseJsonObject(
  text: string,
  fail: (message: string) => Error = (message) => new VaultError("invalid", message),
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the body, which may hold a key.
    throw fail("The request body must be JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw fail("The request body must be an object.");
  }
  return value as Record<string, unknown>;
}

async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return parseJsonObject(await readBody(req));
}

/**
 * Vault and provider-config routes. Responses carry status and masked hints only, never a key.
 * Called after the Host and token checks, like every other route.
 */
async function handleSecrets(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  secrets: SecretManager | undefined,
): Promise<void> {
  try {
    if (req.method === "GET" && pathname === "/secrets") {
      // Pick up providers.json edits made by another process (CLI or a text editor). A failed
      // reload must not hide the status: the panel needs it to show what is wrong.
      const status = secrets ? await secrets.reloadProviderConfig().catch(() => secrets.status()) : { enabled: false };
      replyJson(res, 200, status);
      return;
    }
    if (!secrets) {
      replyJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method === "DELETE" && pathname.startsWith("/providers/")) {
      const rawId = pathname.slice("/providers/".length);
      let id: string;
      try {
        id = decodeURIComponent(rawId);
      } catch {
        throw new VaultError("invalid", "Invalid provider id.");
      }
      replyJson(res, 200, await secrets.deleteCustomProvider(id));
      return;
    }
    if (req.method !== "POST") {
      replyJson(res, 404, { error: "not found" });
      return;
    }
    switch (pathname) {
      case "/secrets/unlock":
        replyJson(res, 200, { ok: true, ...(await secrets.unlock(await readJsonObject(req))) });
        return;
      case "/secrets/provider":
        replyJson(res, 200, await secrets.setProvider(await readJsonObject(req)));
        return;
      case "/secrets/lock":
        replyJson(res, 200, await secrets.lock());
        return;
      case "/providers":
        replyJson(res, 200, await secrets.upsertProviderConfig(await readJsonObject(req)));
        return;
      default:
        replyJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    if (err instanceof VaultError) replyJson(res, VAULT_STATUS[err.code], { error: err.message, code: err.code });
    else replyJson(res, 500, { error: "internal error" }); // details may include file paths or key material
  }
}

/**
 * Read-only views of the workspace (changes, diffs, file list, preview). Called after the Host and token
 * checks, like every other route; nothing here writes, and failures never echo paths or git's output.
 */
async function handleWorkspace(res: http.ServerResponse, url: URL, workspace: Workspace): Promise<void> {
  try {
    const param = (name: string) => url.searchParams.get(name) ?? "";
    switch (url.pathname) {
      case "/workspace/changes":
        replyJson(res, 200, await workspace.changes());
        return;
      case "/workspace/diff":
        replyJson(res, 200, await workspace.diff(param("path"), param("from") || undefined));
        return;
      case "/workspace/files": {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        replyJson(res, 200, await workspace.files(param("q"), Number.isFinite(limit) ? limit : 50));
        return;
      }
      case "/workspace/file":
        replyJson(res, 200, await workspace.preview(param("path")));
        return;
      default:
        replyJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    if (err instanceof WorkspaceError) {
      replyJson(res, err.code === "not_found" ? 404 : 400, { error: err.message, code: err.code });
    } else {
      replyJson(res, 500, { error: "internal error" });
    }
  }
}

const SESSION_STATUS: Record<ManagerErrorCode, number> = { invalid: 400, not_found: 404, unsupported: 409 };

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ManagerError("invalid", `${key} must be text.`);
  return value;
}

/**
 * Routes for the sessions a server runs: list them, start one in a workspace, bring a saved one back,
 * delete one. Called after the Host and token checks, like every other route. Failures answer with the
 * manager's own message (written for the user) or a bare `internal error`, never paths or file contents.
 */
async function handleSessions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  manager: SessionManager,
): Promise<void> {
  try {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && req.method === "GET") {
      replyJson(res, 200, await manager.list());
      return;
    }
    if (parts.length === 1 && req.method === "POST") {
      // No body at all means "a new session with the defaults".
      const raw = await readBody(req);
      const fail = (message: string) => new ManagerError("invalid", message);
      const body = raw.trim() === "" ? {} : parseJsonObject(raw, fail);
      const managed = await manager.create({
        cwd: optionalString(body, "cwd"),
        provider: optionalString(body, "provider"),
        model: optionalString(body, "model"),
      });
      replyJson(res, 200, { session: manager.summarize(managed) });
      return;
    }
    let id = "";
    try {
      id = decodeURIComponent(parts[1] ?? "");
    } catch {
      throw new ManagerError("invalid", "Invalid session id.");
    }
    if (parts.length === 3 && parts[2] === "open" && req.method === "POST") {
      replyJson(res, 200, { session: manager.summarize(await manager.open(id)) });
      return;
    }
    if (parts.length === 2 && req.method === "DELETE") {
      await manager.delete(id);
      replyJson(res, 200, {});
      return;
    }
    replyJson(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof ManagerError) replyJson(res, SESSION_STATUS[err.code], { error: err.message, code: err.code });
    else replyJson(res, 500, { error: "internal error" });
  }
}

/**
 * Local-only bridge between the running sessions and the GUI panel. Hand it a `SessionManager` to
 * serve several sessions, or a single `Session`, which is served as the only one.
 * The agent can execute commands, so the server is locked down: loopback bind,
 * Host-header check (DNS rebinding), and a per-run secret token on every request.
 */
export async function startPanelServer(
  source: Session | SessionManager,
  opts: PanelServerOptions = {},
): Promise<PanelServer> {
  const manager = source instanceof SessionManager ? source : SessionManager.single(source);
  const token = randomBytes(24).toString("hex");
  const publicDir = opts.publicDir ?? new URL("../../panel/dist/", import.meta.url);
  let port = 0;
  const workspaces = new Map<string, Workspace>();
  const workspaceOf = (m: ManagedSession) => {
    const known = workspaces.get(m.session.cwd);
    if (known) return known;
    const workspace = new Workspace(m.session.cwd);
    workspaces.set(m.session.cwd, workspace);
    return workspace;
  };
  /** The session a request means: the one it names, or the first one when it names none. */
  const target = (id: unknown): ManagedSession | undefined =>
    typeof id === "string" && id !== "" ? manager.get(id) : manager.primary;
  const noSuchSession = (res: http.ServerResponse) =>
    replyJson(res, 404, { error: "No such session.", code: "not_found" });

  // Changes that aren't session events: tell every connected panel to re-fetch (`GET /secrets`,
  // `GET /sessions`), and end the stream of a session that is gone.
  const streams = new Set<{ res: http.ServerResponse; session: string }>();
  const broadcast = (type: string) => {
    for (const s of streams) s.res.write(`data: ${JSON.stringify({ type })}\n\n`);
  };
  const offSecrets = opts.secrets?.onChange(() => broadcast("secrets_changed"));
  const offChange = manager.onChange(() => broadcast("sessions_changed"));
  const offRemoved = manager.onRemoved((m) => {
    for (const s of [...streams]) if (s.session === m.id) s.res.end();
  });

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) {
        res.writeHead(403).end("forbidden host");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      const provided = url.searchParams.get("token") ?? String(req.headers["x-albireo-token"] ?? "");
      if (!safeEqual(provided, token)) {
        res.writeHead(401).end("unauthorized");
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        let html: string;
        try {
          html = await readFile(new URL("index.html", publicDir), "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          res
            .writeHead(503, { "content-type": "text/plain; charset=utf-8" })
            .end("The panel has not been built. Run `pnpm build` and reload.");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const managed = target(url.searchParams.get("session"));
        if (!managed) {
          noSuchSession(res);
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        // Subscribe and snapshot in the same tick so no event is missed or duplicated.
        const off = managed.session.on((e) => send(e));
        send({ type: "snapshot", ...managed.session.snapshot() });
        const stream = { res, session: managed.id };
        streams.add(stream);
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(keepAlive);
          streams.delete(stream);
          off();
        });
        return;
      }

      if (url.pathname === "/sessions" || url.pathname.startsWith("/sessions/")) {
        await handleSessions(req, res, url, manager);
        return;
      }

      if (
        url.pathname === "/secrets" ||
        url.pathname.startsWith("/secrets/") ||
        url.pathname === "/providers" ||
        url.pathname.startsWith("/providers/")
      ) {
        await handleSecrets(req, res, url.pathname, opts.secrets);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/workspace/")) {
        const managed = target(url.searchParams.get("session"));
        if (!managed) noSuchSession(res);
        else await handleWorkspace(res, url, workspaceOf(managed));
        return;
      }

      if (req.method === "POST" && url.pathname === "/command") {
        const cmd = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const managed = target(cmd.session);
        if (!managed) {
          noSuchSession(res);
          return;
        }
        const session = managed.session;
        switch (cmd.type) {
          case "send":
            if (typeof cmd.text !== "string" || !cmd.text.trim()) throw new Error("text required");
            void session.send(cmd.text);
            break;
          case "approve":
            if (typeof cmd.id !== "string") throw new Error("id required");
            session.approve(cmd.id, cmd.allow === true);
            break;
          case "abort":
            session.abort();
            break;
          case "retry":
            void session.retry();
            break;
          case "switch":
            if (typeof cmd.provider !== "string") throw new Error("provider required");
            session.switchProvider(cmd.provider, typeof cmd.model === "string" && cmd.model ? cmd.model : undefined);
            break;
          default:
            throw new Error(`unknown command: ${String(cmd.type)}`);
        }
        res.writeHead(202, { "content-type": "application/json" }).end("{}");
        return;
      }

      res.writeHead(404).end("not found");
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  const unsubscribe = () => {
    offSecrets?.();
    offChange();
    offRemoved();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    // A port that is taken must not leave this server's listeners on the manager: the caller may retry.
    unsubscribe();
    throw err;
  }
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        unsubscribe();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
