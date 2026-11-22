import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./fs.js";

/**
 * Holds the vault's 256-bit master key in an OS credential store. One interface so another
 * backend can be dropped in later. Not Electron's `safeStorage`: only an Electron process can read
 * what it wrote, so the command line could no longer open a vault the desktop app made (and the
 * other way round). The desktop app uses `defaultProtector` like the command line does.
 */
export interface KeyProtector {
  /** Human-readable name, e.g. "Windows DPAPI". */
  readonly label: string;
  /** Whether the store works in this environment. May spawn a process. */
  available(): Promise<boolean>;
  save(masterKey: Buffer): Promise<void>;
  /** The stored key, or null when nothing is stored. Throws when the store is unreachable. */
  load(): Promise<Buffer | null>;
  clear(): Promise<void>;
}

const SERVICE = "com.albireo.vault";
const ACCOUNT = "master-key";
const TIMEOUT_MS = 30_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn without a shell. Secrets travel over stdin/stdout only, never in argv (visible to other processes). */
function run(cmd: string, args: string[], input = ""): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, timeout: TIMEOUT_MS, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {}); // EPIPE if the child exits before reading
    child.stdin.end(input);
  });
}

function decodeKey(text: string): Buffer | null {
  const trimmed = text.trim();
  return trimmed ? Buffer.from(trimmed, "base64") : null;
}

// ---- Windows: DPAPI (CurrentUser scope) via Windows PowerShell ------------------------------

/** Bound into the DPAPI blob so other DPAPI users on this account can't be tricked into decrypting it. */
const DPAPI_ENTROPY = "albireo-vault-v1";

function dpapiScript(op: "Protect" | "Unprotect"): string {
  // Static script; the data arrives on stdin, so nothing user-controlled is ever parsed as code.
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    "$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    `$out = [Security.Cryptography.ProtectedData]::${op}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    "[Console]::Out.Write([Convert]::ToBase64String($out))",
  ].join("\n");
}

export class DpapiProtector implements KeyProtector {
  readonly label = "Windows DPAPI";
  private probe?: Promise<boolean>;

  /** @param file where the DPAPI-wrapped key is stored (e.g. `%APPDATA%\albireo\master.dpapi`). */
  constructor(readonly file: string) {}

  private async dpapi(op: "Protect" | "Unprotect", data: Buffer): Promise<Buffer> {
    // Absolute path: never pick up a powershell.exe planted in the current directory or PATH.
    const exe = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script = Buffer.from(dpapiScript(op), "utf16le").toString("base64");
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", script];
    const res = await run(exe, args, data.toString("base64"));
    const out = res.code === 0 ? decodeKey(res.stdout) : null;
    if (!out) throw new Error(`DPAPI ${op} failed (exit ${res.code})`);
    return out;
  }

  available(): Promise<boolean> {
    if (process.platform !== "win32") return Promise.resolve(false);
    this.probe ??= this.dpapi("Protect", Buffer.from([0])).then(
      () => true,
      () => false,
    );
    return this.probe;
  }

  async save(masterKey: Buffer): Promise<void> {
    const wrapped = await this.dpapi("Protect", masterKey);
    await writeFileAtomic(this.file, `${wrapped.toString("base64")}\n`);
  }

  async load(): Promise<Buffer | null> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const wrapped = decodeKey(text);
    return wrapped ? this.dpapi("Unprotect", wrapped) : null;
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

// ---- macOS: login Keychain via /usr/bin/security --------------------------------------------

const SECURITY = "/usr/bin/security";

export class MacKeychainProtector implements KeyProtector {
  readonly label = "macOS Keychain";

  async available(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      return (await run(SECURITY, ["default-keychain"])).code === 0;
    } catch {
      return false;
    }
  }

  async save(masterKey: Buffer): Promise<void> {
    // `security -i` reads commands from stdin, which keeps the key out of argv. Base64 needs no quoting.
    const line = `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l ${SERVICE} -w ${masterKey.toString("base64")}\n`;
    const res = await run(SECURITY, ["-i"], line);
    if (res.code !== 0) throw new Error(`security add-generic-password failed (exit ${res.code})`);
  }

  async load(): Promise<Buffer | null> {
    const res = await run(SECURITY, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    if (res.code === 44) return null; // errSecItemNotFound
    if (res.code !== 0) throw new Error(`security find-generic-password failed (exit ${res.code})`);
    return decodeKey(res.stdout);
  }

  async clear(): Promise<void> {
    await run(SECURITY, ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]);
  }
}

// ---- Linux: Secret Service via secret-tool (libsecret) --------------------------------------

const ATTRS = ["service", SERVICE, "account", ACCOUNT];

export class SecretServiceProtector implements KeyProtector {
  readonly label = "Secret Service";

  async available(): Promise<boolean> {
    // SSH sessions, containers and WSL without a desktop usually have no session bus.
    if (process.platform !== "linux" || !process.env.DBUS_SESSION_BUS_ADDRESS) return false;
    try {
      // "Not found" is exit 1 with empty stderr; a missing or broken service prints an error.
      const res = await run("secret-tool", ["lookup", ...ATTRS]);
      return res.code === 0 || (res.code === 1 && res.stderr.trim() === "");
    } catch {
      return false; // secret-tool not installed
    }
  }

  async save(masterKey: Buffer): Promise<void> {
    const res = await run(
      "secret-tool",
      ["store", "--label=Albireo vault master key", ...ATTRS],
      masterKey.toString("base64"),
    );
    if (res.code !== 0) throw new Error(`secret-tool store failed (exit ${res.code})`);
  }

  async load(): Promise<Buffer | null> {
    const res = await run("secret-tool", ["lookup", ...ATTRS]);
    if (res.code === 1 && res.stderr.trim() === "") return null;
    if (res.code !== 0) throw new Error(`secret-tool lookup failed (exit ${res.code})`);
    return decodeKey(res.stdout);
  }

  async clear(): Promise<void> {
    await run("secret-tool", ["clear", ...ATTRS]);
  }
}

/** The platform's credential store, or null where none is supported. */
export function defaultProtector(dir: string): KeyProtector | null {
  switch (process.platform) {
    case "win32":
      return new DpapiProtector(path.join(dir, "master.dpapi"));
    case "darwin":
      return new MacKeychainProtector();
    case "linux":
      return new SecretServiceProtector();
    default:
      return null;
  }
}

/** In-memory store for tests. `available: false` simulates a machine without a credential store. */
export class MemoryKeyProtector implements KeyProtector {
  readonly label = "memory";
  private stored: Buffer | null = null;

  constructor(private readonly isAvailable = true) {}

  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async save(masterKey: Buffer): Promise<void> {
    if (!this.isAvailable) throw new Error("unavailable");
    this.stored = Buffer.from(masterKey);
  }
  async load(): Promise<Buffer | null> {
    return this.stored ? Buffer.from(this.stored) : null;
  }
  async clear(): Promise<void> {
    this.stored?.fill(0);
    this.stored = null;
  }
}
