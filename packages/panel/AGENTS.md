# @albireo/panel

GUI 面板：Vite + SolidJS，构建成**单个** `dist/index.html`（脚本和样式都内联），由 `@albireo/server` 直接读文件提供。

- 命令：`pnpm --filter @albireo/panel build`（根目录的 `pnpm build` 会先 `tsc -b` 再构建面板）；`pnpm --filter @albireo/panel dev` 是 `vite build --watch`，改完刷新浏览器就能看到。没有 Vite dev server：每个请求都要带 token，而 `<script src>` 带不了请求头，所以才内联成一个文件。
- 类型检查走根 `tsconfig.json` 的 `references`（`emitDeclarationOnly`，产物在 `node_modules/.cache`），和包的构建分开：`tsc -b` 管类型，Vite 管打包。
- 面板以 `import type` 依赖 `@albireo/core`（`KernelEvent`、`Snapshot`）和 `@albireo/vault`（`SecretsStatus`），都收在 `src/protocol.ts`。协议一改，`tsc -b` 在这里就会报错。不要在运行时导入这两个包。
- `solid-js` 停在 1.x：`vite-plugin-solid` 的稳定版还不支持 2.x。升级前先确认插件已支持。
- `index.html` 里的 CSP 把 `connect-src` 限制为同源：模型输出是不可信的，这是兜底。加外部资源（字体、CDN、图片）要先想清楚。

## 结构

| 位置                | 内容                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/state/chat.ts` | **纯函数** `applyEvent(state, event)`：页面状态完全由事件驱动，先 `snapshot` 再逐条事件。没有 Solid 依赖，测试直接跑它 |
| `src/state/`        | `store.ts`（Solid store + `dispatch`）、`connection.ts`（SSE）、`secrets.ts`、`drafts.ts`、`actions.ts`、`ui.ts`       |
| `src/lib/`          | 无 DOM、无 Solid 的纯函数：保险库状态文案、自定义 provider 载荷、Markdown 实体与链接白名单、工具摘要                   |
| `src/components/`   | 组件。`Conversation`、`ToolRun`、`Markdown`、`ApprovalCard`、`Composer`、`TopBar`、`ModelSwitcher`、`KeysDialog` 等    |
| `src/api.ts`        | token（来自页面 URL 的 `?token=`）、`api()`、`postCommand()`。SSE 用查询参数带 token，其余请求用 `x-albireo-token` 头  |
| `src/styles.css`    | 设计令牌和全部样式。蓝色是"在工作"（操作、链接、运行中），金色只表示"需要你介入"（审批、告警）；明暗随系统             |

要新增一种事件的显示：先在 `src/state/chat.ts` 的 `applyEvent` 里加分支（并补测试），再决定组件怎么画。

## 不变量

- **不用 `innerHTML`**。用户输入、模型输出都是文本节点。Markdown 由 `marked` 的 lexer 产出 token，再由 `Markdown.tsx` 直接渲染成元素；原始 HTML 当文本显示，链接只放行 `http(s)` 和 `mailto`（`safeHref`），图片不加载（远程 URL 可能外泄数据）。
- 审批卡固定在输入框上方，不随对话滚走。`Enter` 允许、`Esc` 拒绝；用户正在输入时不抢焦点，输入框、下拉框和对话框里的 `Esc` 不触发拒绝。
- 运行中输入的消息排队，上一轮结束后依次发出（队列只在页面里，不在内核里）。
- `API Keys` 对话框管理加密 vault 与自定义 provider：provider 列表、模型建议和状态全部来自 `GET /secrets`（收到 `snapshot` 或 `secrets_changed` 时重新拉取）。页面上只有掩码提示；新增自定义 provider 时先 `POST /providers` 存配置，再用 `POST /secrets/provider` 存可选的初始密钥，密钥失败时 provider 照样留着，不回滚。删除走 `DELETE /providers/:id`。
  - `needsUnlock` 为 true（口令 vault 锁定）时新增和删除都禁用；vault 打不开（`error`）时只禁用新增；服务端也会拒绝。
  - provider 带 `problem`（比如 baseURL 过不了检查）时徽标显示不可用，当前 provider 有问题时顶栏的 API Keys 按钮也提醒。
  - Base URL 和 Model 的未保存编辑记在 `drafts.ts`，只提交改过的字段：单独存 key、清除 key 或只改其中一个字段，都不会重发另一个（包括可能被掩码的 Base URL），也不会丢掉没保存的编辑；关掉对话框编辑还在。所有密钥输入框在保存或关闭对话框后清空。
- Biome 也检查 TSX、CSS 和 HTML（含 a11y 规则）。抑制规则要写理由。

## 测试

`test/*.test.ts`：`node --test`，直接运行 TypeScript（Node 的类型剥离，需要 22.18 或更新；所以只能用可擦除语法，相对导入写 `.ts` 后缀）。只测 `state/chat.ts` 和 `lib/` 里的纯函数，不依赖 DOM，也不需要先 build。组件靠在浏览器里手动验证：`pnpm build` 后启动 `albireo`，或用 `ScriptedProvider` 起一个服务看界面。

## 计划

多会话、工作区选择、Changes/Files 侧栏、设置页、Electron 外壳都还没做；布局按这些预留（顶栏、主列、底部 dock）。
