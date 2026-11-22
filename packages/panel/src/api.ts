import { errorMessage } from "./lib/format.ts";
import type { Command } from "./protocol.ts";

/** The server hands the page its token in the URL; every request must carry it. */
export const token = new URLSearchParams(location.search).get("token") ?? "";

export async function api<T>(path: string, body?: unknown, method?: "GET" | "POST" | "DELETE"): Promise<T> {
  const headers: Record<string, string> = { "x-albireo-token": token };
  const resolved = method ?? (body === undefined ? "GET" : "POST");
  const init: RequestInit =
    body === undefined
      ? { method: resolved, headers }
      : { method: resolved, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data as T;
}

/** Sends a command to the kernel. Resolves to an error message, or null on success. */
export async function postCommand(cmd: Command): Promise<string | null> {
  try {
    await api("/command", cmd);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}
