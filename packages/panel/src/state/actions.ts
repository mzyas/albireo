import { postCommand } from "../api.ts";
import { pushLocalError, setChat } from "./store.ts";

async function run(cmd: Parameters<typeof postCommand>[0]): Promise<boolean> {
  const error = await postCommand(cmd);
  if (error) pushLocalError(error);
  return error === null;
}

export async function sendMessage(text: string): Promise<void> {
  // The server's `status` event confirms it; setting it now keeps a second message from racing the first.
  setChat("status", "running");
  if (!(await run({ type: "send", text }))) setChat("status", "idle");
}

/** Runs the last turn again. The server's `status` events say when it starts and ends. */
export async function retryTurn(): Promise<void> {
  setChat("status", "running");
  setChat("canRetry", false);
  if (!(await run({ type: "retry" }))) setChat("status", "idle");
}

export function answerApproval(id: string, allow: boolean): void {
  void run({ type: "approve", id, allow });
}

export function abortTurn(): void {
  void run({ type: "abort" });
}

export function switchModel(provider: string, model: string): void {
  void run({ type: "switch", provider, ...(model ? { model } : {}) });
}
