import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Session } from "@albireo/core";
import { type SecretManager, VaultError, type VaultErrorCode } from "@albireo/vault";

export interface PanelServerOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  /** Directory holding index.html. Defaults to the sibling @albireo/panel package. */
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

async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readBody(req));
  } catch {
    // Not the parser's message: it quotes the body, which may hold a key.
    throw new VaultError("invalid", "The request body must be JSON.");
  }
  if (typeof value !== "object" || value === null)
    throw new VaultError("invalid", "The request body must be an object.");
  return value as Record<string, unknown>;
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
      if (secrets) await secrets.reloadProviderConfig().catch(() => {});
      replyJson(res, 200, secrets ? secrets.status() : { enabled: false });
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
 * Local-only bridge between a running Session and the GUI panel.
 * The agent can execute commands, so the server is locked down: loopback bind,
 * Host-header check (DNS rebinding), and a per-run secret token on every request.
 */
export async function startPanelServer(session: Session, opts: PanelServerOptions = {}): Promise<PanelServer> {
  const token = randomBytes(24).toString("hex");
  const publicDir = opts.publicDir ?? new URL("../../panel/public/", import.meta.url);
  let port = 0;
  // Vault changes aren't session events; tell every connected panel to re-fetch GET /secrets.
  const streams = new Set<http.ServerResponse>();
  const offSecrets = opts.secrets?.onChange(() => {
    for (const s of streams) s.write(`data: ${JSON.stringify({ type: "secrets_changed" })}\n\n`);
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
        const html = await readFile(new URL("index.html", publicDir), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
        return;
      }

      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        // Subscribe and snapshot in the same tick so no event is missed or duplicated.
        const off = session.on((e) => send(e));
        send({ type: "snapshot", ...session.snapshot() });
        streams.add(res);
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(keepAlive);
          streams.delete(res);
          off();
        });
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

      if (req.method === "POST" && url.pathname === "/command") {
        const cmd = JSON.parse(await readBody(req)) as Record<string, unknown>;
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

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        offSecrets?.();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
