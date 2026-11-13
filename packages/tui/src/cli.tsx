#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { render } from "ink";
import { Session, builtinTools, defaultRegistry, type Risk } from "@albireo/core";
import { startPanelServer } from "@albireo/server";
import { App } from "./App.js";

const HELP = `albireo — provider-neutral coding agent (TUI kernel + GUI panel)

Usage: albireo [options]
  -p, --provider <id>   anthropic | openai            (default: anthropic)
  -m, --model <id>      model id                      (default: provider default)
      --cwd <dir>       workspace root                (default: current dir)
      --port <n>        panel port                    (default: random free port)
      --no-panel        do not start the GUI panel server
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

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
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
  process.stderr.write(`albireo: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const panel = values["no-panel"]
  ? undefined
  : await startPanelServer(session, { port: values.port ? Number(values.port) : 0 });

if (values.prompt) {
  // Headless mode: stream to stdout, deny anything that needs approval.
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

const app = render(<App session={session} panelUrl={panel?.url} />);
if (panel) session.notice(`GUI panel: ${panel.url}`);
await app.waitUntilExit();
await panel?.close();
process.exit(0);
