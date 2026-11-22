import { createSignal } from "solid-js";

export const [keysOpen, setKeysOpen] = createSignal(false);

/** Whether the conversation follows new output. The composer sets it when the user sends. */
export const [stickToBottom, setStickToBottom] = createSignal(true);

let composer: HTMLTextAreaElement | undefined;
export function registerComposer(el: HTMLTextAreaElement | undefined): void {
  composer = el;
}
/** True while the user has typed something into the message box, so nothing should steal focus. */
export function composerBusy(): boolean {
  return composer !== undefined && document.activeElement === composer && composer.value.trim() !== "";
}
