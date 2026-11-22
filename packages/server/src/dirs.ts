import path from "node:path";
import { defaultVaultDir } from "@albireo/vault";

/**
 * Where conversations are kept: beside the vault (in `dir`, the per-user config dir by default), never
 * inside a workspace. The command line and the desktop app both use this, so they see the same sessions.
 */
export function defaultSessionsDir(dir: string = defaultVaultDir()): string {
  return path.join(dir, "sessions");
}
