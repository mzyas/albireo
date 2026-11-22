// Wire types of the workspace routes. Types only, no imports: the panel reads them through the
// `@albireo/server/protocol` export, so a change here breaks its build instead of its runtime.

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ChangedFile {
  /** Relative to the workspace root, with `/` separators. */
  path: string;
  /** For a rename: where the file was. */
  from?: string;
  status: ChangeStatus;
  staged: boolean;
  unstaged: boolean;
}

/** `GET /workspace/changes` */
export interface Changes {
  /** False when the workspace is not inside a git repository (or git is not installed). */
  git: boolean;
  reason?: "no-git" | "no-repo";
  branch?: string;
  detached?: boolean;
  files: ChangedFile[];
  /** More files changed than are listed. */
  truncated: boolean;
}

/** `GET /workspace/diff?path=&from=` */
export interface FileDiff {
  path: string;
  /** Unified diff against HEAD; empty when the file has no changes. */
  diff: string;
  truncated: boolean;
}

/** `GET /workspace/files?q=&limit=` */
export interface FileList {
  /** Best match first. */
  files: string[];
  /** How many files the workspace has in all. */
  total: number;
}

/** `GET /workspace/file?path=` */
export interface FilePreview {
  path: string;
  /** Empty for a binary file. */
  content: string;
  binary: boolean;
  /** Size on disk in bytes. */
  size: number;
  truncated: boolean;
}

/** Every workspace route answers `{ error, code }` with a 4xx status when it can't serve the request. */
export interface WorkspaceFailure {
  error: string;
  code?: "invalid" | "not_found";
}

// ---- sessions ---------------------------------------------------------------------------------

/** One row of the session list: a session running in this server, or one saved on disk. */
export interface SessionSummary {
  id: string;
  /** The first thing the user said; empty before they have said anything. */
  title: string;
  /** The workspace the session works in. */
  cwd: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** In memory in this server. A saved session that is not live is opened before it can be used. */
  live: boolean;
  /** Only live sessions run; the rest are idle. */
  status: "idle" | "running";
  /** Tool calls waiting for an answer (live sessions only). */
  pending: number;
}

/** `GET /sessions` */
export interface SessionsResponse {
  /** Newest first. */
  sessions: SessionSummary[];
  /** Workspaces the user has used, most recent first: a choice for a new session. */
  workspaces: string[];
  /** What a request without a `session` means; null when nothing is running. */
  primary: string | null;
  /** False when the server runs one fixed session and can't start or open others. */
  canCreate: boolean;
  /** The workspace a new session starts in unless told otherwise. */
  cwd: string;
}

/** `POST /sessions`: every field is optional. */
export interface CreateSessionBody {
  cwd?: string;
  provider?: string;
  model?: string;
}

/** Every session route answers `{ error, code }` with a 4xx status when it can't do what was asked. */
export interface SessionFailure {
  error: string;
  code: "invalid" | "not_found" | "unsupported";
}
