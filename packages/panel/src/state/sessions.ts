// Which sessions the server has, and which one the page shows. The page shows one session at a time:
// switching reconnects the event stream to the other one (see connection.ts).
import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { api, setApiSession } from "../api.ts";
import { errorMessage } from "../lib/format.ts";
import { chooseActive } from "../lib/sessions.ts";
import type { CreateSessionBody, SessionSummary, SessionsResponse } from "../protocol.ts";

const PREF = "albireo.session";

/** The session looked at last, so a reload comes back to it. */
function readPref(): string | null {
  try {
    return localStorage.getItem(PREF);
  } catch {
    return null;
  }
}
function writePref(id: string): void {
  try {
    localStorage.setItem(PREF, id);
  } catch {
    // Storage can be blocked; the page just starts at the server's default next time.
  }
}

// A store, not a signal: the list is fetched again at every change (a running session changes often),
// and `reconcile` keeps the row of a session that is still there as the same object, so what the
// sidebar keeps per row (a delete asking to be confirmed, the focus) is not thrown away each time.
const [listStore, setListStore] = createStore<{ value: SessionsResponse | null }>({ value: null });
export const sessions = (): SessionsResponse | null => listStore.value;
export const [activeId, setActiveId] = createSignal<string | null>(null);
/** The last thing that went wrong with listing, opening, starting or deleting a session. */
export const [sessionError, setSessionError] = createSignal("");

export const activeSession = (): SessionSummary | undefined => sessions()?.sessions.find((s) => s.id === activeId());

/** The page now shows `id`: commands and workspace requests are for it from here on. */
function activate(id: string | null): void {
  setApiSession(id);
  setActiveId(id);
  if (id) writePref(id);
}

let listRequests = 0;
let autoStarting = false;

/** Starts a session because there is none to show. Several list updates in a row start only one. */
async function autoStart(cwd: string): Promise<void> {
  if (autoStarting) return;
  autoStarting = true;
  try {
    await create({ cwd });
  } finally {
    autoStarting = false;
  }
}

/**
 * Fetches the session list and keeps the page on a session that exists: the one shown if it is still
 * there, else the one looked at last, else the server's default. When there is none, one is started.
 */
export async function loadSessions(): Promise<void> {
  const request = ++listRequests;
  let fresh: SessionsResponse;
  try {
    fresh = await api<SessionsResponse>("/sessions");
  } catch (err) {
    if (request === listRequests) setSessionError(errorMessage(err));
    return;
  }
  if (request !== listRequests) return;
  setListStore("value", reconcile(fresh, { key: "id", merge: true }));

  const chosen = chooseActive(fresh, activeId(), readPref());
  if (chosen === activeId() && chosen !== null) return;
  if (chosen !== null) {
    const row = fresh.sessions.find((s) => s.id === chosen);
    if (row && !row.live && !(await open(chosen))) {
      // It can't be opened (its workspace may be gone): don't leave the page empty.
      if (fresh.canCreate) await autoStart(fresh.cwd);
      return;
    }
    activate(chosen);
    return;
  }
  if (fresh.canCreate) await autoStart(fresh.cwd);
}

/** Brings a saved session into the server's memory. Returns false, with the reason shown, if it can't. */
async function open(id: string): Promise<boolean> {
  try {
    await api(`/sessions/${encodeURIComponent(id)}/open`, {}, "POST");
    return true;
  } catch (err) {
    setSessionError(errorMessage(err));
    return false;
  }
}

async function create(body: CreateSessionBody): Promise<string | null> {
  try {
    const { session } = await api<{ session: SessionSummary }>("/sessions", body);
    activate(session.id);
    void loadSessions();
    return null;
  } catch (err) {
    const message = errorMessage(err);
    setSessionError(message);
    return message;
  }
}

/** Shows another session, bringing it back from disk first if it is not running. */
export async function selectSession(id: string): Promise<void> {
  if (id === activeId()) return;
  setSessionError("");
  const row = sessions()?.sessions.find((s) => s.id === id);
  if (row && !row.live && !(await open(id))) return;
  activate(id);
}

/** Starts a session in `cwd` and shows it. Resolves to the reason when it can't. */
export function startSession(body: CreateSessionBody): Promise<string | null> {
  setSessionError("");
  return create(body);
}

export async function removeSession(id: string): Promise<void> {
  setSessionError("");
  try {
    await api(`/sessions/${encodeURIComponent(id)}`, undefined, "DELETE");
  } catch (err) {
    setSessionError(errorMessage(err));
    return;
  }
  if (id === activeId()) activate(null);
  await loadSessions();
}
