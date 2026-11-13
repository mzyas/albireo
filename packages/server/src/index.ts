import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import type { Session } from "@albireo/core";

export interface PanelServerOptions {
  /** 0 (default) picks a free port. */
  port?: number;
  /** Directory holding index.html. Defaults to the sibling @albireo/panel package. */
  publicDir?: URL;
}

export interface PanelServer {
  url: string;
  token: string;
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

/**
 * Local-only bridge between a running Session and the GUI panel.
 * The agent can execute commands, so the server is locked down: loopback bind,
 * Host-header check (DNS rebinding), and a per-run secret token on every request.
 */
export async function startPanelServer(session: Session, opts: PanelServerOptions = {}): Promise<PanelServer> {
  const token = randomBytes(24).toString("hex");
  const publicDir = opts.publicDir ?? new URL("../../panel/public/", import.meta.url);
  let port = 0;

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
        const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(keepAlive);
          off();
        });
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
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
