import { onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App.tsx";
import { connect } from "./state/connection.ts";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

render(() => {
  onCleanup(connect());
  return <App />;
}, root);
