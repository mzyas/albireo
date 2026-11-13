import { useEffect, useReducer, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import type { Session } from "@albireo/core";
import { initialState, reduce, type Item } from "./state.js";

function clip(text: string, lines: number, width = 200): string {
  const all = text.split("\n");
  const head = all.slice(0, lines).map((l) => (l.length > width ? l.slice(0, width) + "…" : l));
  return head.join("\n") + (all.length > lines ? `\n… (${all.length - lines} more lines)` : "");
}

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <Text color="cyan">› {item.text}</Text>;
    case "assistant":
      return <Text>{item.text}</Text>;
    case "tool":
      return <Text color="yellow">⚙ {clip(item.text, 1)}</Text>;
    case "result":
      return <Text color={item.isError ? "red" : "gray"}>{clip(item.text, 6)}</Text>;
    case "notice":
      return <Text color="gray">· {item.text}</Text>;
    case "error":
      return <Text color="red">✖ {item.text}</Text>;
  }
}

export function App({ session, panelUrl }: { session: Session; panelUrl?: string }) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reduce, session.snapshot(), initialState);
  const [input, setInput] = useState("");

  useEffect(() => session.on((e) => dispatch(e)), [session]);

  function runSlash(line: string) {
    const [cmd, ...args] = line.slice(1).split(/\s+/);
    try {
      switch (cmd) {
        case "provider":
          if (!args[0]) throw new Error("usage: /provider <anthropic|openai> [model]");
          session.switchProvider(args[0], args[1]);
          break;
        case "model":
          if (!args[0]) throw new Error("usage: /model <model-id>");
          session.setModel(args[0]);
          break;
        case "abort":
          session.abort();
          break;
        case "panel":
          session.notice(panelUrl ? `Panel: ${panelUrl}` : "Panel is disabled (started with --no-panel).");
          break;
        case "exit":
        case "quit":
          exit();
          break;
        default:
          session.notice("Commands: /provider <id> [model], /model <id>, /panel, /abort, /exit");
      }
    } catch (err) {
      session.notice(err instanceof Error ? err.message : String(err));
    }
  }

  useInput((ch, key) => {
    const approval = state.approval;
    if (approval) {
      if (ch === "y" || ch === "Y") session.approve(approval.id, true);
      else if (ch === "n" || ch === "N" || key.escape) session.approve(approval.id, false);
      return;
    }
    if (key.ctrl && ch === "c") {
      if (state.status === "running") session.abort();
      else exit();
      return;
    }
    if (key.escape) {
      session.abort();
      return;
    }
    if (key.return) {
      const text = input.trim();
      if (!text || state.status === "running") return;
      setInput("");
      if (text.startsWith("/")) runSlash(text);
      else void session.send(text);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((s) => Array.from(s).slice(0, -1).join(""));
      return;
    }
    if (ch && !key.ctrl && !key.meta) setInput((s) => s + ch);
  });

  return (
    <Box flexDirection="column">
      <Static items={state.items}>{(item) => <Row key={item.id} item={item} />}</Static>

      {state.live && (
        <Box flexDirection="column">
          {state.live.reasoning ? <Text color="gray" dimColor>{clip(state.live.reasoning.slice(-300), 3)}</Text> : null}
          {state.live.text ? <Text>{state.live.text}</Text> : null}
        </Box>
      )}

      {state.approval && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">
            Allow {state.approval.name} ({state.approval.risk})?  [y] allow  [n] deny
          </Text>
          <Text>{clip(JSON.stringify(state.approval.input, null, 2), 12)}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          {state.provider} · {state.model} · {state.status}
          {panelUrl ? " · /panel for GUI" : ""}
        </Text>
      </Box>
      <Box>
        <Text color="cyan">{state.status === "running" ? "… " : "> "}</Text>
        <Text>{input}</Text>
        <Text inverse> </Text>
      </Box>
    </Box>
  );
}
