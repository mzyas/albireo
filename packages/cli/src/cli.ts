#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { builtinTools, type Risk } from "@albireo/core";
import { ManagerError, resumeChoice, SessionManager, startPanelServer } from "@albireo/server";
import { type LoadedSession, SessionStore, StoreError, sameDir } from "@albireo/store";
import {
  createVaultRegistry,
  ProviderConfigStore,
  providerProblem,
  registerVaultProviders,
  SecretManager,
  VaultError,
  VaultStore,
} from "@albireo/vault";
import { processKeysIO, runKeysCommand } from "./keys.js";
import { chooseSession, defaultSessionsDir, runSessionsCommand } from "./sessions.js";
import { CancelledError, promptHidden } from "./tty.js";

const DEFAULT_PROVIDER = "anthropic";

const HELP = `albireo — provider-neutral coding agent

Usage: albireo [options]
       albireo keys [status | set <provider> | clear <provider>]   (see albireo keys --help)
       albireo sessions [list | delete <id>]                      (see albireo sessions --help)
  Without --prompt, starts the kernel and prints the URL of the GUI panel.
  API keys live in an encrypted vault in your user config dir; custom provider endpoints
  live in providers.json beside it. Manage both under "API Keys" in the panel or with
  \`albireo keys\`. Environment variables are not read for credentials.
  Conversations are saved there too (never inside a workspace).

  -p, --provider <id>   anthropic | openai | <custom> (default: anthropic, or the resumed session's)
  -m, --model <id>      model id                      (default: provider default, or the resumed session's)
      --cwd <dir>       workspace root                (default: current dir)
      --port <n>        panel port                    (default: random free port)
      --no-panel        with --prompt: do not start the panel server
      --yolo            auto-approve write + exec tools (use with care)
      --prompt <text>   run one prompt headlessly, print the result, exit
  -c, --continue        continue the latest saved session of this workspace
      --resume <id>     continue a saved session (ids: albireo sessions)
      --no-save         do not save this conversation (it can still continue a saved one without changing it)
  -h, --help
`;

if (process.argv[2] === "keys") {
  process.exit(await runKeysCommand(process.argv.slice(3), processKeysIO()));
}

if (process.argv[2] === "sessions") {
  const io = { stdout: (t: string) => process.stdout.write(t), stderr: (t: string) => process.stderr.write(t) };
  process.exit(
    await runSessionsCommand(process.argv.slice(3), io, new SessionStore(defaultSessionsDir()), process.cwd()),
  );
}

