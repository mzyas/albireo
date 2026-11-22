import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Conversations hold source code and command output, so they get the vault's treatment: a private
// directory under the per-user config dir, never inside a workspace. (These few helpers are not
// shared with @albireo/vault on purpose: the store has no reason to depend on the credential vault.)

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone. Windows ignores POSIX modes (the profile ACL applies).
  if (process.platform !== "win32") await chmod(dir, 0o700);
}

/** Write to a private temp file in the same directory, then rename over the target. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  await ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** On Windows a scanner or indexer can briefly hold the target open; retry a few times. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        throw err;
      }
      await sleep(50 * (attempt + 1));
    }
  }
}
