import { COMMANDS, type ParsedCommand, resolveModelArgs } from "../lib/commands.ts";
import { retryTurn, switchModel } from "./actions.ts";
import { chat, pushLocalError, pushLocalNotice } from "./store.ts";
import { openPane, setKeysOpen, setSwitcherOpen } from "./ui.ts";

function helpText(): string {
  return [
    "Commands:",
    ...COMMANDS.map((c) => `${c.usage ?? `/${c.name}`} — ${c.summary}`),
    "@ in a message mentions a file.",
  ].join("\n");
}

/** Runs a slash command. Commands never reach the model; their answers are lines of the panel's own. */
export function runSlashCommand(cmd: ParsedCommand): void {
  switch (cmd.name) {
    case "model": {
      const request = resolveModelArgs(cmd.args, chat.providers, chat.provider);
      if ("error" in request) pushLocalError(request.error);
      else if (request.open) setSwitcherOpen(true);
      else switchModel(request.provider, request.model);
      return;
    }
    case "retry":
      if (chat.canRetry) void retryTurn();
      else pushLocalNotice("There is nothing to retry: the last turn finished.");
      return;
    case "changes":
    case "files":
    case "context":
      openPane(cmd.name);
      return;
    case "keys":
      setKeysOpen(true);
      return;
    case "help":
      pushLocalNotice(helpText());
      return;
  }
}
