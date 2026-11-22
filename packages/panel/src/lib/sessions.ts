import type { SessionSummary, SessionsResponse } from "../protocol.ts";

export function sessionTitle(s: Pick<SessionSummary, "title">): string {
  return s.title || "New session";
}

/** How long ago, in the fewest words: "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function formatAgo(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The same folder written two ways (slashes, a trailing one, the case of a Windows drive path) is one key. */
export function workspaceKey(cwd: string): string {
  const unified = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(unified) || unified.startsWith("//") ? unified.toLowerCase() : unified;
}

function segments(cwd: string): string[] {
  return cwd.split(/[\\/]+/).filter(Boolean);
}

export interface WorkspaceGroup {
  cwd: string;
  /** The folder's name, with its parent too when two workspaces would otherwise look the same. */
  name: string;
  /** Newest first. */
  sessions: SessionSummary[];
}

/** Sessions grouped by workspace, the workspace with the most recently used session first. */
export function groupByWorkspace(sessions: readonly SessionSummary[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))) {
    const key = workspaceKey(s.cwd);
    const group = groups.get(key);
    if (group) group.sessions.push(s);
    else groups.set(key, { cwd: s.cwd, name: segments(s.cwd).at(-1) ?? s.cwd, sessions: [s] });
  }
  const all = [...groups.values()];
  const count = new Map<string, number>();
  for (const g of all) count.set(g.name, (count.get(g.name) ?? 0) + 1);
  for (const g of all) {
    if ((count.get(g.name) ?? 0) > 1) g.name = segments(g.cwd).slice(-2).join("/");
  }
  return all;
}

/**
 * The session to show: the one already shown if it still exists, then the one the user looked at last,
 * then the server's default, then the newest. Null when there is none (a new one has to be started).
 */
export function chooseActive(list: SessionsResponse, current: string | null, preferred: string | null): string | null {
  const ids = new Set(list.sessions.map((s) => s.id));
  for (const id of [current, preferred, list.primary]) {
    if (id && ids.has(id)) return id;
  }
  return list.sessions[0]?.id ?? null;
}

/** How many sessions are waiting for the user to answer a tool call. */
export function waitingCount(sessions: readonly SessionSummary[]): number {
  return sessions.filter((s) => s.pending > 0).length;
}
