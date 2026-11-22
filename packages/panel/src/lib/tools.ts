import { truncate } from "./format.ts";

/** One-line description of a tool call's input: its path or command if it has one, else its JSON. */
export function toolSummary(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return truncate(o.command.split("\n")[0] ?? "", 140);
    if (typeof o.path === "string") return o.path;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    // fall through to String()
  }
  return truncate(json ?? String(input), 120);
}

/** The text of a tool call's main string argument, shown in full on the approval card. */
export function approvalBody(name: string, input: unknown): { label: string; text: string } | null {
  if (typeof input !== "object" || input === null) return null;
  const o = input as Record<string, unknown>;
  if (name === "run_command" && typeof o.command === "string") return { label: "Command", text: o.command };
  if (name === "write_file" && typeof o.path === "string" && typeof o.contents === "string") {
    const max = 4000;
    const more = o.contents.length > max ? `\n…[${o.contents.length - max} more characters]` : "";
    return { label: o.path, text: o.contents.slice(0, max) + more };
  }
  return null;
}
