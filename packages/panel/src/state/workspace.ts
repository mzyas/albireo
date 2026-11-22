// What the side pane shows: the workspace's changes, one file's diff, the file list and a file preview.
// All of it is read from the server's /workspace routes; nothing here changes the workspace.
import { createSignal } from "solid-js";
import { api } from "../api.ts";
import { errorMessage } from "../lib/format.ts";
import type { ChangedFile, Changes, FileDiff, FileList, FilePreview, ServerEvent } from "../protocol.ts";

export type Remote<T> =
  | { state: "idle" }
  | { state: "loading"; data?: T }
  | { state: "ready"; data: T }
  | { state: "error"; error: string; data?: T };

const idle = { state: "idle" } as const;

/** What a request has so far: the data of the last answer (also while a newer one is loading). */
export function dataOf<T>(r: Remote<T>): T | undefined {
  return r.state === "idle" ? undefined : r.data;
}
export function errorOf<T>(r: Remote<T>): string | undefined {
  return r.state === "error" ? r.error : undefined;
}

/** Newer requests win: an answer that arrives after a later request was made is dropped. */
function latest() {
  let n = 0;
  return {
    next: () => ++n,
    current: (id: number) => id === n,
  };
}

const q = (params: Record<string, string | undefined>) =>
  Object.entries(params)
    .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

// ---- changes and the diff of one file ----------------------------------------------------------

export const [changes, setChanges] = createSignal<Remote<Changes>>(idle);
export const [selectedChange, setSelectedChange] = createSignal<ChangedFile | null>(null);
export const [diff, setDiff] = createSignal<Remote<FileDiff>>(idle);

const changesRequests = latest();
const diffRequests = latest();

export async function refreshChanges(): Promise<void> {
  const id = changesRequests.next();
  const before = changes();
  setChanges({ state: "loading", data: before.state === "idle" ? undefined : before.data });
  try {
    const data = await api<Changes>("/workspace/changes");
    if (!changesRequests.current(id)) return;
    setChanges({ state: "ready", data });
    // The file being looked at may have changed again.
    const open = selectedChange();
    if (open) void loadDiff(open, false);
  } catch (err) {
    if (!changesRequests.current(id)) return;
    setChanges({ state: "error", error: errorMessage(err), data: before.state === "idle" ? undefined : before.data });
  }
}

async function loadDiff(file: ChangedFile, showLoading: boolean): Promise<void> {
  const id = diffRequests.next();
  if (showLoading) setDiff({ state: "loading" });
  try {
    const data = await api<FileDiff>(`/workspace/diff?${q({ path: file.path, from: file.from })}`);
    if (diffRequests.current(id)) setDiff({ state: "ready", data });
  } catch (err) {
    if (diffRequests.current(id)) setDiff({ state: "error", error: errorMessage(err) });
  }
}

/** Opens a changed file's diff, or goes back to the list with `null`. */
export function selectChange(file: ChangedFile | null): void {
  setSelectedChange(file);
  if (file) void loadDiff(file, true);
  else {
    diffRequests.next();
    setDiff(idle);
  }
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
/** Refreshes soon, once, however many changes ask for it. */
export function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshChanges(), 300);
}

/** Calls whose result may have changed files: remembered from their `tool_call` until their result. */
const mayChange = new Set<string>();

/** Keeps the changes list current: after a tool that can write, and whenever a turn ends. */
export function noteEvent(ev: ServerEvent): void {
  switch (ev.type) {
    case "snapshot":
      mayChange.clear();
      void refreshChanges();
      return;
    case "tool_call":
      if (ev.risk !== "read") mayChange.add(ev.id);
      return;
    case "tool_result":
      if (mayChange.delete(ev.id)) scheduleRefresh();
      return;
    case "status":
      if (ev.state === "idle") scheduleRefresh();
      return;
  }
}

// ---- files -------------------------------------------------------------------------------------

export const [fileQuery, setFileQuery] = createSignal("");
export const [fileList, setFileList] = createSignal<Remote<FileList>>(idle);
export const [previewPath, setPreviewPath] = createSignal<string | null>(null);
export const [preview, setPreview] = createSignal<Remote<FilePreview>>(idle);

const listRequests = latest();
const previewRequests = latest();
let listTimer: ReturnType<typeof setTimeout> | undefined;

/** Files matching `query`, best first. Used by the file list and by `@` in the message box. */
export function fetchFiles(query: string, limit: number): Promise<FileList> {
  return api<FileList>(`/workspace/files?${q({ q: query, limit: String(limit) })}`);
}

/** Searches the file list; typing in quick succession makes one request. */
export function searchFiles(query: string, delay = 150): void {
  setFileQuery(query);
  clearTimeout(listTimer);
  listTimer = setTimeout(async () => {
    const id = listRequests.next();
    const before = fileList();
    setFileList({ state: "loading", data: before.state === "idle" ? undefined : before.data });
    try {
      const data = await fetchFiles(query, 100);
      if (listRequests.current(id)) setFileList({ state: "ready", data });
    } catch (err) {
      if (listRequests.current(id)) setFileList({ state: "error", error: errorMessage(err) });
    }
  }, delay);
}

export async function openFile(path: string | null): Promise<void> {
  setPreviewPath(path);
  const id = previewRequests.next();
  if (path === null) {
    setPreview(idle);
    return;
  }
  setPreview({ state: "loading" });
  try {
    const data = await api<FilePreview>(`/workspace/file?${q({ path })}`);
    if (previewRequests.current(id)) setPreview({ state: "ready", data });
  } catch (err) {
    if (previewRequests.current(id)) setPreview({ state: "error", error: errorMessage(err) });
  }
}
