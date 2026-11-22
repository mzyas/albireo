import { createSignal } from "solid-js";
import { api } from "../api.ts";
import type { SecretsResponse, SecretsStatus } from "../protocol.ts";

/** Latest `GET /secrets` answer; null until it has been fetched (or when the request failed). */
export const [secrets, setSecrets] = createSignal<SecretsResponse | null>(null);

/** The vault status, or null when the server has no vault. */
export function vault(): SecretsStatus | null {
  const s = secrets();
  return s?.enabled ? s : null;
}

export async function loadSecrets(): Promise<void> {
  try {
    setSecrets(await api<SecretsResponse>("/secrets"));
  } catch {
    setSecrets(null);
  }
}

// ---- state shared by the keys dialog and its forms ----

export const [keysMessage, setKeysMessage] = createSignal({ text: "", error: false });
export function keysMsg(text: string, error = false): void {
  setKeysMessage({ text, error });
}

/** Bumped when the dialog closes; secret inputs clear themselves on it. */
export const [clearTick, setClearTick] = createSignal(0);
