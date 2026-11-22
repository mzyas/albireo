import { createStore, produce, reconcile } from "solid-js/store";
import type { ServerEvent } from "../protocol.ts";
import { applyEvent, createChatState } from "./chat.ts";

export const [chat, setChat] = createStore(createChatState());

/** Back to a page that has heard nothing yet: another session is about to be shown. */
export function resetChat(): void {
  setChat(reconcile(createChatState()));
}

export function dispatch(ev: ServerEvent): void {
  setChat(produce((s) => applyEvent(s, ev)));
}

/** A line of the panel's own, e.g. the answer to a slash command. It is not in the kernel's log. */
export function pushLocalNotice(text: string): void {
  setChat(
    produce((s) => {
      s.items.push({ kind: "notice", text });
    }),
  );
}

/** An error that did not come from the kernel, e.g. a rejected command. */
export function pushLocalError(text: string): void {
  setChat(
    produce((s) => {
      s.items.push({ kind: "error", text });
    }),
  );
}
