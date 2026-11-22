import { createSignal } from "solid-js";

/** 0 while the page has not been laid out yet (it says nothing then, so it counts as a wide screen). */
const viewportWidth = () => window.innerWidth;
export function isNarrow(): boolean {
  const w = viewportWidth();
  return w > 0 && w <= 900;
}

export const [keysOpen, setKeysOpen] = createSignal(false);

/** Whether the conversation follows new output. The composer sets it when the user sends. */
export const [stickToBottom, setStickToBottom] = createSignal(true);

let composer: HTMLTextAreaElement | undefined;
export function registerComposer(el: HTMLTextAreaElement | undefined): void {
  composer = el;
}
/** True while the user has typed something into the message box, so nothing should steal focus. */
export function composerBusy(): boolean {
  return composer !== undefined && document.activeElement === composer && composer.value.trim() !== "";
}

// ---- the message box takes text from elsewhere ("Edit" on the last message) ---------------------

/** Each request has its own number, so asking for the same text twice still counts as a change. */
export const [composerRequest, setComposerRequest] = createSignal<{ text: string; n: number } | null>(null);
let requests = 0;
export function requestComposerText(text: string): void {
  setComposerRequest({ text, n: ++requests });
}

// ---- sessions sidebar and the "new session" dialog -----------------------------------------------

const SIDEBAR_PREF = "albireo.sidebar";

function readSidebarPref(): boolean | undefined {
  try {
    const raw = localStorage.getItem(SIDEBAR_PREF);
    return raw === "open" ? true : raw === "closed" ? false : undefined;
  } catch {
    return undefined;
  }
}

const [sidebar, setSidebar] = createSignal(readSidebarPref() ?? !isNarrow());
export const sidebarOpen = sidebar;
export function setSidebarOpen(value: boolean): void {
  setSidebar(value);
  try {
    localStorage.setItem(SIDEBAR_PREF, value ? "open" : "closed");
  } catch {
    // Storage can be blocked; the sidebar just forgets its state on reload.
  }
  if (value && narrow()) setOpen(false);
}

export const [newSessionOpen, setNewSessionOpen] = createSignal(false);

// ---- model switcher (opened by `/model`) -------------------------------------------------------

export const [switcherOpen, setSwitcherOpen] = createSignal(false);

// ---- side pane ---------------------------------------------------------------------------------

export type PaneTab = "changes" | "files" | "context";

const PREF = "albireo.pane";

function readPref(): { open?: boolean; wide?: boolean } {
  try {
    const raw = localStorage.getItem(PREF);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return typeof parsed === "object" && parsed !== null ? (parsed as { open?: boolean; wide?: boolean }) : {};
  } catch {
    return {};
  }
}

function writePref(value: { open: boolean; wide: boolean }): void {
  try {
    localStorage.setItem(PREF, JSON.stringify(value));
  } catch {
    // Storage can be blocked; the pane just forgets its state on reload.
  }
}

const saved = readPref();
/** Open by default when there is room for it beside the conversation. */
const [open, setOpen] = createSignal(saved.open ?? (viewportWidth() === 0 || viewportWidth() >= 1100));
const [wide, setWide] = createSignal(saved.wide === true);

/** On a narrow screen the sidebar and the pane cover the conversation, so only one of them is open at a time. */
const narrow = isNarrow;

export const paneOpen = open;
export const paneWide = wide;
export const [paneTab, setPaneTab] = createSignal<PaneTab>("changes");

export function setPaneOpen(value: boolean): void {
  setOpen(value);
  writePref({ open: value, wide: wide() });
  if (value && narrow()) setSidebarOpen(false);
}
export function setPaneWide(value: boolean): void {
  setWide(value);
  writePref({ open: open(), wide: value });
}
export function openPane(tab: PaneTab): void {
  setPaneTab(tab);
  setPaneOpen(true);
}
