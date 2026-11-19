import { parseArgs } from "node:util";
import {
  BUILTIN_PROVIDER_IDS,
  createVaultRegistry,
  MIN_PASSPHRASE,
  ProviderConfigStore,
  type ProviderId,
  type ProviderSecretView,
  SecretManager,
  type SecretsStatus,
  VaultError,
  VaultStore,
} from "@albireo/vault";
import { CancelledError, promptHidden, readStdin } from "./tty.js";

const BUILTIN_IDS = BUILTIN_PROVIDER_IDS.join(" | ");

export const KEYS_HELP = `albireo keys — manage the API keys in the encrypted vault without the panel

Usage:
  albireo keys [status]            show the vault and what is stored per provider
  albireo keys set <provider>      store the API key for ${BUILTIN_IDS} or any custom provider in providers.json
      --base-url <url>             custom endpoint ("" goes back to the default)
      --model <id>                 default model ("" goes back to the provider default)
      --keep-key                   leave the key alone; change only --base-url / --model
  albireo keys clear <provider>    remove the stored key (base URL and model stay)
  albireo keys --help

The key is never taken as an argument, which would leave it in shell history and the
process list: \`set\` asks for it without echo, or reads it from stdin when stdin is not
a terminal (albireo keys set openai < key.txt). A passphrase-protected vault needs a
terminal to enter the passphrase. A kernel that is already running picks up changes
after a restart.
`;

/** Everything the command touches outside the vault, so tests can drive it. */
export interface KeysIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stdin is a terminal (prompt for secrets) or a pipe (the key is read from it). */
  interactive: boolean;
  promptHidden(question: string): Promise<string>;
  readStdin(): Promise<string>;
}

export function processKeysIO(): KeysIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    interactive: Boolean(process.stdin.isTTY),
    promptHidden,
    readStdin,
  };
}

/** Wrong usage: exit code 2. */
class UsageError extends Error {}
/** Expected runtime failure: exit code 1. */
class Failure extends Error {}

/** Run `albireo keys …` and return the exit code. */
export async function runKeysCommand(
  argv: string[],
  io: KeysIO,
  openVault: () => Promise<VaultStore> = () => VaultStore.open(),
  openConfig: (dir: string) => Promise<ProviderConfigStore> = (dir) => ProviderConfigStore.open({ dir }),
): Promise<number> {
  let vault: VaultStore | undefined;
  try {
    const { values, positionals } = parseKeysArgs(argv);
    const [command = "status", provider, ...extra] = positionals;
    if (values.help || command === "help") {
      io.stdout(KEYS_HELP);
      return 0;
    }
    // Never echo extra arguments: the most likely one is a key pasted onto the command line.
    if (extra.length > 0) {
      throw new UsageError("too many arguments (the API key is not taken as an argument; see --help)");
    }
    const setOnly = values["base-url"] !== undefined || values.model !== undefined || values["keep-key"];
    if (command !== "set" && setOnly) throw new UsageError("--base-url, --model and --keep-key only apply to `set`");

    if (command === "status") {
      if (provider !== undefined) throw new UsageError("`status` takes no provider");
      vault = await openVault();
      const config = await openConfig(vault.dir);
      return await status(managerFor(vault, config), io);
    }
    if (command !== "set" && command !== "clear") throw new UsageError(`unknown command "${command}"`);
    if (provider === undefined) throw new UsageError(`\`${command}\` needs a provider`);
    if (command === "set" && values["keep-key"] && values["base-url"] === undefined && values.model === undefined) {
      throw new UsageError("--keep-key leaves nothing to change without --base-url or --model");
    }

    vault = await openVault();
    const config = await openConfig(vault.dir);
    if (!config.has(provider)) {
      throw new UsageError(`unknown provider "${provider}" (expected ${config.ids().join(" | ")})`);
    }
    const manager = managerFor(vault, config);
    return command === "set"
      ? await set(manager, io, provider, {
          baseURL: values["base-url"],
          model: values.model,
          keepKey: values["keep-key"] === true,
        })
      : await clear(manager, io, provider);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`albireo keys: ${err.message}\nRun "albireo keys --help" for usage.\n`);
      return 2;
    }
    if (err instanceof CancelledError) {
      io.stderr("albireo keys: cancelled\n");
      return 130;
    }
    if (err instanceof Failure || err instanceof VaultError) {
      io.stderr(`albireo keys: ${err.message}\n`);
      return 1;
    }
    throw err;
  } finally {
    vault?.lock();
  }
}

function parseKeysArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "base-url": { type: "string" },
        model: { type: "string" },
        "keep-key": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    // parseArgs names the offending option but not its value.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** A `SecretManager` without a session: same validation and status view as the panel uses. */
