# @albireo/panel

GUI 面板：Vite + SolidJS，构建成**单个** `dist/index.html`（脚本和样式都内联），由 `@albireo/server` 直接读文件提供。

- 命令：`pnpm --filter @albireo/panel build`（根目录的 `pnpm build` 会先 `tsc -b` 再构建面板）；`pnpm --filter @albireo/panel dev` 是 `vite build --watch`，改完刷新浏览器就能看到。没有 Vite dev server：每个请求都要带 token，而 `<script src>` 带不了请求头，所以才内联成一个文件。
- 类型检查走根 `tsconfig.json` 的 `references`（`emitDeclarationOnly`，产物在 `node_modules/.cache`），和包的构建分开：`tsc -b` 管类型，Vite 管打包。
- 面板以 `import type` 依赖 `@albireo/core`（`KernelEvent`、`Snapshot`）、`@albireo/vault`（`SecretsStatus`）和 `@albireo/server/protocol`（工作区路由的响应类型），都收在 `src/protocol.ts`。协议一改，`tsc -b` 在这里就会报错。不要在运行时导入这些包。
- `solid-js` 停在 1.x：`vite-plugin-solid` 的稳定版还不支持 2.x。升级前先确认插件已支持。
- `index.html` 里的 CSP 把 `connect-src` 限制为同源：模型输出是不可信的，这是兜底。加外部资源（字体、CDN、图片）要先想清楚。

## 结构

