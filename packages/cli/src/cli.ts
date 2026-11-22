#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { builtinTools, loadInstructions, type Risk, Session } from "@albireo/core";
import { startPanelServer } from "@albireo/server";
import { type LoadedSession, type Recording, SessionStore, StoreError, sameDir } from "@albireo/store";
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

// An explicit --provider wins; otherwise a resumed session goes back to the provider it used.
let providerId = values.provider ?? DEFAULT_PROVIDER;
if (values.provider === undefined && resumed?.meta.provider) {
  if (config.get(resumed.meta.provider)) providerId = resumed.meta.provider;
  else note(`the saved session used provider "${resumed.meta.provider}", which is not available; using ${providerId}`);
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

let session: Session;
try {
  // A model the session had chosen explicitly comes back; its provider's default is not pinned, so a
  // later change to the model override still applies.
  const resumedModel =
    resumed && providerId === resumed.meta.provider && resumed.meta.model !== registry.get(providerId).defaultModel
      ? resumed.meta.model
      : undefined;
  session = new Session({
    providers: registry,
    provider: providerId,
    model: values.model ?? resumedModel,
    tools: builtinTools,
    cwd,
    instructions: await loadInstructions(cwd),
    autoApprove,
    history: resumed?.messages,
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// Every message is appended to the session's file as it happens. A failed write is reported once and
// never interrupts the conversation.
let recording: Recording | undefined;
if (!values["no-save"]) {
  let reported = false;
  const onError = (err: Error) => {
    if (reported) return;
    reported = true;
    note(`could not save the conversation (${err.message}); it continues unsaved`);
  };
  recording = resumed ? store.resume(session, resumed.meta, { onError }) : store.record(session, { cwd, onError });
}

const secrets = new SecretManager({ vault, registry, config, session });
const panel = values["no-panel"]
  ? undefined
  : await startPanelServer(session, { port: values.port ? Number(values.port) : 0, secrets });

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
  await recording?.flush();
  await panel?.close();
  process.exit(0);
}

// Serve mode: the kernel keeps running; the GUI panel is the interface.
if (!panel) fail("internal error: panel server was not started");
session.on((e) => {
  if (e.type === "tool_call") process.stderr.write(`[tool] ${e.name}\n`);
  else if (e.type === "approval_request")
    process.stderr.write(`[approval needed] ${e.name} (${e.risk}) — answer it in the panel\n`);
  else if (e.type === "error") process.stderr.write(`[error] ${e.message}\n`);
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
  if (!recording) return "Session: not saved (--no-save)";
  if (resumed) return `Session: ${recording.id} (continued, ${resumed.meta.messageCount} messages so far)`;
  return `Session: ${recording.id} (saved from your first message)`;
})();
process.stdout.write(
  `Albireo kernel running (${session.providerId} · ${session.model})\n${vaultLine}\n${configLine}${sessionLine}\nGUI panel: ${panel.url}\nPress Ctrl+C to stop.\n`,
);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await recording?.flush();
await panel.close();
process.exit(0);
