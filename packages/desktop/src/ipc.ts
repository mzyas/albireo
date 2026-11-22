/**
 * The one message the page can send the shell (the folder picker, see `DesktopBridge`). The preload
 * script spells the same string: it runs sandboxed, where it can't import this file. A test keeps them equal.
 */
export const PICK_DIRECTORY = "albireo:pick-directory";
