import { token } from "../api.ts";
import type { ServerEvent } from "../protocol.ts";
import { loadSecrets } from "./secrets.ts";
import { loadSessions } from "./sessions.ts";
import { dispatch, resetChat, setChat } from "./store.ts";
import { noteEvent, resetWorkspace } from "./workspace.ts";

/**
 * Opens the event stream of one session, after forgetting what the last one showed. The first message
 * is a snapshot; after that every kernel event arrives in order. EventSource reconnects by itself, and
 * each reconnect begins with a fresh snapshot. Returns what closes the stream.
 */
export function connect(session: string): () => void {
  resetChat();
  resetWorkspace();
  const es = new EventSource(`/events?session=${encodeURIComponent(session)}&token=${encodeURIComponent(token)}`);
  es.onopen = () => setChat("connected", true);
  es.onerror = () => {
    setChat("connected", false);
    // The server refused to reconnect (a 404: the session is gone). Find out what there is to show now.
    if (es.readyState === EventSource.CLOSED) void loadSessions();
  };
  es.onmessage = (e) => {
    let ev: ServerEvent;
    try {
      ev = JSON.parse(e.data) as ServerEvent;
    } catch {
      return;
    }
    // Vault, provider and session-list changes are not kernel events: re-fetch instead of reducing.
    if (ev.type === "secrets_changed") {
      void loadSecrets();
      return;
    }
    if (ev.type === "sessions_changed") {
      void loadSessions();
      return;
    }
    dispatch(ev);
    noteEvent(ev);
    if (ev.type === "snapshot") void loadSecrets();
  };
  return () => es.close();
}
