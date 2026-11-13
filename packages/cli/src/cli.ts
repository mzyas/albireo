#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { builtinTools, defaultRegistry, type Risk, Session } from "@albireo/core";
import { startPanelServer } from "@albireo/server";

const HELP = `albireo — provider-neutral coding agent

Usage: albireo [options]
  Without --prompt, starts the kernel and prints the URL of the GUI panel.

  -p, --provider <id>   anthropic | openai            (default: anthropic)
  -m, --model <id>      model id                      (default: provider default)
      --cwd <dir>       workspace root                (default: current dir)
      --port <n>        panel port                    (default: random free port)
      --no-panel        with --prompt: do not start the panel server
      --yolo            auto-approve write + exec tools (use with care)
      --prompt <text>   run one prompt headlessly, print the result, exit
  -h, --help
`;

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

let session: Session;
try {
  session = new Session({
    providers: defaultRegistry(),
    provider: values.provider,
    model: values.model,
    tools: builtinTools,
    cwd: path.resolve(values.cwd ?? process.cwd()),
    autoApprove,
  });
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

const panel = values["no-panel"]
  ? undefined
  : await startPanelServer(session, { port: values.port ? Number(values.port) : 0 });

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
process.stdout.write(
  `Albireo kernel running (${session.providerId} · ${session.model})\nGUI panel: ${panel.url}\nPress Ctrl+C to stop.\n`,
);
await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await panel.close();
process.exit(0);
