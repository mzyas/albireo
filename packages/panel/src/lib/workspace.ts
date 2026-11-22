import type { ChangeStatus, Changes } from "../protocol.ts";

/** "src/lib/a.ts" → directory "src/lib/" and name "a.ts" (the directory is empty for a top-level file). */
export function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** The last folder of a workspace path, for the top bar. Handles both separators. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const STATUS_LETTER: Record<ChangeStatus, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

export const STATUS_LABEL: Record<ChangeStatus, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  conflicted: "Conflict",
};

/** Why the Changes tab has no list, or null when it does. */
export function noChangesReason(c: Changes): string | null {
  if (c.git) return null;
  return c.reason === "no-git"
    ? "Git is not installed, so changes can't be listed."
    : "This workspace is not a git repository, so changes can't be listed.";
}
