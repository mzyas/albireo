// Slash commands typed into the message box. They run in the panel, never reach the model, and a
// message that merely starts with `/` (a path, say) is still an ordinary message.

export interface CommandSpec {
  name: string;
  /** Shown beside the name in the menu. */
  summary: string;
  usage?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: "model", usage: "/model [provider] [model]", summary: "Switch provider or model" },
  { name: "retry", summary: "Run the last turn again" },
  { name: "changes", summary: "Show the files that changed" },
  { name: "files", summary: "Browse the workspace's files" },
  { name: "context", summary: "Show token use and the loaded instructions" },
  { name: "keys", summary: "Manage API keys" },
  { name: "help", summary: "List the commands" },
];

export interface ParsedCommand {
  name: string;
  args: string[];
}

/** The command a message is, or null when it is an ordinary message (including an unknown `/word`). */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const name = m?.[1]?.toLowerCase();
  if (!m || !name || !COMMANDS.some((c) => c.name === name)) return null;
  return { name, args: (m[2] ?? "").split(/\s+/).filter(Boolean) };
}

/** Commands for the menu: those that start with what was typed first, then those that contain it. */
export function matchCommands(query: string): CommandSpec[] {
  const q = query.toLowerCase();
  const starts = COMMANDS.filter((c) => c.name.startsWith(q));
  return [...starts, ...COMMANDS.filter((c) => !c.name.startsWith(q) && c.name.includes(q))];
}

export type ModelRequest = { open: true } | { open: false; provider: string; model: string } | { error: string };

/** `/model` alone opens the switcher; `/model x` is a provider if it is one, else a model of the current one. */
export function resolveModelArgs(args: string[], providers: readonly string[], current: string): ModelRequest {
  const [first, second, ...rest] = args;
  if (first === undefined) return { open: true };
  if (rest.length > 0) return { error: "Usage: /model [provider] [model]" };
  if (second !== undefined) {
    if (!providers.includes(first)) return { error: `Unknown provider "${first}". Available: ${providers.join(", ")}` };
    return { open: false, provider: first, model: second };
  }
  if (providers.includes(first)) return { open: false, provider: first, model: "" };
  return { open: false, provider: current, model: first };
}
