import { token } from "../api.ts";
import type { ServerEvent } from "../protocol.ts";
import { loadSecrets } from "./secrets.ts";
import { dispatch, setChat } from "./store.ts";
import { noteEvent } from "./workspace.ts";

/**
 * Opens the event stream. The first message is a snapshot; after that every kernel event arrives in
 * order. EventSource reconnects by itself, and each reconnect begins with a fresh snapshot.
 */
export function connect(): () => void {
  const es = new EventSource(`/events?token=${encodeURIComponent(token)}`);
  es.onopen = () => setChat("connected", true);
  es.onerror = () => setChat("connected", false);
  es.onmessage = (e) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(e.data) as ServerEvent;
    } catch {
      return;
    }
    // Vault and provider changes are not kernel events: re-fetch instead of reducing.
    if (ev.type === "secrets_changed") {
      void loadSecrets();
      return;
    }
    dispatch(ev);
    noteEvent(ev);
    if (ev.type === "snapshot") void loadSecrets();
  };
  return () => es.close();
}
