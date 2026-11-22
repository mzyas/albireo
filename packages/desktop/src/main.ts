// The Electron shell. It runs the kernel in this process (the same vault and saved sessions as the command
// line) and shows the panel in a window. The window is a browser for one local address and nothing
// else: no Node in the page, no other sites, no permissions, one message to the shell (the folder picker).
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultVaultDir } from "@albireo/vault";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  screen,
  session,
  shell,
} from "electron";
import { workspaceArg } from "./args.js";
import { pickFolder } from "./folder.js";
import { PICK_DIRECTORY } from "./ipc.js";
import { type Kernel, openStores, recentUse, startKernel } from "./kernel.js";
import { externalLink, grantsPermission, isPanelUrl, mayUseShell } from "./policy.js";
import { type DesktopState, isReachable, readState, type WindowState, writeState } from "./state.js";

const TITLE = "Albireo";

// Electron keeps its own files (caches, the page's local storage) in a folder of the config dir, apart
// from the vault and the sessions beside it. Must be set before the app is ready.
app.setPath("userData", path.join(defaultVaultDir(), "desktop"));
app.setName(TITLE);
if (process.platform === "win32") app.setAppUserModelId("com.albireo.desktop");

/** The origin of the panel; set once the kernel is up. Nothing else may be shown or use the shell. */
let panelOrigin = "";
let kernel: Kernel | undefined;
let window: BrowserWindow | undefined;
let windowState: WindowState | undefined;

// Two copies would both write the same saved sessions: a second launch only brings the first to the front.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  void main();
}

// ---- what every page in the app may do (set before any window exists) -----------------------------

app.on("web-contents-created", (_event, contents) => {
  // Links go to the system's browser or mail program; the window itself never leaves the panel.
  contents.setWindowOpenHandler(({ url }) => {
    const target = externalLink(url);
    if (target) void shell.openExternal(target);
    return { action: "deny" };
  });
  const keepInPanel = (event: { preventDefault(): void }, url: string) => {
    if (isPanelUrl(url, panelOrigin)) return;
    event.preventDefault();
    const target = externalLink(url);
    if (target) void shell.openExternal(target);
  };
  contents.on("will-navigate", keepInPanel);
  contents.on("will-redirect", keepInPanel);
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

function limitPermissions(): void {
  // Requests and checks both go through `grantsPermission`: only what it lists is allowed, and only to the panel.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(grantsPermission(permission, details.requestingUrl, panelOrigin)),
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    grantsPermission(permission, requestingOrigin, panelOrigin),
  );
}

// ---- starting up -----------------------------------------------------------------------------------

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await app.whenReady();
  limitPermissions();
  const stateFile = path.join(app.getPath("userData"), "state.json");
  const saved = await readState(stateFile);
  try {
    const stores = await openStores();
    const recent = await recentUse(stores);

    // Which folder to open: the one named on the command line, else where the user left off, else ask.
    const named = workspaceArg(process.argv, process.defaultApp === true);
    let cwd = named === undefined ? recent.cwd : path.resolve(named);
    if (named !== undefined && !(await isDirectory(cwd as string))) {
      dialog.showErrorBox(TITLE, "The folder given on the command line does not exist.");
      app.exit(2);
      return;
    }
    if (cwd === undefined) {
      cwd =
        (await pickFolder(
          (options) =>
            dialog.showOpenDialog({
              ...options,
              title: "Choose the folder Albireo works in",
              properties: ["openDirectory", "createDirectory"],
            }),
          undefined,
        )) ?? undefined;
    }
    if (cwd === undefined) {
      app.exit(0);
      return;
    }

    kernel = await startKernel(stores, {
      cwd,
      provider: recent.provider,
      port: saved.port,
      onSaveError: (message) => console.error(message),
    });
  } catch (err) {
    // Messages from the manager and the vault are written for users; anything else may carry paths.
    const known = err instanceof Error && ["ManagerError", "VaultError", "StoreError"].includes(err.name);
    dialog.showErrorBox(TITLE, known ? (err as Error).message : "Albireo could not start.");
    app.exit(1);
    return;
  }
  panelOrigin = new URL(kernel.url).origin;
  const port = Number(new URL(kernel.url).port);
  if (port !== saved.port) await writeState(stateFile, { ...saved, port }).catch(() => {});

  ipcMain.handle(PICK_DIRECTORY, (event, startIn: unknown) => {
    // Only the panel's own page, in our window, may ask: the page shows model output, which is untrusted.
    if (event.sender !== window?.webContents || !mayUseShell(event.senderFrame?.url, panelOrigin)) {
      throw new Error("not allowed");
    }
    return pickFolder(
      (options) =>
        dialog.showOpenDialog(window as BrowserWindow, {
          ...options,
          title: "Choose a workspace folder",
          properties: ["openDirectory", "createDirectory"],
        }),
      startIn,
    );
  });

  Menu.setApplicationMenu(buildMenu());
  openWindow(saved);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow(saved);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => app.quit());

  // Quitting waits for the conversations to reach the disk (and the window's place to be remembered).
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing || !kernel) return;
    event.preventDefault();
    closing = true;
    rememberWindow();
    void (async () => {
      try {
        const state: DesktopState = {
          ...(await readState(stateFile)),
          ...(windowState ? { window: windowState } : {}),
        };
        await writeState(stateFile, state).catch(() => {});
        await kernel?.close();
      } catch (err) {
        console.error(err instanceof Error ? err.message : err);
      } finally {
        app.exit(0);
      }
    })();
  });
}

/**
 * Notes where the window is. Quitting (Ctrl+Q, the menu, a signal) starts before the window's own
 * `close` event, so this runs from both: whichever comes first, the last known place is kept.
 */
function rememberWindow(): void {
  if (!window || window.isDestroyed()) return;
  const { x, y, width, height } = window.getNormalBounds();
  windowState = { x, y, width, height, maximized: window.isMaximized() };
}

function openWindow(saved: DesktopState): void {
  const place = saved.window;
  const areas = screen.getAllDisplays().map((d) => d.workArea);
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 360,
    title: TITLE,
    show: false,
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  const win = window;
  if (place) {
    // The saved size comes from `getNormalBounds`, so it goes back through `setBounds`: the constructor's
    // width and height count the window frame differently on Windows, and a window restored with them
    // would come back a little bigger each run.
    const there =
      place.x !== undefined &&
      place.y !== undefined &&
      isReachable({ x: place.x, y: place.y, width: place.width, height: place.height }, areas);
    if (there) win.setBounds({ x: place.x, y: place.y, width: place.width, height: place.height });
    else win.setSize(place.width, place.height);
  }
  win.once("ready-to-show", () => {
    if (place?.maximized) win.maximize();
    win.show();
  });
  // Remembered when the window closes, so the next run opens it where it was.
  win.on("close", rememberWindow);
  win.on("closed", () => {
    if (window === win) window = undefined;
  });
  void win.loadURL((kernel as Kernel).url);
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        // The developer tools show the page's address, which carries the run's token: left to developers.
        ...(app.isPackaged ? [] : ([{ role: "toggleDevTools" }] as MenuItemConstructorOptions[])),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
