# @albireo/server

`src/index.ts` 导出 `startPanelServer(source, opts)`，把运行中的会话暴露给 GUI 面板：`source` 是 `SessionManager`（多个会话），或者一个 `Session`（当作唯一的会话，用 `SessionManager.single` 包起来）。`src/manager.ts` 是 `SessionManager`。`src/workspace.ts` 是工作区的只读视图（git 变更、diff、文件列表、预览）；`src/protocol.ts` 只放这些路由的响应类型（无任何导入），经 `@albireo/server/protocol` 子路径导出给面板做类型导入。

## 协议

- `GET /`：返回面板构建出的单文件 `index.html`（默认来自同级的 `packages/panel/dist/`，可以用 `opts.publicDir` 覆盖）。还没构建时返回 503 和提示，不暴露本地路径。**没有静态资源路由**：面板把脚本和样式都内联进这一个文件，这样每个请求都只需要过同一套 token 检查（`<script src>` 带不了请求头）。
- `GET /events?session=<id>`：SSE。先发一条 `{ type: "snapshot", ... }`，之后转发该 `Session` 的每个事件。订阅和取快照在同一个 tick 里完成，所以事件不会漏也不会重复。不带 `session` 就是第一个会话；会话不存在（没打开、已删除）返回 404。会话被删除时它的流会被结束。
- `POST /command`：JSON body，`type` 取 `send | approve | abort | retry | switch`，可带 `session`（缺省是第一个会话，不存在返回 404），成功时返回 202。可用命令以源码里的 `switch` 为准。
- `GET /sessions`（列表：运行中的和磁盘上保存的，加上用过的工作区）、`POST /sessions`（起一个新会话，body 可空）、`POST /sessions/:id/open`（把保存的会话恢复进内存）、`DELETE /sessions/:id`（中止并删掉）。字段以 `src/protocol.ts` 为准；错误是 `{ error, code }`（`invalid` 400、`not_found` 404、`unsupported` 409）。只有一个固定会话（传入 `Session`）时后三个返回 409。
- 会话列表和 vault 一样不是 `Session` 事件：列表变化（增删、开始或结束一轮、审批请求出现或被回答、收到消息、切换模型）时 server 向**所有** SSE 连接推 `{ type: "sessions_changed" }`，面板收到后重新 `GET /sessions`；管理器把一阵连续的变化合并成一次通知。
- `GET /workspace/{changes,diff,files,file}`：面板右侧栏用的**只读**路由，都可带 `session` 参数，以那个会话的工作区为根（每个目录一个 `Workspace`）。参数和响应字段以 `src/protocol.ts` 为准；错误是 `{ error, code }`（路径越界 400、不存在 404），消息里不回显路径，也不透出 git 的输出，其余失败一律 `internal error`。其他方法打到 `/workspace/*` 都是 404。
- `/secrets`（`GET`）、`/secrets/{unlock,provider,lock}`（`POST`）以及 `/providers`（`POST`）、`/providers/:id`（`DELETE`）：管理加密 vault 与 `providers.json` 自定义 provider，全部交给 `opts.secrets`（`@albireo/vault` 的 `SecretManager`）处理；没传时 `GET /secrets` 返回 `{ enabled: false }`。请求和响应的字段以 `SecretManager` 的类型为准，错误码映射见 `VAULT_STATUS`。
- vault 或 provider 定义变化不是 Session 事件：server 会向所有 SSE 连接推一条 `{ type: "secrets_changed" }`，面板收到后重新 `GET /secrets`。`GET /secrets` 也会先调用 `SecretManager.reloadProviderConfig()`，因此外部进程修改 `providers.json` 后，下次面板刷新即可看到（只有内容真的变化时才广播，不会自激循环）。重载失败不影响返回状态。`POST /providers` 不收 key（带 `apiKey` 会被拒绝），key 只走 `POST /secrets/provider`。

## 安全（这是硬性要求，不是可选项）

Agent 能执行任意命令，所以这个服务必须锁死：

- 只绑定 `127.0.0.1`。
- 校验 `Host` 头，只接受回环地址加实际端口，防 DNS rebinding。
- 每次启动生成随机 token。所有请求都要带上，可以放在 `?token=` 或 `x-albireo-token` 头里，用常量时间比较。
- body 有大小上限。

新增路由时，它必须经过同一套检查（检查写在 handler 开头，别在它前面插路由）。要做远程访问是另一件事，需要单独设计，不要放宽现有检查。

会话路由和 `SessionManager` 额外要求：

- **工作区来自请求，所以要检查**：`checkWorkspace` 要求绝对路径、存在、是目录、不是文件系统根（驱动器根）；错误消息不引用路径。能把 Agent 指向用户能访问的任何文件夹，这是 token 和回环检查在把关，管理器本身不限制。**面板没有目录浏览接口**（只能选用过的或输入路径）：Web 页面不该拿到文件系统，原生选择器等 Electron 外壳再做，不要为此放宽接口。
- 会话 id 来自 URL，要走存储的 `assertValidId`（路径分隔符、设备名等）；`open` 对同一个 id 并发只恢复一次（否则两个录制器写同一个文件）；`delete` 先中止并等这一轮结束、停录制、等写完，再删文件。
- 恢复的会话回到自己的工作区，那个目录没了就报错；命令行可以用 `open(id, overrides)` 覆盖工作区、provider 和 model，HTTP 不开放这个。
- 新建会话用的 provider 必须已注册；错误只返回管理器自己写的消息，其余一律 `internal error`。

`/workspace/*` 路由额外要求（它们会在用户刚打开的、不一定可信的仓库里跑 git）：

- 每次 git 调用都带 `GIT_SAFETY` 里的选项：`core.fsmonitor=false`（否则仓库配置能让 `git status` 执行任意程序，测试里有对照组证明它真的会）、`--no-optional-locks`（不抢索引锁，不妨碍 Agent 同时跑的 git）、`--literal-pathspecs`（路径不被当成 pathspec 语法）；diff 另加 `--no-ext-diff --no-textconv`。只用 `execFile`，不经 shell；环境用 core 的 `commandEnv()`，不把 LLM 凭据交给 git。新增 git 调用必须沿用，不要自己拼参数。
- 路径先过 `resolveInside`；预览额外用 `realpath` 确认符号链接没有把文件指到工作区外，并且不展示 `.git/` 里的东西。输出有大小上限并标注 `truncated`。
- 只读：这些路由不写文件、不改索引。

`/secrets` 与 `/providers` 路由额外要求：响应一律 `cache-control: no-store`；任何响应和 SSE 事件里都不能出现明文 key；错误只返回 `VaultError` 的消息（JSON 解析错误也不回显，因为 V8 的消息会引用 body）。

## 测试

`test/*.test.mjs`：`node --test`，起真实服务。`secrets.test.mjs` 用 `MemoryKeyProtector` 的临时 vault，覆盖 token / Host 校验和 `/secrets` 不泄漏明文；`panel.test.mjs` 覆盖 `GET /` 的鉴权、单文件服务和未构建时的 503；`workspace.test.mjs` 在临时 git 仓库里测变更、diff（含无提交的仓库、子目录工作区）、文件列表、预览和路径越界，需要本机有 git（没有就跳过）；`sessions.test.mjs` 测管理器（新建、保存、恢复、并发打开、同时运行、删除、通知）和 `/sessions` 路由、按会话分流的事件与命令。改协议时，同步修改 `packages/panel/src/protocol.ts` 和用到它的组件（面板以类型导入依赖 core 和 vault，类型对不上时 `pnpm build` 会报错）。
