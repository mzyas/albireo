# @albireo/desktop

Electron 外壳：在主进程里运行内核（和命令行用同一个 vault、同一批保存的会话），在一个窗口里显示面板，并给面板一个原生的文件夹选择器。`private`，不发布。

- 运行：先 `pnpm build`（窗口加载的就是构建好的面板），再 `pnpm --filter @albireo/desktop start`，后面可以跟一个文件夹路径当工作区。不带路径时回到上次离开的地方（最近一个保存过的会话的工作区和 provider）；第一次运行、没有可回去的地方时弹出系统的文件夹选择器，取消就退出。
- Electron 的二进制由它自己的安装脚本下载；pnpm 默认不跑安装脚本，放行写在 `pnpm-workspace.yaml` 的 `allowBuilds`。CI 不启动 Electron，所以 `.github/workflows/ci.yml` 里设了 `ELECTRON_SKIP_BINARY_DOWNLOAD`，不下载那一百多 MB（类型来自 npm 包本身）。
- 还没有的：打包和安装程序、应用图标、自动更新、退出时对“还有会话在跑”的提示。这些做的时候，面板的位置要通过 `startKernel` 的 `publicDir` 传，不要再靠兄弟目录。

## 模块

| 文件              | 内容                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`     | Electron 主进程：单实例锁、起内核、窗口、菜单、权限、导航限制、IPC、退出收尾。只有它（和 preload）导入 `electron`，所以可以单测的逻辑都放在别的文件里                                  |
| `src/preload.cts` | 沙箱里的预加载脚本，编译成 `dist/preload.cjs`。沙箱里的 preload 不能导入别的文件，只能 `require("electron")`，所以必须是单个 CJS 文件，类型只做 `import type`。只暴露 `window.albireo` |
| `src/kernel.ts`   | 不依赖 Electron：`openStores`（vault、`providers.json`、已保存的会话）、`recentUse`、`startKernel`（会话管理器 + 面板服务）                                                            |
| `src/policy.ts`   | 窗口的规则（纯函数）：哪些地址算面板、哪些链接可以交给系统、给页面什么权限、谁可以用外壳的功能                                                                                         |
| `src/folder.ts`   | `pickFolder`：包一层系统选择器，处理取消和页面给的起始路径                                                                                                                             |
| `src/state.ts`    | 记住端口和窗口位置（`state.json`），读的时候逐项校验，写的时候先写临时文件再改名                                                                                                       |
| `src/args.ts`     | 命令行上的工作区路径                                                                                                                                                                   |
| `src/ipc.ts`      | 页面发给外壳的消息名（preload 里写了同一个字符串，测试检查两处一致）                                                                                                                   |

## 不变量（改动时别破坏）

- **窗口只是一个本地地址的浏览器**：`contextIsolation` 开、`nodeIntegration` 关、`sandbox` 开。页面里没有 Node，只有 `window.albireo`（类型 `DesktopBridge`，在 `@albireo/server/protocol`）。窗口不会离开面板的 origin：`will-navigate`、`will-redirect` 和 `window.open` 都被拦住，只有 `http(s)` 和 `mailto` 链接交给系统打开（`externalLink`），`file:`、`javascript:`、自定义协议一律丢掉；`<webview>` 不允许。模型的输出会显示在页面里，所以不能让页面一点链接就走出去或启动别的程序。
- **页面只能要它需要的权限**：`setPermissionRequestHandler` 和 `setPermissionCheckHandler` 都走 `grantsPermission`，现在只放行写剪贴板（代码块的复制按钮）。新加一个权限要先想它给了页面什么。
- **外壳的功能只给面板自己的页面**：IPC 处理函数检查发送者是我们的窗口、并且发送它的 frame 的地址是面板的 origin（`mayUseShell`）。新增一个 IPC 通道要同时改：`ipc.ts`、`preload.cts`、`@albireo/server/protocol` 里的 `DesktopBridge`、`main.ts` 的处理函数，并保持“页面能做的事，服务端也还会再检查一遍”：选择器只返回一个路径，工作区是否可用仍由 server 的 `checkWorkspace` 判断。
- **和命令行共用同一个 vault 和同一份会话**：`openStores` 用 vault 包的默认目录和默认 `KeyProtector`（`defaultProtector`），会话存在 `defaultSessionsDir()`（server 导出，命令行也用它）。**不要换成 Electron 的 `safeStorage`**：只有 Electron 进程读得出它写的东西，命令行就打不开桌面应用建的 vault 了。凭据同样只来自 vault，不读环境变量。
- **同一个会话文件不能被两个进程同时写**（存储没有跨进程锁），所以只允许一个实例：第二次启动只把第一个窗口带到前面（`requestSingleInstanceLock`）。
- **端口要记住**：面板把偏好（上次看的会话、侧栏开合）放在 `localStorage`，它属于 origin，而 origin 带端口。所以上次的端口记在 `state.json` 里，下次先试它，被占用了才换一个（`startKernel` 处理 `EADDRINUSE`；这一次偏好会丢，但能启动）。绑定地址、Host 检查、token 都和命令行一样，是 server 包的事，这里不放宽。
- **Electron 自己的文件**（缓存、页面的本地存储、`state.json`）放在配置目录下的 `desktop/`，和 vault、`sessions/` 并列但分开；不要用 Electron 默认的 userData（在 Windows 上它和 vault 目录只差大小写，会混在一起）。必须在 `ready` 之前设置。
- **退出要等会话写完**：`before-quit` 里先阻止退出，`kernel.close()`（停服务、`manager.dispose()` 把所有录制写完、锁 vault）之后再 `app.exit`。窗口位置在 `before-quit` 里也要记一次（`rememberWindow`）：快捷键退出、菜单和信号走的是 `before-quit`，它早于窗口自己的 `close` 事件。
- **恢复窗口大小用 `setBounds`，不用构造函数的 `width`/`height`**：保存的是 `getNormalBounds()`，构造函数在 Windows 上对窗口边框的算法不同，用它恢复，窗口每次重启都会大两个像素。位置要先用 `isReachable` 检查还在某块屏幕上（拔掉过显示器的话窗口会跑到看不见的地方）。
- 开发者工具只在未打包时出现在菜单里：页面的地址带着这次运行的 token。

## 测试

`test/*.test.mjs`：`node --test`，导入 `../dist/`，先 `pnpm build`。不启动 Electron：`policy`、`folder`、`args`、`state` 是纯函数；`kernel.test.mjs` 起真实的内核（临时目录、`MemoryKeyProtector`、一个回声 provider），测面板服务、第一个会话、端口回退、“回到上次的地方”、关闭；还检查编译出的 `preload.cjs` 只 `require("electron")` 并且用的消息名和 `ipc.ts` 一致。

真实的窗口没有自动化测试，要手动验证（改了 `main.ts`、preload 或窗口规则之后）：

- 把配置目录移到临时目录（Windows 上设 `APPDATA`），在里面放一个指向本地假模型服务的 `providers.json`（`auth: "none"`，写法见 `packages/cli/test/sessions.test.mjs`），这样不碰真实的 vault 和会话，也不需要真 key。只移 `APPDATA`，别移 `USERPROFILE`：系统的文件夹对话框要用真实的用户目录。
- 启动时加 Chromium 的 `--remote-debugging-port=<n>`，用 Chrome DevTools 协议驱动窗口：检查页面有 `window.albireo` 而没有 `require`/`process`，发一条消息得到回复，`location.href = "file:///…"` 不会离开面板，`window.open` 不开新窗口，剪贴板可写而别的权限被拒，重启后端口、`localStorage` 和窗口大小都在。原生对话框是一个独立的系统窗口（类名 `#32770`，标题是我们给的），可以用 Win32 消息关掉它来测“取消返回 null”。
- 没有自动验证过的：在真实对话框里**选中**一个文件夹后，路径回到页面（`pickFolder` 有单测，IPC 通路用“取消”验证过）。不要用 `SendKeys` 之类的模拟按键去测：按键会发给当前的前台窗口，不一定是对话框。
