import { For, Match, Switch } from "solid-js";
import { type PaneTab, paneTab, paneWide, setPaneOpen, setPaneTab, setPaneWide } from "../state/ui.ts";
import { changes, dataOf } from "../state/workspace.ts";
import { ChangesTab } from "./ChangesTab.tsx";
import { ContextTab } from "./ContextTab.tsx";
import { FilesTab } from "./FilesTab.tsx";

const TABS: { id: PaneTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "files", label: "Files" },
  { id: "context", label: "Context" },
];

/** The right-hand pane: what changed, the workspace's files, and what the model is working with. */
export function SidePane() {
  const count = () => dataOf(changes())?.files.length ?? 0;
  return (
    <aside class="pane" data-wide={paneWide()} aria-label="Workspace">
      <div class="pane-head">
        <div class="tabs" role="tablist" aria-label="Workspace views">
          <For each={TABS}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                class="tab"
                aria-selected={paneTab() === tab.id}
                aria-controls="pane-panel"
                tabindex={paneTab() === tab.id ? 0 : -1}
                onClick={() => setPaneTab(tab.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  e.preventDefault();
                  const i = TABS.findIndex((t) => t.id === paneTab());
                  const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
                  if (!next) return;
                  setPaneTab(next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }}
              >
                {tab.label}
                {tab.id === "changes" && count() > 0 ? <span class="count">{count()}</span> : null}
              </button>
            )}
          </For>
        </div>
        <span class="spacer" />
        <button
          type="button"
          class="ghost"
          aria-pressed={paneWide()}
          title={paneWide() ? "Make the pane narrower" : "Make the pane wider"}
          onClick={() => setPaneWide(!paneWide())}
        >
          {paneWide() ? "⇥" : "⇤"}
        </button>
        <button type="button" class="ghost" aria-label="Close the pane" onClick={() => setPaneOpen(false)}>
          ×
        </button>
      </div>
      <div class="pane-body" role="tabpanel" id="pane-panel" aria-labelledby={`tab-${paneTab()}`}>
        <Switch>
          <Match when={paneTab() === "changes"}>
            <ChangesTab />
          </Match>
          <Match when={paneTab() === "files"}>
            <FilesTab />
          </Match>
          <Match when={paneTab() === "context"}>
            <ContextTab />
          </Match>
        </Switch>
      </div>
    </aside>
  );
}