const { values } = parseArgs({
  options: {
    provider: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    cwd: { type: "string" },
    port: { type: "string" },
    "no-panel": { type: "boolean", default: false },
    yolo: { type: "boolean", default: false },
    prompt: { type: "string" },
    continue: { type: "boolean", short: "c", default: false },
    resume: { type: "string" },
    "no-save": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

function fail(message: string, code = 1): never {
  process.stderr.write(`albireo: ${message}\n`);
  process.exit(code);
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values["no-panel"] && values.prompt === undefined) {
  fail("--no-panel only makes sense together with --prompt (otherwise there is nothing to serve)", 2);
}
if (values.continue && values.resume !== undefined) {
  fail("--continue and --resume cannot be used together", 2);
}

function note(message: string): void {
  process.stderr.write(`albireo: ${message}\n`);
}

const autoApprove: Risk[] = values.yolo ? ["read", "write", "exec"] : ["read"];
const cwd = path.resolve(values.cwd ?? process.cwd());

// Credentials come only from the vault; endpoint definitions come from providers.json.
// Missing keys become placeholder providers, so the panel can still start and be used to add them.
const [vault, config] = await Promise.all([VaultStore.open(), ProviderConfigStore.open()]);
const registry = createVaultRegistry(vault, {}, config);
process.once("exit", () => vault.lock());

// Saved conversations live beside the vault. `--continue` / `--resume` pick one to carry on.
const store = new SessionStore(defaultSessionsDir());
let resumed: LoadedSession | undefined;
try {
  const choice = await chooseSession(store, { continueLast: values.continue, id: values.resume, cwd });
  resumed = choice.loaded;
  if (choice.note) note(choice.note);
} catch (err) {
  // StoreError messages are written for users; anything else may carry paths.
  fail(err instanceof StoreError ? err.message : "could not read the saved sessions");
}
if (resumed) {
  if (resumed.skipped > 0) note(`${resumed.skipped} unreadable line(s) in the saved session were skipped`);
  if (!sameDir(resumed.meta.cwd, cwd)) {
    note(`that session ran in ${resumed.meta.cwd}; tools now work in ${cwd} (change it with --cwd)`);
  }
}

// An explicit --provider and --model win; otherwise a resumed session goes back to the provider it used,
// and to its model only if it had chosen one of its own (see resumeChoice).
let providerId = values.provider ?? DEFAULT_PROVIDER;
let modelId = values.model;
if (resumed) {
  const choice = resumeChoice(resumed.meta, registry, DEFAULT_PROVIDER, {
    provider: values.provider,
    model: values.model,
  });
  providerId = choice.provider;
  modelId = choice.model;
  if (choice.note) note(choice.note);
}

const def = config.get(providerId);
if (!def) {
  const extra = config.error ? ` (${config.error})` : "";
  fail(`unknown provider "${providerId}". Available: ${config.ids().join(", ")}${extra}`);
}

if (values.prompt !== undefined) {
  if (def.auth !== "none" && vault.state === "locked" && vault.protection === "passphrase") {
    if (!process.stdin.isTTY) {
      fail("the vault is locked and stdin is not a terminal; run albireo without --prompt and unlock it in the panel");
    }
    try {
      await vault.unlock(await promptHidden("Vault passphrase: "));
    } catch (err) {
      if (err instanceof CancelledError) fail("cancelled", 130);
      fail(err instanceof VaultError ? err.message : "could not unlock the vault");
    }
    registerVaultProviders(registry, vault, {}, config);
  }
  // The same check the registry makes, so a provider that passes it doesn't fail its first turn.
  const problem = providerProblem(vault, def);
  if (problem) fail(problem.message);
}

// The sessions of this run live in a manager: the first one is started or brought back here, and
// the panel can start and open more. Every message is saved as it happens (unless --no-save); a failed
// write is reported once and never interrupts the conversation.
let reportedSaveError = false;
const manager = new SessionManager({
  registry,
  tools: builtinTools,
  autoApprove,
  store,
  save: !values["no-save"],
  provider: providerId,
  cwd,
  onSaveError: (err) => {
    if (reportedSaveError) return;
    reportedSaveError = true;
    note(`could not save the conversation (${err.message}); it continues unsaved`);
  },
});
let managed: Awaited<ReturnType<SessionManager["create"]>>;
try {
  managed = resumed
    ? await manager.open(resumed.meta.id, { cwd, provider: providerId, model: modelId })
    : await manager.create({ cwd, provider: providerId, model: modelId });
} catch (err) {
  fail(err instanceof ManagerError ? err.message : err instanceof Error ? err.message : String(err));
}
const session = managed.session;

// Every session follows the vault: a key saved in the panel reaches all of them.
const secrets = new SecretManager({ vault, registry, config });
manager.each((s) => secrets.track(s));
const panel = values["no-panel"]
  ? undefined
  : await startPanelServer(manager, { port: values.port ? Number(values.port) : 0, secrets });

if (values.prompt !== undefined) {
  // Headless: stream to stdout, deny anything that needs approval.
  session.on((e) => {
    if (e.type === "text_delta") process.stdout.write(e.text);
    else if (e.type === "tool_call") process.stderr.write(`\n[tool] ${e.name} ${JSON.stringify(e.input)}\n`);
    else if (e.type === "approval_request") session.approve(e.id, false);
    else if (e.type === "error") process.stderr.write(`\n[error] ${e.message}\n`);
  });
  await session.send(values.prompt);
  process.stdout.write("\n");
  await manager.flush();
  await panel?.close();
  process.exit(0);
}

// Serve mode: the kernel keeps running; the GUI panel is the interface. What sessions do is told on
// stderr, each line with the folder it happened in once there is more than one.
if (!panel) fail("internal error: panel server was not started");
manager.each((s) => {
  const where = () => (manager.sessions().length > 1 ? ` [${path.basename(s.cwd)}]` : "");
  return s.on((e) => {
    if (e.type === "tool_call") process.stderr.write(`[tool]${where()} ${e.name}\n`);
    else if (e.type === "approval_request")
      process.stderr.write(`[approval needed]${where()} ${e.name} (${e.risk}) — answer it in the panel\n`);
    else if (e.type === "error") process.stderr.write(`[error]${where()} ${e.message}\n`);
  });
});
const vaultLine = (() => {
  if (vault.error) return `Vault: ${vault.error}`;
  const activeDef = config.get(session.providerId);
  if (activeDef?.auth === "none" && vault.state !== "unlocked") {
    return `Vault: ${vault.state} (${session.providerId} requires no API key)`;
  }
  if (vault.state === "uninitialized") return `Vault: empty — add API keys under "API Keys" in the panel`;
  if (vault.state === "locked") return `Vault: locked — unlock it under "API Keys" in the panel`;
  const problem = activeDef && providerProblem(vault, activeDef);
  if (problem?.cause === "base-url") return `Vault: ${problem.message}`;
  if (problem) return `Vault: no ${session.providerId} key — add it in the panel`;
  return `Vault: unlocked (${vault.protection})`;
})();
const configLine = config.error ? `Providers: ${config.error}\n` : "";
const sessionLine = (() => {
  if (values["no-save"]) return "Session: not saved (--no-save)";
  if (resumed) return `Session: ${managed.id} (continued, ${resumed.meta.messageCount} messages so far)`;
  return `Session: ${managed.id} (saved from your first message)`;
})();
process.stdout.write(
  `Albireo kernel running (${session.providerId} · ${session.model})\n${vaultLine}\n${configLine}${sessionLine}\nGUI panel: ${panel.url}\nPress Ctrl+C to stop.\n`,
);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await manager.flush();
await panel.close();
process.exit(0);
