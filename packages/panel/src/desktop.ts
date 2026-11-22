import type { DesktopBridge } from "./protocol.ts";

/**
 * What the desktop app's window gives the page (`window.albireo`), or undefined in a plain browser.
 * Checked by shape, not trusted by name: a page that is not the app's has no such thing.
 */
export function desktopBridge(): DesktopBridge | undefined {
  const bridge = (window as { albireo?: Partial<DesktopBridge> }).albireo;
  return typeof bridge?.pickDirectory === "function" ? (bridge as DesktopBridge) : undefined;
}
