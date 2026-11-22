import { Show } from "solid-js";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { KeysDialog } from "./components/KeysDialog.tsx";
import { SidePane } from "./components/SidePane.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { keysOpen, paneOpen, setKeysOpen } from "./state/ui.ts";

export function App() {
  return (
    <div class="app">
      <TopBar />
      <div class="body">
        <div class="main">
          <Conversation />
          <div class="dock">
            <ApprovalCard />
            <Composer />
          </div>
        </div>
        <Show when={paneOpen()}>
          <SidePane />
        </Show>
      </div>
      <KeysDialog open={keysOpen()} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
