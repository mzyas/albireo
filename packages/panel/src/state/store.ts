import { createStore, produce } from "solid-js/store";
import type { ServerEvent } from "../protocol.ts";
import { applyEvent, createChatState } from "./chat.ts";

export const [chat, setChat] = createStore(createChatState());

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
