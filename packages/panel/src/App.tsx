import { createEffect, Show } from "solid-js";
import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { KeysDialog } from "./components/KeysDialog.tsx";
import { NewSessionDialog } from "./components/NewSessionDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { SidePane } from "./components/SidePane.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { waitingCount } from "./lib/sessions.ts";
import { sessions } from "./state/sessions.ts";
import { keysOpen, newSessionOpen, paneOpen, setKeysOpen, setNewSessionOpen, sidebarOpen } from "./state/ui.ts";

export function App() {
  // A session in the background that needs an answer shows in the tab's title.
  createEffect(() => {
    const waiting = waitingCount(sessions()?.sessions ?? []);
    document.title = waiting > 0 ? `(${waiting}) Albireo: needs your answer` : "Albireo";
  });
  return (
    <div class="app">
      <TopBar />
      <div class="body">
        <Show when={sidebarOpen()}>
          <Sidebar />
        </Show>
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
      <NewSessionDialog open={newSessionOpen()} onClose={() => setNewSessionOpen(false)} />
    </div>
  );
}
