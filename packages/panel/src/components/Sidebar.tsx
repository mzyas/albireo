import { createMemo, createSignal, For, Show } from "solid-js";
import { formatAgo, groupByWorkspace, sessionTitle, workspaceKey } from "../lib/sessions.ts";
import type { SessionSummary } from "../protocol.ts";
import { activeId, removeSession, selectSession, sessionError, sessions } from "../state/sessions.ts";
import { isNarrow, setNewSessionOpen, setSidebarOpen } from "../state/ui.ts";

function SessionRow(props: { session: SessionSummary }) {
  const [confirming, setConfirming] = createSignal(false);
  const active = () => props.session.id === activeId();
  const status = () => {
    if (props.session.pending > 0) return "Waiting for your approval";
    if (props.session.status === "running") return "Working";
    return formatAgo(props.session.updatedAt);
  };
  return (
    <li class="session" data-active={active()}>
      <button
        type="button"
        class="session-main"
        aria-current={active() ? "true" : undefined}
        onClick={() => {
          void selectSession(props.session.id);
          // On a narrow screen the sidebar covers the conversation, so it gets out of the way.
          if (isNarrow()) setSidebarOpen(false);
        }}
      >
        <span class="session-title">{sessionTitle(props.session)}</span>
        <span class="session-meta">
          <Show when={props.session.status === "running" && props.session.pending === 0}>
            <i class="dot" aria-hidden="true" />
          </Show>
          <Show when={props.session.pending > 0}>
            <span class="badge" aria-hidden="true">
              !
            </span>
          </Show>
          <span data-waiting={props.session.pending > 0}>{status()}</span>
        </span>
      </button>
      <Show
        when={confirming()}
        fallback={
          <button
            type="button"
            class="ghost session-delete"
            aria-label={`Delete “${sessionTitle(props.session)}”`}
            title="Delete this session"
            onClick={() => setConfirming(true)}
          >
            ×
          </button>
        }
      >
        <span class="session-confirm">
          <button
            type="button"
            class="danger"
            onClick={() => {
              setConfirming(false);
              void removeSession(props.session.id);
            }}
          >
            Delete
          </button>
          <button type="button" class="ghost" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      </Show>
    </li>
  );
}

/** The sessions the server has, grouped by workspace, with a way to start one and to delete one. */
export function Sidebar() {
  const groups = createMemo(() => groupByWorkspace(sessions()?.sessions ?? []));
  // The groups are rebuilt at every change, so they are followed by their key (a string, which `For`
  // compares by value) and not as objects: a group, and the rows in it, stay what they were.
  const keys = createMemo(() => groups().map((g) => workspaceKey(g.cwd)));
  const group = (key: string) => groups().find((g) => workspaceKey(g.cwd) === key);
  return (
    <aside class="sidebar" aria-label="Sessions">
      <div class="sidebar-head">
        <h2>Sessions</h2>
        <Show when={sessions()?.canCreate}>
          <button type="button" class="primary" onClick={() => setNewSessionOpen(true)}>
            New
          </button>
        </Show>
      </div>
      <div class="sidebar-body">
        <Show when={sessionError()}>
          {(message) => (
            <p class="form-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={sessions()} fallback={<p class="muted">Loading…</p>}>
          <Show when={groups().length > 0} fallback={<p class="muted">No sessions yet.</p>}>
            <For each={keys()}>
              {(key) => (
                <section class="ws-group">
                  <h3 title={group(key)?.cwd}>{group(key)?.name}</h3>
                  <ul class="plain">
                    <For each={group(key)?.sessions ?? []}>{(s) => <SessionRow session={s} />}</For>
                  </ul>
                </section>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
