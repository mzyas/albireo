import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { modelSuggestions, providerLabel } from "../lib/vault.ts";
import { switchModel } from "../state/actions.ts";
import { vault } from "../state/secrets.ts";
import { chat } from "../state/store.ts";
import { setSwitcherOpen, switcherOpen } from "../state/ui.ts";

/** The provider · model chip in the top bar, with a small popover to switch between turns. */
export function ModelSwitcher() {
  let root!: HTMLDivElement;
  const open = switcherOpen;
  const setOpen = setSwitcherOpen;
  const [picked, setPicked] = createSignal("");
  const [model, setModel] = createSignal("");

  const options = () => {
    const s = vault();
    return s?.providerOrder?.length ? s.providerOrder : chat.providers;
  };
  const selected = () => (options().includes(picked()) ? picked() : chat.provider);
  const suggestions = () => modelSuggestions(vault()?.providers[selected()]);

  // A switch (ours or another client's) resets the form to what is now active.
  createEffect(
    on(
      () => chat.provider,
      (p) => {
        setPicked(p);
        setModel("");
      },
    ),
  );

  createEffect(() => {
    if (!open()) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    });
  });

  return (
    <div class="switcher" ref={root}>
      <button
        type="button"
        class="chip"
        aria-expanded={open()}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        disabled={!chat.ready}
      >
        <span class="chip-provider">{chat.provider || "…"}</span>
        <span class="chip-model">{chat.model}</span>
      </button>
      <Show when={open()}>
        <form
          class="popover stack"
          aria-label="Switch model"
          onSubmit={(e) => {
            e.preventDefault();
            switchModel(selected(), model().trim());
            setOpen(false);
          }}
        >
          <label for="sw-provider">Provider</label>
          <select id="sw-provider" value={selected()} onChange={(e) => setPicked(e.currentTarget.value)}>
            <For each={options()}>
              {(id) => (
                <option value={id} selected={id === selected()}>
                  {providerLabel(id, vault()?.providers[id])}
                </option>
              )}
            </For>
          </select>
          <label for="sw-model">Model</label>
          <input
            id="sw-model"
            list="sw-models"
            placeholder="provider default"
            autocomplete="off"
            spellcheck={false}
            value={model()}
            onInput={(e) => setModel(e.currentTarget.value)}
          />
          <datalist id="sw-models">
            <For each={suggestions()}>{(m) => <option value={m} />}</For>
          </datalist>
          <button type="submit" class="primary" disabled={chat.status === "running"}>
            {chat.status === "running" ? "Wait for the turn to end" : "Switch"}
          </button>
        </form>
      </Show>
    </div>
  );
}
