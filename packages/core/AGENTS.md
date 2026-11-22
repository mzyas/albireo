# @albireo/core

无头内核。不依赖任何界面，也不依赖其他 workspace 包。公开 API 全部从 `src/index.ts` 导出：新增导出要在那里加上。

## 模块

| 文件                   | 内容                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/types.ts`         | 中立模型：`Message`、`ContentPart`、`Provider`、`WireApi`、`ProviderAuthMode`、`ProviderHeaders`、`TurnRequest`/`TurnResult`、`StopReason`、`Usage`、`MessageMeta` |
| `src/session.ts`       | `Session`：Agent 循环、工具执行、审批、事件流（`KernelEvent`）、`snapshot()`                                                                                       |
| `src/history.ts`       | `normalizeHistory`（纯函数）、`replaysNatively`                                                                                                                    |
| `src/instructions.ts`  | `loadInstructions`（读工作区根目录的指令文件）、`withInstructions`（拼进系统提示）、`InstructionInfo`（给界面看的只有名字和大小）                                  |
| `src/replay.ts`        | `eventsFromHistory`（纯函数）：从历史重建事件，恢复的会话靠它填 `snapshot()`                                                                                       |
| `src/tool.ts`          | `Tool`、`Risk`、`defineTool`、`toSpec`（zod → JSON Schema）                                                                                                        |
| `src/tools/builtin.ts` | 内置工具（清单以文件末尾的 `builtinTools` 为准）和 `resolveInside`（路径限制在工作区内）                                                                           |
| `src/tools/edit.ts`    | `applyEdit`：`edit_file` 的替换逻辑（纯函数）                                                                                                                      |
| `src/tools/search.ts`  | `grep` 的搜索：`searchFiles`（在 worker 线程里执行）、`runSearch`（启动 worker，带超时和中止）；`search-worker.ts` 是线程入口                                      |
| `src/tools/glob.ts`    | 小型 glob → `RegExp`，给 `grep` 的 `include` 用                                                                                                                    |
| `src/providers/`       | `anthropic.ts`（`anthropic-messages`）、`openai.ts`（`openai-completions`）、`scripted.ts`（测试用）、`index.ts`（`ProviderRegistry`、`defaultRegistry`）          |

各适配器按线协议复用：接收自定义 `id`、`auth`（`api-key | bearer | none`）、`headers`、`compat`（`AnthropicCompat` / `OpenAICompletionsCompat`）与模型级覆写（`modelOverrides`），同时导出默认模型和默认 `baseURL` 常量（`*_DEFAULT_MODEL`、`*_DEFAULT_BASE_URL`），vault 用它们显式构造客户端。`defaultRegistry` 从环境变量读配置，只给 `test-live` 用；CLI 的 registry 来自 `@albireo/vault`。

## 不变量（改动时别破坏）

- **历史是中立的**。`Session.history` 只存 `types.ts` 里的类型；厂商格式只在适配器内部出现，换厂商时历史原样带过去。
- **原生回放**：适配器可以把原生内容放进 `Message.native`。只有 provider（含自定义 `id`）、model 和 wire API 三者都相同时才用它回放（见 `replaysNatively`），否则从 `content` 重建。Anthropic 的 thinking 块必须原样回传，这就是为什么要存原生内容。
- **发请求前必须先 `normalizeHistory`**。每个适配器在转换成厂商格式前都要调用它，并传入自己的 `HistoryTarget` 和工具调用 ID 长度上限。它负责改写 ID、补齐缺失的工具结果、丢掉孤立结果和空文本。新适配器同样要调用它。
- **每次调用工具都要先过一遍检查**：先用 zod 校验入参，失败时作为错误结果回给模型、不执行；再看 `risk` 在不在 `autoApprove` 里，不在就发 `approval_request` 等待。任何新的执行路径都不能绕过这两步。
- **工具不能越出工作区**：涉及路径的工具必须通过 `resolveInside(cwd, p)`。遍历目录的工具（`grep`）不跟随符号链接，因为链接可以指到工作区外。
- **模型给的正则不能在主线程里跑**：灾难性回溯会让整个内核（包括事件流）卡死。`grep` 在 worker 线程里执行，有超时，也响应用户中止。任何执行模型提供的正则、或计算量不可控的新工具，都要这样隔离。`search-worker.js` 由 `tsc` 一并编译到 `dist/tools/`，`runSearch` 用 `import.meta.url` 找它，别把它挪走或打成单文件。
- **`edit_file` 不能改到不是模型想改的地方**：`old_string` 必须唯一（除非 `replace_all`），找不到或有歧义就报错并附上行号；CRLF 文件保持 CRLF；不是干净 UTF-8 的文件（二进制、其他编码）一律拒绝，写回会损坏它们。
- **子进程拿不到 LLM 凭据**：`run_command` 用 `commandEnv()` 剥掉已知的 API key 环境变量（名字大小写不敏感）。新的子进程工具也要这样做。
- **换凭据不打断对话**：`refreshProvider()` 从 registry 重新取当前 provider，只能在两轮之间调用；显式指定过的模型保持不变。
- **事件**：`text_delta`/`reasoning_delta` 只是临时的，不记日志；其余事件都进日志，供后连上的客户端通过 `snapshot()` 回放。新增事件类型时要同时考虑 server 和 panel 怎么处理。
- `Session` 在 `assistant_end` 之后给助手消息补上 `meta`；适配器不用自己填。
- **重试不改历史**：`Session.retry()` 只在历史以用户消息结尾时可用（上一轮出错、被中止或被拒绝，见 `canRetry`），它原样重跑，不追加任何消息。`canRetry` 随 `snapshot()` 和每个 `status: idle` 事件发出，界面据此显示“重试”。已经答完的轮次不能“重来”：那需要回退历史，不在这里做。
- **指令文件是工作区里的不可信文本**：`loadInstructions` 只读根目录的 `AGENTS.md`，不跟随符号链接（文本会发给模型厂商，链接不能把工作区外的文件带进去），超过上限就截断并标记。全文只进系统提示；`snapshot()` 只给名字、大小和是否被截断。它们进系统提示时声明了“不覆盖用户请求和审批规则”，但审批规则本身才是防线：任何指令都不能让工具绕过审批。
- **历史只增不改，而且只经过 `commit`**。一轮里消息进入 `history` 的唯一入口是 `Session` 的私有 `commit`，它同时通知 `onMessage` 的监听者（存储靠它落盘，不要让存储去读 `history`）。新增往 `history` 里写消息的路径时，必须走 `commit`，否则不会被保存。监听者抛异常会被吞掉：存不了盘不能打断对话。
- **恢复的会话**：`SessionOptions.history` 里的消息成为 `history`，不会再通知 `onMessage`；`snapshot()` 里的事件由 `eventsFromHistory` 重建，所以流式增量、通知、错误、审批请求不会回来，没有收到结果的工具调用会补一个错误结果，免得界面一直显示"运行中"。事件的 `seq` 接着重建出来的往下编。内核不知道存储的存在。

## 加一个线协议适配器

新增兼容现有线协议（`anthropic-messages` / `openai-completions`）的端点不需要改 `@albireo/core`，直接在 `providers.json` 或面板中声明即可。只有新增全新的线协议时才需要加适配器：

1. 在 `src/providers/` 新建适配器，实现 `Provider.runTurn`：流式输出 `StreamEvent`，最后返回中立的 `TurnResult`，并支持自定义 `id`、`auth`、`headers`、`compat`。
2. 在 `types.ts` 扩展 `WireApi` 并定义 wire API 常量（参照 `ANTHROPIC_MESSAGES_API` / `OPENAI_COMPLETIONS_API`），写进 `native.api`。
3. 导出纯函数 `toXxxMessages(...)` 和参数构造辅助函数，方便单测。
4. 在 `providers/index.ts` 里导出，并视需要在 `defaultRegistry` 里注册（工厂函数会延迟构造，所以缺某家的密钥不影响另一家）。

## 测试

- `test/*.test.mjs`：`node --test`，导入 `../dist/index.js`，所以要先 `pnpm build`。用 `ScriptedProvider` 把模型输出脚本化，不会访问网络。
- `test-live/live-check.mjs`：真实 API 冒烟检查，没有密钥的厂商会跳过。命令是 `pnpm build && pnpm --filter @albireo/core test:live`，不进 CI。
