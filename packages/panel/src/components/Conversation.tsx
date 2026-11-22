import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { Item } from "../state/chat.ts";
import { chat } from "../state/store.ts";
import { setStickToBottom, stickToBottom } from "../state/ui.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolRun } from "./ToolRun.tsx";
import { Welcome } from "./Welcome.tsx";

type Of<K extends Item["kind"]> = Extract<Item, { kind: K }>;

function UserMessage(props: { item: Of<"user"> }) {
  return <div class="msg user">{props.item.text}</div>;
}

function AssistantMessage(props: { item: Of<"assistant"> }) {
  return (
    <div class="msg assistant">
      <Show when={props.item.reasoning}>
        <details class="reasoning" open={props.item.live}>
          <summary>{props.item.live && !props.item.text ? "Thinking…" : "Thought process"}</summary>
          <div>{props.item.reasoning}</div>
        </details>
      </Show>
      <Show when={props.item.text}>
        <Markdown text={props.item.text} />
      </Show>
      <Show when={props.item.live && !props.item.text && !props.item.reasoning}>
        <span class="typing" role="status" aria-label="Waiting for the model">
          <i />
          <i />
          <i />
        </span>
      </Show>
    </div>
  );
}

function ItemView(props: { item: Item }) {
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>{(i) => <UserMessage item={i() as Of<"user">} />}</Match>
      <Match when={props.item.kind === "assistant" && props.item}>
        {(i) => <AssistantMessage item={i() as Of<"assistant">} />}
      </Match>
      <Match when={props.item.kind === "tools" && props.item}>
        {(i) => <ToolRun calls={(i() as Of<"tools">).calls} />}
      </Match>
      <Match when={props.item.kind === "notice" && props.item}>
        {(i) => <div class="notice">{(i() as Of<"notice">).text}</div>}
      </Match>
      <Match when={props.item.kind === "error" && props.item}>
        {(i) => (
          <div class="msg error" role="alert">
            {(i() as Of<"error">).text}
          </div>
        )}
      </Match>
    </Switch>
  );
}

export function Conversation() {
  let scroller!: HTMLElement;
  let content!: HTMLDivElement;
  const [overflowing, setOverflowing] = createSignal(false);

  const distanceFromBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  const toBottom = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  onMount(() => {
    // Follow output while the reader is at the bottom; leave them alone once they scroll up.
    const observer = new ResizeObserver(() => {
      if (stickToBottom()) toBottom();
      setOverflowing(scroller.scrollHeight > scroller.clientHeight);
    });
    observer.observe(content);
    observer.observe(scroller);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="conversation">
      <main
        class="scroller"
        ref={scroller}
        onScroll={() => setStickToBottom(distanceFromBottom() < 80)}
        aria-label="Conversation"
        aria-live="polite"
      >
        <div class="thread" ref={content}>
          <Show when={chat.items.length > 0} fallback={<Welcome />}>
            <For each={chat.items}>{(item) => <ItemView item={item} />}</For>
          </Show>
        </div>
      </main>
      <Show when={overflowing() && !stickToBottom()}>
        <button
          type="button"
          class="jump"
          onClick={() => {
            setStickToBottom(true);
            toBottom();
          }}
        >
          Jump to latest
        </button>
      </Show>
    </div>
  );
}
