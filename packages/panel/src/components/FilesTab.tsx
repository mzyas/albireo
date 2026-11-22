import { For, onMount, Show } from "solid-js";
import { formatBytes, splitPath } from "../lib/workspace.ts";
import {
  dataOf,
  errorOf,
  fileList,
  fileQuery,
  openFile,
  preview,
  previewPath,
  searchFiles,
} from "../state/workspace.ts";

function FileList() {
  onMount(() => {
    if (fileList().state === "idle") searchFiles(fileQuery(), 0);
  });
  const list = () => dataOf(fileList());
  return (
    <>
      <div class="pane-row">
        <input
          type="search"
          class="grow"
          placeholder="Find a file…"
          aria-label="Find a file"
          autocomplete="off"
          spellcheck={false}
          value={fileQuery()}
          onInput={(e) => searchFiles(e.currentTarget.value)}
        />
      </div>
      <Show when={errorOf(fileList())}>
        {(message) => (
          <p class="form-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={list()} fallback={<p class="muted pane-empty">{fileList().state === "loading" ? "Loading…" : ""}</p>}>
        {(l) => (
          <Show when={l().files.length > 0} fallback={<p class="muted pane-empty">No file matches.</p>}>
            <ul class="file-list" aria-label="Files">
              <For each={l().files}>
                {(path) => (
                  <li>
                    <button type="button" class="file-row" onClick={() => void openFile(path)}>
                      <span class="file-path">
                        <span class="dir">{splitPath(path).dir}</span>
                        <span class="name">{splitPath(path).name}</span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <p class="muted">
              {l().files.length < l().total
                ? `Showing ${l().files.length} of ${l().total} files. Type to narrow it down.`
                : `${l().total} files`}
            </p>
          </Show>
        )}
      </Show>
    </>
  );
}

function FilePreview() {
  return (
    <>
      <div class="pane-row">
        <button type="button" class="ghost" onClick={() => void openFile(null)}>
          ← Files
        </button>
        <Show when={dataOf(preview())}>{(p) => <span class="muted">{formatBytes(p().size)}</span>}</Show>
      </div>
      <p class="detail-path">{previewPath()}</p>
      <Show when={errorOf(preview())}>
        {(message) => (
          <p class="form-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <Show when={dataOf(preview())} fallback={<p class="muted">{preview().state === "loading" ? "Loading…" : ""}</p>}>
        {(p) => (
          <Show when={!p().binary} fallback={<p class="muted">This is a binary file, so it is not shown.</p>}>
            <pre class="file-view">{p().content}</pre>
            <Show when={p().truncated}>
              <p class="muted">The file is long; only the first part is shown.</p>
            </Show>
          </Show>
        )}
      </Show>
    </>
  );
}

export function FilesTab() {
  return (
    <Show when={previewPath() !== null} fallback={<FileList />}>
      <FilePreview />
    </Show>
  );
}
