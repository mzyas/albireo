#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { builtinTools, type Risk, Session } from "@albireo/core";
import { startPanelServer } from "@albireo/server";
import {
  createVaultRegistry,
  isProviderReady,
  ProviderConfigStore,
  registerVaultProviders,
  SecretManager,
  VaultError,
  VaultStore,
} from "@albireo/vault";
import { processKeysIO, runKeysCommand } from "./keys.js";
import { CancelledError, promptHidden } from "./tty.js";

const HELP = `albireo — provider-neutral coding agent

Usage: albireo [options]
       albireo keys [status | set <provider> | clear <provider>]   (see albireo keys --help)
  Without --prompt, starts the kernel and prints the URL of the GUI panel.
  API keys live in an encrypted vault in your user config dir; custom provider endpoints
  live in providers.json beside it. Manage both under "API Keys" in the panel or with
  \`albireo keys\`. Environment variables are not read for credentials.

  -p, --provider <id>   anthropic | openai | <custom> (default: anthropic)
  -m, --model <id>      model id                      (default: provider default)
      --cwd <dir>       workspace root                (default: current dir)
      --port <n>        panel port                    (default: random free port)
      --no-panel        with --prompt: do not start the panel server
      --yolo            auto-approve write + exec tools (use with care)
      --prompt <text>   run one prompt headlessly, print the result, exit
  -h, --help
`;

if (process.argv[2] === "keys") {
  process.exit(await runKeysCommand(process.argv.slice(3), processKeysIO()));
}

const { values } = parseArgs({
  options: {
    provider: { type: "string", short: "p", default: "anthropic" },
    model: { type: "string", short: "m" },
    cwd: { type: "string" },
    port: { type: "string" },
    "no-panel": { type: "boolean", default: false },
    yolo: { type: "boolean", default: false },
    prompt: { type: "string" },
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

const autoApprove: Risk[] = values.yolo ? ["read", "write", "exec"] : ["read"];

// Credentials come only from the vault; endpoint definitions come from providers.json.
// Missing keys become placeholder providers, so the panel can still start and be used to add them.
const [vault, config] = await Promise.all([VaultStore.open(), ProviderConfigStore.open()]);
const registry = createVaultRegistry(vault, {}, config);
process.once("exit", () => vault.lock());

if (values.prompt !== undefined) {
  const def = config.get(values.provider);
  if (!def) {
    const extra = config.error ? ` (${config.error})` : "";
    fail(`unknown provider "${values.provider}". Available: ${config.ids().join(", ")}${extra}`);
  }
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
  if (!isProviderReady(vault, values.provider, config)) {
    if (vault.error) fail(vault.error);
    fail(
      `no API key for "${values.provider}" in the vault. Add it with \`albireo keys set ${values.provider}\`, or under "API Keys" in the panel.`,
    );
  }
}

let session: Session;
try {
  session = new Session({
    providers: registry,
    provider: values.provider,
    model: values.model,
    tools: builtinTools,
    cwd: path.resolve(values.cwd ?? process.cwd()),
    autoApprove,
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
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
  if (!isProviderReady(vault, session.providerId, config)) {
    return `Vault: no ${session.providerId} key — add it in the panel`;
  }
  return `Vault: unlocked (${vault.protection})`;
})();
const configLine = config.error ? `Providers: ${config.error}\n` : "";
process.stdout.write(
  `Albireo kernel running (${session.providerId} · ${session.model})\n${vaultLine}\n${configLine}GUI panel: ${panel.url}\nPress Ctrl+C to stop.\n`,
);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await panel.close();
process.exit(0);
