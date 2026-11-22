import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { formatTokens } from "../lib/format.ts";
import { abortTurn, sendMessage } from "../state/actions.ts";
import { chat } from "../state/store.ts";
import { registerComposer, setStickToBottom } from "../state/ui.ts";

const MAX_HEIGHT = 220;

export function Composer() {
  let input!: HTMLTextAreaElement;
  const [text, setText] = createSignal("");
  /** Messages typed while a turn runs; each goes out when the turn before it ends. */
  const [queue, setQueue] = createSignal<string[]>([]);

  onMount(() => {
    registerComposer(input);
    input.focus();
    onCleanup(() => registerComposer(undefined));
  });

  function resize() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT)}px`;
  }

  function submit() {
    const value = text().trim();
    if (!value) return;
    setText("");
    input.value = "";
    resize();
    setStickToBottom(true);
    if (chat.status === "running" || queue().length > 0) setQueue((q) => [...q, value]);
    else void sendMessage(value);
  }

  createEffect(
    on(
      () => chat.status,
      (status) => {
        const [next, ...rest] = queue();
        if (status !== "idle" || next === undefined) return;
        setQueue(rest);
        void sendMessage(next);
      },
    ),
  );

  const stopping = () => chat.status === "running" && text().trim() === "";
  const usage = () => chat.usage;

  return (
    <div class="composer-wrap">
      <Show when={queue().length > 0}>
        <ul class="queue" aria-label="Queued messages">
          <For each={queue()}>
            {(q, i) => (
              <li>
                <span class="queued-text">{q}</span>
                <span class="queued-tag">queued</span>
                <button
                  type="button"
                  class="ghost"
                  aria-label="Remove queued message"
                  onClick={() => setQueue((all) => all.filter((_, j) => j !== i()))}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (stopping()) abortTurn();
          else submit();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          placeholder={chat.status === "running" ? "Albireo is working — type to queue a message" : "Message Albireo…"}
          aria-label="Message"
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            resize();
          }}
          onKeyDown={(e) => {
            // keyCode 229 is a key press that belongs to an IME (Safari reports it after composition ends).
            if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            if (!stopping()) submit();
          }}
        />
        <button
          type="submit"
          class={stopping() ? "stop" : "primary"}
          disabled={!stopping() && (text().trim() === "" || !chat.connected)}
        >
          {stopping() ? "Stop" : chat.status === "running" ? "Queue" : "Send"}
        </button>
      </form>
      <p class="footnote">
        <span>Enter to send · Shift+Enter for a new line</span>
        <Show when={usage().input + usage().output > 0}>
          <span title="Tokens used in this conversation">
            ↑ {formatTokens(usage().input)} ↓ {formatTokens(usage().output)}
            <Show when={usage().cacheRead > 0}> · cached {formatTokens(usage().cacheRead)}</Show>
          </span>
        </Show>
      </p>
    </div>
  );
}
