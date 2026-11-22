import { createSignal } from "solid-js";

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
const [open, setOpen] = createSignal(saved.open ?? window.innerWidth >= 1100);
const [wide, setWide] = createSignal(saved.wide === true);

export const paneOpen = open;
export const paneWide = wide;
export const [paneTab, setPaneTab] = createSignal<PaneTab>("changes");

export function setPaneOpen(value: boolean): void {
  setOpen(value);
  writePref({ open: value, wide: wide() });
}
export function setPaneWide(value: boolean): void {
  setWide(value);
  writePref({ open: open(), wide: value });
}
export function openPane(tab: PaneTab): void {
  setPaneTab(tab);
  setPaneOpen(true);
}
