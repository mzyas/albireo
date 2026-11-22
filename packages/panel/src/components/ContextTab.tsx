import { For, Show } from "solid-js";
import { formatTokens } from "../lib/format.ts";
import { formatBytes } from "../lib/workspace.ts";
import { chat } from "../state/store.ts";
import { openPane } from "../state/ui.ts";
import { changes, dataOf, openFile } from "../state/workspace.ts";

/** What the model is working with: the workspace, the instructions it was given, and how much it has used. */
export function ContextTab() {
  const git = () => dataOf(changes());
  return (
    <div class="context">
      <section>
        <h3>Workspace</h3>
        <p class="path" title={chat.cwd}>
          {chat.cwd || "—"}
        </p>
        <Show when={git()?.git && git()?.branch}>
          <p class="muted">on {git()?.branch}</p>
        </Show>
      </section>

      <section>
        <h3>Instructions</h3>
        <Show
          when={chat.instructions.length > 0}
          fallback={
            <p class="muted">None loaded. Put an AGENTS.md at the workspace root to tell the agent how to work here.</p>
          }
        >
          <ul class="plain">
            <For each={chat.instructions}>
              {(file) => (
                <li>
                  <button
                    type="button"
                    class="link"
                    onClick={() => {
                      openPane("files");
                      void openFile(file.path);
                    }}
                  >
                    {file.path}
                  </button>
                  <span class="muted"> · {formatBytes(file.bytes)}</span>
                  <Show when={file.truncated}>
                    <p class="warn">Too long: only the first part reaches the model.</p>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <p class="muted">Sent to the model with every request, so they count against its context.</p>
        </Show>
      </section>

      <section>
        <h3>Tokens</h3>
        <Show when={chat.usage.input + chat.usage.output > 0} fallback={<p class="muted">Nothing used yet.</p>}>
          <dl class="stats">
            <dt>Last request</dt>
            <dd title="Tokens the model was sent in its latest request, cached ones included">
              {formatTokens(chat.context)}
            </dd>
            <dt>Sent, in all</dt>
            <dd>{formatTokens(chat.usage.input)}</dd>
            <dt>Received, in all</dt>
            <dd>{formatTokens(chat.usage.output)}</dd>
            <Show when={chat.usage.cacheRead > 0}>
              <dt>Read from cache</dt>
              <dd>{formatTokens(chat.usage.cacheRead)}</dd>
            </Show>
          </dl>
          <p class="muted">
            "Last request" is how much of the model's context the conversation takes now. Totals count what this page
            has seen since it connected.
          </p>
        </Show>
      </section>
    </div>
  );
}
