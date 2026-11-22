import { For, Show } from "solid-js";
import { noChangesReason, STATUS_LABEL, STATUS_LETTER, splitPath } from "../lib/workspace.ts";
import type { ChangedFile } from "../protocol.ts";
import { changes, dataOf, diff, errorOf, refreshChanges, selectChange, selectedChange } from "../state/workspace.ts";
import { DiffView } from "./DiffView.tsx";

function FileRow(props: { file: ChangedFile }) {
  const parts = () => splitPath(props.file.path);
  return (
    <li>
      <button type="button" class="file-row" onClick={() => selectChange(props.file)}>
        <span class="status" data-status={props.file.status} title={STATUS_LABEL[props.file.status]}>
          {STATUS_LETTER[props.file.status]}
        </span>
        <span class="file-path">
          <span class="dir">{parts().dir}</span>
          <span class="name">{parts().name}</span>
          <Show when={props.file.from}>
            <span class="from"> ← {props.file.from}</span>
          </Show>
        </span>
      </button>
    </li>
  );
}

function ChangeList() {
  const data = () => dataOf(changes());
  const summary = () => {
    const c = data();
    if (!c?.git) return "";
    const n = c.files.length;
    return `${c.detached ? "detached HEAD" : (c.branch ?? "no branch")} · ${n === 1 ? "1 file" : `${n} files`} changed`;
  };
  return (
    <>
      <div class="pane-row">
        <span class="muted">{summary()}</span>
        <button
          type="button"
          class="ghost"
          onClick={() => void refreshChanges()}
          disabled={changes().state === "loading"}
        >
          Refresh
        </button>
      </div>
      <Show when={errorOf(changes())}>
        {(message) => (
          <p class="form-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={data()} fallback={<p class="muted pane-empty">{changes().state === "loading" ? "Loading…" : ""}</p>}>
        {(c) => (
          <Show when={noChangesReason(c())} fallback={<Files files={c().files} truncated={c().truncated} />}>
            {(reason) => <p class="muted pane-empty">{reason()}</p>}
          </Show>
        )}
      </Show>
    </>
  );
}

function Files(props: { files: ChangedFile[]; truncated: boolean }) {
  return (
    <Show when={props.files.length > 0} fallback={<p class="muted pane-empty">No changes.</p>}>
      <ul class="file-list" aria-label="Changed files">
        <For each={props.files}>{(file) => <FileRow file={file} />}</For>
      </ul>
      <Show when={props.truncated}>
        <p class="muted">More files changed than are listed.</p>
      </Show>
    </Show>
  );
}

function ChangeDetail(props: { file: ChangedFile }) {
  return (
    <>
      <div class="pane-row">
        <button type="button" class="ghost" onClick={() => selectChange(null)}>
          ← Changes
        </button>
        <span class="status" data-status={props.file.status}>
          {STATUS_LABEL[props.file.status]}
        </span>
      </div>
      <p class="detail-path">{props.file.path}</p>
      <Show when={errorOf(diff())}>
        {(message) => (
          <p class="form-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={dataOf(diff())} fallback={<p class="muted">{diff().state === "loading" ? "Loading…" : ""}</p>}>
        {(d) => (
          <Show when={d().diff.trim() !== ""} fallback={<p class="muted">No changes in this file any more.</p>}>
            <DiffView text={d().diff} truncated={d().truncated} />
          </Show>
        )}
      </Show>
    </>
  );
}

export function ChangesTab() {
  return (
    <Show when={selectedChange()} fallback={<ChangeList />}>
      {(file) => <ChangeDetail file={file()} />}
    </Show>
  );
}