| 位置                | 内容                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/state/chat.ts` | **纯函数** `applyEvent(state, event)`：页面状态完全由事件驱动，先 `snapshot` 再逐条事件。没有 Solid 依赖，测试直接跑它                                                                                                                                                                 |
| `src/state/`        | `sessions.ts`（会话列表和当前会话）、`composerMemory.ts`（每个会话各自的草稿和队列）、`store.ts`（Solid store + `dispatch`）、`connection.ts`（SSE）、`secrets.ts`、`drafts.ts`、`actions.ts`、`ui.ts`、`workspace.ts`（侧栏数据，读 `/workspace/*`）、`commands.ts`（斜杠命令的执行） |
| `src/lib/`          | 无 DOM、无 Solid 的纯函数：保险库状态文案、自定义 provider 载荷、Markdown 实体与链接白名单、工具摘要、`diff.ts`（统一 diff 解析）、`composer.ts`（`@`/`/` 触发与补全）、`commands.ts`（命令表与解析）、`workspace.ts`                                                                  |
| `src/components/`   | 组件。`Conversation`、`ToolRun`、`Markdown`、`ApprovalCard`、`Composer`、`TopBar`、`ModelSwitcher`、`KeysDialog`；右侧栏是 `SidePane`（`ChangesTab`、`FilesTab`、`ContextTab`、`DiffView`）                                                                                            |
| `src/desktop.ts`    | 桌面应用注入的 `window.albireo`（没有就是 `undefined`）                                                                                                                                                                                                                                |
| `src/api.ts`        | token（来自页面 URL 的 `?token=`）、`api()`、`postCommand()`。SSE 用查询参数带 token，其余请求用 `x-albireo-token` 头                                                                                                                                                                  |
| `src/styles.css`    | 设计令牌和全部样式。蓝色是"在工作"（操作、链接、运行中），金色只表示"需要你介入"（审批、告警）；明暗随系统                                                                                                                                                                             |

要新增一种事件的显示：先在 `src/state/chat.ts` 的 `applyEvent` 里加分支（并补测试），再决定组件怎么画。

## 不变量

- **不用 `innerHTML`**。用户输入、模型输出都是文本节点。Markdown 由 `marked` 的 lexer 产出 token，再由 `Markdown.tsx` 直接渲染成元素；原始 HTML 当文本显示，链接只放行 `http(s)` 和 `mailto`（`safeHref`），图片不加载（远程 URL 可能外泄数据）。
- 审批卡固定在输入框上方，不随对话滚走。`Enter` 允许、`Esc` 拒绝；用户正在输入时不抢焦点，输入框、下拉框和对话框里的 `Esc` 不触发拒绝。
- 运行中输入的消息排队，上一轮结束后依次发出（队列只在页面里，不在内核里）。队列和没发出的草稿**按会话各存各的**（`composerMemory.ts`）：切换会话不能把半条消息或排队的消息带进另一个对话；排队的消息只有在它的会话被显示、已收到快照且空闲时才发出。
- **页面一次只显示一个会话**：`state/sessions.ts` 的 `activeId` 变化时，`index.tsx` 里的 effect 关掉旧的事件流、清空聊天和工作区状态、为新会话开流（`connect(id)`）；命令和 `/workspace/*` 请求通过 `api.ts` 的 `setApiSession`/`forSession` 带上 `session`。收到 `sessions_changed`（或流被服务端拒绝重连）就重新 `GET /sessions`，并保证显示的会话存在：还在就保持，否则回到上次看的、服务端的默认、最新的，一个都没有就起一个。保存的会话先 `POST /sessions/:id/open` 再显示。
- **会话列表是 store，不是 signal**：每次变化都会重新拉取，用 `reconcile`（按 `id`）保持未变的会话是同一个对象，侧栏的分组按工作区 key（字符串）而不是对象来跟踪；否则每次刷新都会重建所有行，行内“确认删除”的状态、焦点都会丢。
- **新建会话**：对话框里选用过的工作区或输入绝对路径，服务端检查；新会话用当前的 provider（模型用它的默认值）。在桌面应用的窗口里多一个“Browse…”按钮，调用 `window.albireo.pickDirectory`（`src/desktop.ts` 按形状检查它在不在，普通浏览器里没有就不显示按钮）；选出来的路径只是填进输入框，不会直接开会话。有会话在等审批时标签页标题会变成 “(n) … needs your answer”。窄屏（≤900px）上侧栏和右侧栏都盖在对话上，同时只开一个。
- `API Keys` 对话框管理加密 vault 与自定义 provider：provider 列表、模型建议和状态全部来自 `GET /secrets`（收到 `snapshot` 或 `secrets_changed` 时重新拉取）。页面上只有掩码提示；新增自定义 provider 时先 `POST /providers` 存配置，再用 `POST /secrets/provider` 存可选的初始密钥，密钥失败时 provider 照样留着，不回滚。删除走 `DELETE /providers/:id`。
  - `needsUnlock` 为 true（口令 vault 锁定）时新增和删除都禁用；vault 打不开（`error`）时只禁用新增；服务端也会拒绝。
  - provider 带 `problem`（比如 baseURL 过不了检查）时徽标显示不可用，当前 provider 有问题时顶栏的 API Keys 按钮也提醒。
  - Base URL 和 Model 的未保存编辑记在 `drafts.ts`，只提交改过的字段：单独存 key、清除 key 或只改其中一个字段，都不会重发另一个（包括可能被掩码的 Base URL），也不会丢掉没保存的编辑；关掉对话框编辑还在。所有密钥输入框在保存或关闭对话框后清空。
- **右侧栏只读**：Changes / Files / Context 只显示，不改工作区。数据来自 `GET /workspace/*`（`state/workspace.ts`），晚到的旧响应会被丢弃；一轮结束、写/执行类工具出结果、收到 `snapshot` 时刷新变更列表，不监听文件系统。diff 和文件预览都是文本节点（同样不用 `innerHTML`）。侧栏的开合记在 `localStorage`（读写都包了 try/catch），没有记录时按窗口宽度决定；窄屏上它盖在对话上。
- **`@` 和 `/` 只在输入框里处理**：`@文件` 补全后留在消息里原样发出，模型自己用 `read_file` 去读（不附带内容、不改协议）；带空格的路径补全时加引号。`/命令` 在面板里执行，不发给模型；**只有表里的命令才算命令**，`/usr/bin/x 找不到` 这类消息照常发送。菜单打开时 `Enter` 补全，已经完整输入的 `@文件` 或命令则直接发送/执行。`/clear` 和 `/compact` 还没做：它们要改历史，得等多会话和存储的“替换”记录。
- **重试和编辑**：“重试”按钮只在内核说 `canRetry` 时出现（`status: idle` 事件和快照都带这个字段），原样重跑上一轮，不产生新的用户消息。“编辑”只出现在最后一条用户消息上，把文字放回输入框；发送会追加一条**新**消息，之前那一轮留在历史里（内核不回退历史）。
- Biome 也检查 TSX、CSS 和 HTML（含 a11y 规则）。抑制规则要写理由。

## 测试

`test/*.test.ts`：`node --test`，直接运行 TypeScript（Node 的类型剥离，需要 22.18 或更新；所以只能用可擦除语法，相对导入写 `.ts` 后缀）。只测 `state/chat.ts` 和 `lib/` 里的纯函数，不依赖 DOM，也不需要先 build。组件靠在浏览器里手动验证：`pnpm build` 后启动 `albireo`，或用 `ScriptedProvider` 起一个服务看界面。

## 计划

设置页还没做；布局按这些预留（左侧会话栏、顶栏、主列、底部 dock、右侧栏）。Electron 外壳在 `packages/desktop`：它给页面注入 `window.albireo`（`DesktopBridge`），目前只有原生文件夹选择器。Context 页现在只显示 token 用量，没有“占上下文百分之几”：那需要每个模型的上下文窗口大小，目前没有数据来源。
