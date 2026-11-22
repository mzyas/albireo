import { Lexer } from "marked";
import { createMemo, createSignal, For, Index, Match, onCleanup, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { decodeEntities, safeHref } from "../lib/markdown.ts";

// Markdown is rendered from the lexer's tokens straight into elements. Nothing here goes through
// innerHTML: model output is untrusted, and raw HTML in it is shown as text.

/** The parts of marked's tokens this renderer reads. */
interface Tok {
  type: string;
  raw?: string;
  text?: string;
  tokens?: Tok[];
  depth?: number;
  lang?: string;
  ordered?: boolean;
  start?: number | "";
  items?: Tok[];
  task?: boolean;
  checked?: boolean;
  header?: Tok[];
  rows?: Tok[][];
  align?: string | null;
  href?: string;
}

export function Markdown(props: { text: string }) {
  const tokens = createMemo(() => Lexer.lex(props.text) as unknown as Tok[]);
  return (
    <div class="md">
      <Blocks tokens={tokens()} />
    </div>
  );
}

function Blocks(props: { tokens: Tok[] | undefined }) {
  // Index, not For: while text streams in, blocks keep their elements and only their content updates.
  return <Index each={props.tokens ?? []}>{(t) => <Block t={t()} />}</Index>;
}

function Block(props: { t: Tok }) {
  return (
    <Switch fallback={decodeEntities(props.t.text ?? "")}>
      <Match when={props.t.type === "space" || props.t.type === "def"}>{null}</Match>
      <Match when={props.t.type === "paragraph"}>
        <p>
          <Inline tokens={props.t.tokens} />
        </p>
      </Match>
      {/* A bare `text` block is a list item's content. */}
      <Match when={props.t.type === "text"}>
        <Inline tokens={props.t.tokens ?? [{ type: "text", text: props.t.text }]} />
      </Match>
      <Match when={props.t.type === "heading"}>
        <Dynamic component={["h3", "h4", "h5"][Math.min(Math.max(props.t.depth ?? 1, 1), 3) - 1]}>
          <Inline tokens={props.t.tokens} />
        </Dynamic>
      </Match>
      <Match when={props.t.type === "code"}>
        <CodeBlock lang={props.t.lang ?? ""} text={props.t.text ?? ""} />
      </Match>
      <Match when={props.t.type === "blockquote"}>
        <blockquote>
          <Blocks tokens={props.t.tokens} />
        </blockquote>
      </Match>
      <Match when={props.t.type === "hr"}>
        <hr />
      </Match>
      <Match when={props.t.type === "list"}>
        <ListBlock t={props.t} />
      </Match>
      <Match when={props.t.type === "table"}>
        <TableBlock t={props.t} />
      </Match>
      {/* Raw HTML is shown as written, never interpreted. */}
      <Match when={props.t.type === "html"}>
        <p class="md-raw">{(props.t.text ?? "").trim()}</p>
      </Match>
    </Switch>
  );
}

function ListBlock(props: { t: Tok }) {
  const items = () => props.t.items ?? [];
  return (
    <Show
      when={props.t.ordered}
      fallback={
        <ul>
          <ListItems items={items()} />
        </ul>
      }
    >
      <ol start={typeof props.t.start === "number" ? props.t.start : 1}>
        <ListItems items={items()} />
      </ol>
    </Show>
  );
}

function ListItems(props: { items: Tok[] }) {
  return (
    <Index each={props.items}>
      {(item) => (
        <li classList={{ task: item().task === true }}>
          {/* The box is positioned in the margin by CSS, so it can follow the text blocks here. */}
          <Show when={item().task}>
            <input type="checkbox" checked={item().checked === true} disabled aria-label="Task" />
          </Show>
          <Blocks tokens={item().tokens?.filter((t) => t.type !== "checkbox")} />
        </li>
      )}
    </Index>
  );
}

function TableBlock(props: { t: Tok }) {
  const align = (cell: Tok) => (cell.align ? (cell.align as "left" | "center" | "right") : undefined);
  return (
    <div class="md-table">
      <table>
        <thead>
          <tr>
            <Index each={props.t.header ?? []}>
              {(cell) => (
                <th style={{ "text-align": align(cell()) }}>
                  <Inline tokens={cell().tokens} />
                </th>
              )}
            </Index>
          </tr>
        </thead>
        <tbody>
          <Index each={props.t.rows ?? []}>
            {(row) => (
              <tr>
                <Index each={row()}>
                  {(cell) => (
                    <td style={{ "text-align": align(cell()) }}>
                      <Inline tokens={cell().tokens} />
                    </td>
                  )}
                </Index>
              </tr>
            )}
          </Index>
        </tbody>
      </table>
    </div>
  );
}

function CodeBlock(props: { lang: string; text: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the text stays selectable.
    }
  }
  return (
    <div class="code">
      <div class="code-head">
        <span>{props.lang.split(/\s/)[0] || "text"}</span>
        <button type="button" class="ghost" onClick={copy}>
          {copied() ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{props.text}</code>
      </pre>
    </div>
  );
}

function Inline(props: { tokens: Tok[] | undefined }) {
  return (
    <For each={props.tokens ?? []}>
      {(t) => (
        <Switch fallback={decodeEntities(t.text ?? t.raw ?? "")}>
          <Match when={t.type === "text" || t.type === "escape"}>
            <Show when={t.tokens} fallback={decodeEntities(t.text ?? "")}>
              {(inner) => <Inline tokens={inner()} />}
            </Show>
          </Match>
          <Match when={t.type === "strong"}>
            <strong>
              <Inline tokens={t.tokens} />
            </strong>
          </Match>
          <Match when={t.type === "em"}>
            <em>
              <Inline tokens={t.tokens} />
            </em>
          </Match>
          <Match when={t.type === "del"}>
            <del>
              <Inline tokens={t.tokens} />
            </del>
          </Match>
          <Match when={t.type === "codespan"}>
            <code class="inline">{decodeEntities(t.text ?? "")}</code>
          </Match>
          <Match when={t.type === "br"}>
            <br />
          </Match>
          <Match when={t.type === "link"}>
            <Show
              when={safeHref(t.href ?? "")}
              fallback={
                <span>
                  <Inline tokens={t.tokens} />
                </span>
              }
            >
              {(href) => (
                <a href={href()} target="_blank" rel="noopener noreferrer">
                  <Inline tokens={t.tokens} />
                </a>
              )}
            </Show>
          </Match>
          {/* Images are not fetched: a remote URL in model output could leak data. */}
          <Match when={t.type === "image"}>
            <span class="md-image">[image: {decodeEntities(t.text ?? "") || (t.href ?? "")}]</span>
          </Match>
          <Match when={t.type === "html"}>{t.text ?? ""}</Match>
        </Switch>
      )}
    </For>
  );
}
