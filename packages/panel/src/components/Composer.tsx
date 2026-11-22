import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { matchCommands, parseCommand } from "../lib/commands.ts";
import { activeTrigger, applyCompletion, formatMention, type Trigger } from "../lib/composer.ts";
import { formatTokens } from "../lib/format.ts";
import { splitPath } from "../lib/workspace.ts";
import { abortTurn, sendMessage } from "../state/actions.ts";
import { runSlashCommand } from "../state/commands.ts";
import { recall, remember } from "../state/composerMemory.ts";
import { activeId } from "../state/sessions.ts";
import { chat } from "../state/store.ts";
import { composerRequest, registerComposer, setStickToBottom } from "../state/ui.ts";
import { fetchFiles } from "../state/workspace.ts";

const MAX_HEIGHT = 220;
/** Narrower than this (its own padding is 16) the box has not been laid out. */
const MIN_MEASURABLE_WIDTH = 40;
const MENU_ITEMS = 8;

interface MenuItem {
  /** What replaces the typed token. */
  value: string;
  /** Name (or file name) and the dimmer rest. */
  main: string;
  detail: string;
}

export function Composer() {
  let input!: HTMLTextAreaElement;
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  /** Messages typed while a turn runs; each goes out when the turn before it ends. */
  const [queue, setQueue] = createSignal<string[]>([]);

  // ---- the `@file` and `/command` menu ----
  const [files, setFiles] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal(0);
  /** Esc closes the menu for the token it was open on; typing something else opens it again. */
  const [dismissed, setDismissed] = createSignal("");

  const trigger = createMemo<Trigger | null>(() => activeTrigger(text(), caret()));
  const triggerKey = () => {
    const t = trigger();
    return t ? `${t.kind}:${t.start}:${t.query}` : "";
  };
  const items = createMemo<MenuItem[]>(() => {
    const t = trigger();
    if (!t) return [];
    if (t.kind === "command") {
      return matchCommands(t.query).map((c) => ({ value: `/${c.name}`, main: `/${c.name}`, detail: c.summary }));
    }
    return files().map((path) => ({
      value: formatMention(path),
      main: splitPath(path).name,
      detail: splitPath(path).dir,
    }));
  });
  const menuOpen = () => items().length > 0 && triggerKey() !== dismissed();

  // File suggestions follow what is typed after the `@`; quick typing makes one request, and an
  // answer to an older query never replaces the answer to the current one.
  createEffect(
    on(
      () => {
        const t = trigger();
        return t?.kind === "mention" ? t.query : null;
      },
      (query) => {
        if (query === null) {
          setFiles([]);
          return;
        }
        let stale = false;
        const timer = setTimeout(() => {
          fetchFiles(query, MENU_ITEMS).then(
            (r) => {
              if (!stale) setFiles(r.files);
            },
            () => {
              if (!stale) setFiles([]);
            },
          );
        }, 100);
        onCleanup(() => {
          stale = true;
          clearTimeout(timer);
        });
      },
    ),
  );
  createEffect(on(triggerKey, () => setSelected(0)));

  onMount(() => {
    registerComposer(input);
    input.focus();
    // The text wraps differently when the box gets wider or narrower (the window, the sidebar or the
    // pane changed), so its height is worked out again then.
    let width = 0;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth === width) return;
      width = input.clientWidth;
      resize();
    });
    observer.observe(input);
    onCleanup(() => {
      observer.disconnect();
      registerComposer(undefined);
    });
  });

  // "Edit" on the last message puts its text back here.
  createEffect(
    on(composerRequest, (request) => {
      if (!request) return;
      setText(request.text);
      input.value = request.text;
      resize();
      input.focus();
      input.setSelectionRange(request.text.length, request.text.length);
      setCaret(request.text.length);
    }),
  );

  function resize() {
    // A box that has not been laid out yet (no width) wraps every letter onto its own line and would
    // measure itself far too tall: leave its height to the stylesheet until it has a width.
    if (input.clientWidth < MIN_MEASURABLE_WIDTH) {
      input.style.height = "";
      return;
    }
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT)}px`;
  }

  function accept(index: number) {
    const t = trigger();
    const item = items()[index];
    if (!t || !item) return;
    const done = applyCompletion(text(), t, item.value);
    setText(done.text);
    input.value = done.text;
    input.setSelectionRange(done.caret, done.caret);
    setCaret(done.caret);
    resize();
    input.focus();
  }

  function clear() {
    setText("");
    setCaret(0);
    input.value = "";
    resize();
  }

  function submit() {
    const value = text().trim();
    if (!value) return;
    clear();
    const command = parseCommand(value);
    if (command) {
      runSlashCommand(command);
      return;
    }
    setStickToBottom(true);
    if (chat.status === "running" || queue().length > 0) setQueue((q) => [...q, value]);
    else void sendMessage(value);
  }

  // Each session keeps its own half-written message and its own queue.
  createEffect(
    on(activeId, (id, previous) => {
      if (previous) remember(previous, { text: text(), queue: queue() });
      const saved = recall(id);
      setText(saved.text);
      input.value = saved.text;
      setCaret(saved.text.length);
      setQueue(saved.queue);
      // Not on the first run: the box may have no width yet, and would measure itself far too tall.
      if (previous !== undefined) resize();
    }),
  );

  // Queued messages go out when their session is shown, has been heard from, and is idle: a session
  // that has not said whether it is running yet (just switched to) must not be sent to blind.
  createEffect(
    on(
      () => [chat.ready, chat.status] as const,
      ([ready, status]) => {
        const [next, ...rest] = queue();
        if (!ready || status !== "idle" || next === undefined) return;
        setQueue(rest);
        void sendMessage(next);
      },
    ),
  );

  const stopping = () => chat.status === "running" && text().trim() === "";
  const usage = () => chat.usage;

  function onKeyDown(e: KeyboardEvent) {
    // keyCode 229 is a key press that belongs to an IME (Safari reports it after composition ends).
    const composing = e.isComposing || e.keyCode === 229;
    if (menuOpen() && !composing) {
      const count = items().length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelected((i) => (i + (e.key === "ArrowDown" ? 1 : count - 1)) % count);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(triggerKey());
        return;
      }
      // Enter completes a half-typed file or command; one typed out in full is left alone, so Enter sends.
      const t = trigger();
      const typedInFull = t !== null && items()[selected()]?.value === text().slice(t.start, t.end);
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !typedInFull)) {
        e.preventDefault();
        accept(selected());
        return;
      }
    }
    if (e.key !== "Enter" || e.shiftKey || composing) return;
    e.preventDefault();
    if (!stopping()) submit();
  }

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
      <div class="composer-anchor">
        <Show when={menuOpen()}>
          <div
            class="menu"
            id="composer-menu"
            role="listbox"
            aria-label={trigger()?.kind === "command" ? "Commands" : "Files"}
          >
            <For each={items()}>
              {(item, i) => (
                // biome-ignore lint/a11y/useFocusableInteractive: focus stays in the textarea; the option is chosen with the keys, and the pointer only mirrors them
                <div
                  class="menu-item"
                  role="option"
                  id={`composer-opt-${i()}`}
                  aria-selected={i() === selected()}
                  data-selected={i() === selected()}
                  // Pointer down, not click: a click would first blur the textarea and close the menu.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    accept(i());
                  }}
                  onPointerEnter={() => setSelected(i())}
                >
                  <span class="menu-main">{item.main}</span>
                  <span class="menu-detail">{item.detail}</span>
                </div>
              )}
            </For>
          </div>
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
            role="combobox"
            aria-expanded={menuOpen()}
            aria-controls="composer-menu"
            aria-autocomplete="list"
            aria-activedescendant={menuOpen() ? `composer-opt-${selected()}` : undefined}
            placeholder={
              chat.status === "running" ? "Albireo is working — type to queue a message" : "Message Albireo…"
            }
            aria-label="Message"
            value={text()}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setCaret(e.currentTarget.selectionStart);
              resize();
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
          />
          <button
            type="submit"
            class={stopping() ? "stop" : "primary"}
            disabled={!stopping() && (text().trim() === "" || !chat.connected)}
          >
            {stopping() ? "Stop" : chat.status === "running" ? "Queue" : "Send"}
          </button>
        </form>
      </div>
      <p class="footnote">
        <span>Enter to send · Shift+Enter for a new line · @ for files · / for commands</span>
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
