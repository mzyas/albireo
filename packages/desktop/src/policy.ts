// What the window lets a page do. Pure functions, so the rules can be tested without Electron.

/** Whether `url` is a page of the panel server (the origin the window was opened on). */
export function isPanelUrl(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * A link the page asked to open in a new window: only web and mail links go on, handed to the system's
 * own programs. Anything else (file:, javascript:, custom schemes that start other programs) is dropped.
 */
export function externalLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

// The page asks for none of the usual browser permissions (camera, location, notifications...). Copying
// text out of a code block writes to the clipboard, which Chromium counts as one.
const GRANTED = new Set(["clipboard-sanitized-write"]);

/** Whether `permission` is granted to the page at `url`. Everything not listed is refused. */
export function grantsPermission(permission: string, url: string | undefined, origin: string): boolean {
  return GRANTED.has(permission) && url !== undefined && isPanelUrl(url, origin);
}

/**
 * Whether a message from `frameUrl` may use the shell's powers (the folder picker). Only the panel's own
 * page: a frame that navigated elsewhere, or a page opened by a link, gets nothing.
 */
export function mayUseShell(frameUrl: string | undefined, origin: string): boolean {
  return frameUrl !== undefined && isPanelUrl(frameUrl, origin);
}