function managerFor(vault: VaultStore, config: ProviderConfigStore): SecretManager {
  return new SecretManager({ vault, registry: createVaultRegistry(vault, {}, config), config });
}

async function status(manager: SecretManager, io: KeysIO): Promise<number> {
  const vault = manager.vault;
  if (vault.state === "locked" && vault.protection === "passphrase" && !vault.error && io.interactive) {
    await unlock(manager, io);
  }
  io.stdout(formatStatus(manager.status(), vault.file));
  return 0;
}

async function set(
  manager: SecretManager,
  io: KeysIO,
  provider: ProviderId,
  opts: { baseURL?: string; model?: string; keepKey: boolean },
): Promise<number> {
  await prepareWrite(manager, io);
  let apiKey: string | undefined;
  if (!opts.keepKey) {
    apiKey = (await readKey(io, provider)).trim();
    if (!apiKey) throw new Failure("no API key given; nothing was changed");
  }
  const s = await manager.setProvider({ provider, apiKey, baseURL: opts.baseURL, model: opts.model });
  const view = s.providers[provider];
  if (view) io.stdout(`Saved. ${providerLine(provider, view, provider.length)}\n`);
  return 0;
}

async function clear(manager: SecretManager, io: KeysIO, provider: ProviderId): Promise<number> {
  if (manager.vault.state !== "uninitialized") await prepareWrite(manager, io);
  if (!manager.status().providers[provider]?.hasKey) {
    io.stdout(`No ${provider} key is stored.\n`);
    return 0;
  }
  await manager.setProvider({ provider, clearApiKey: true });
  io.stdout(`Removed the ${provider} key.\n`);
  return 0;
}

/**
 * Make the vault writable before asking for the key, so a wrong passphrase fails first. An empty
 * os-keychain vault is left alone: `setProvider` creates it.
 */
async function prepareWrite(manager: SecretManager, io: KeysIO): Promise<void> {
  const vault = manager.vault;
  if (vault.error) throw new Failure(vault.error);
  if (vault.state === "unlocked") return;
  if (vault.state === "uninitialized" && vault.protection === "os-keychain") return;
  if (!io.interactive) {
    throw new Failure(
      vault.state === "uninitialized"
        ? "no OS credential store is available, so the new vault needs a passphrase; run this in a terminal"
        : "the vault is protected by a passphrase; run this in a terminal to enter it",
    );
  }
  await unlock(manager, io);
}

async function unlock(manager: SecretManager, io: KeysIO): Promise<void> {
  if (manager.vault.state === "uninitialized") {
    io.stderr(
      `No OS credential store is available here, so the vault will be encrypted with a passphrase (at least ${MIN_PASSPHRASE} characters). Albireo cannot recover it if you forget it.\n`,
    );
    const passphrase = await io.promptHidden("New vault passphrase: ");
    if (passphrase !== (await io.promptHidden("Repeat the passphrase: "))) {
      throw new Failure("the passphrases do not match; nothing was changed");
    }
    await manager.unlock({ passphrase });
    return;
  }
  await manager.unlock({ passphrase: await io.promptHidden("Vault passphrase: ") });
}

async function readKey(io: KeysIO, provider: ProviderId): Promise<string> {
  if (io.interactive) return io.promptHidden(`API key for ${provider}: `);
  io.stderr(`Reading the ${provider} API key from stdin…\n`);
  try {
    return await io.readStdin();
  } catch (err) {
    throw new Failure(`could not read the API key from stdin: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatStatus(s: SecretsStatus, file: string): string {
  const lines = [`Vault: ${describeVault(s)}`, `File:  ${file}`];
  if (s.configError) lines.push(`Providers: ${s.configError}`);
  if (s.state === "unlocked") {
    const width = Math.max(...s.providerOrder.map((id) => id.length), 1);
    for (const id of s.providerOrder) {
      const view = s.providers[id];
      if (view) lines.push(`  ${providerLine(id, view, width)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function describeVault(s: SecretsStatus): string {
  if (s.error) return `cannot be opened. ${s.error}`;
  const holder =
    s.protection === "os-keychain"
      ? `master key held by ${s.keychain ?? "the OS credential store"}`
      : "encrypted with a passphrase";
  if (s.state === "uninitialized") return `not created yet; \`albireo keys set <provider>\` creates it (${holder})`;
  if (s.state === "locked") return `locked, ${holder}`;
  return `unlocked, ${holder}`;
}

function providerLine(id: ProviderId, p: ProviderSecretView, width: number): string {
  const keyState = p.hasKey ? `key ${p.keyHint}` : p.auth === "none" ? "no key needed" : "no key";
  const parts = [keyState];
  if (p.baseURL) parts.push(`base URL ${p.baseURL}`);
  if (p.model) parts.push(`model ${p.model}`);
  return `${id.padEnd(width)}  ${parts.join(" · ")}`;
}
