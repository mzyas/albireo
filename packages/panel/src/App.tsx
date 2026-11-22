import { ApprovalCard } from "./components/ApprovalCard.tsx";
import { Composer } from "./components/Composer.tsx";
import { Conversation } from "./components/Conversation.tsx";
import { KeysDialog } from "./components/KeysDialog.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { keysOpen, setKeysOpen } from "./state/ui.ts";

export function App() {
  return (
    <div class="app">
      <TopBar />
      <Conversation />
      <div class="dock">
        <ApprovalCard />
        <Composer />
      </div>
      <KeysDialog open={keysOpen()} onClose={() => setKeysOpen(false)} />
    </div>
  );
}
