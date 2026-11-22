// Runs in the page's world before the page does, sandboxed: it can't import anything but `electron`, so
// the message name is spelled out here (ipc.ts has the same string; a test checks they agree).

import type { DesktopBridge } from "@albireo/server/protocol" with { "resolution-mode": "import" };
import { contextBridge, ipcRenderer } from "electron";

const bridge: DesktopBridge = {
  pickDirectory: (startIn) => ipcRenderer.invoke("albireo:pick-directory", startIn),
};

contextBridge.exposeInMainWorld("albireo", bridge);
