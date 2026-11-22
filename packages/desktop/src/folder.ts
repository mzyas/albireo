import path from "node:path";

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

/**
 * Asks the system's folder picker (`show` opens it) and returns the folder chosen, or null if the user
 * cancelled. `startIn` comes from the page, so it is only used if it is an absolute path, and only to
 * say where the picker opens: what is picked is still checked by the server before a session uses it.
 */
export async function pickFolder(
  show: (options: { defaultPath?: string }) => Promise<OpenDialogResult>,
  startIn: unknown,
): Promise<string | null> {
  const defaultPath = typeof startIn === "string" && path.isAbsolute(startIn) ? startIn : undefined;
  const result = await show({ defaultPath });
  const [folder] = result.filePaths;
  return result.canceled || folder === undefined ? null : folder;
}
