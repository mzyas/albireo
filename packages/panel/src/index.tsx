import { createEffect, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { connect } from "./state/connection.ts";
import { activeId, loadSessions } from "./state/sessions.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

render(() => {
  // One stream, for the session being shown: switching sessions closes it and opens the next.
  createEffect(() => {
    const id = activeId();
    if (id) onCleanup(connect(id));
  });
  void loadSessions();
  return <App />;
}, root);
