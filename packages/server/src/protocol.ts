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
