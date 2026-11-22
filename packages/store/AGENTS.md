# @albireo/store

会话持久化：把对话存到磁盘，下次接着聊。只依赖 `@albireo/core`（类型和 `Session`），只用 Node 内置模块。公开 API 从 `src/index.ts` 导出。

## 模块

| 文件               | 内容                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/store.ts`     | `SessionStore`：`load`、`list`、`latest`、`delete`，以及创建录制器的 `record`（新会话）和 `resume`（接着已有的会话） |
| `src/recording.ts` | `Recording`：订阅一个 `Session`，消息一提交就追加写盘；写入排队、按序执行，`flush()` 等它们写完                      |
| `src/format.ts`    | 文件格式（版本、记录类型）、id 规则、读盘时对消息的校验、标题生成、`StoreError`                                      |
| `src/files.ts`     | 私有目录和原子写入的小工具                                                                                           |

## 磁盘上的样子

每个会话两个文件，在 CLI 传入的目录里（CLI 用用户配置目录下的 `sessions/`，永远不在工作区里）：

- `<id>.jsonl`：**真相**。只追加。第一行是头（id、创建时间、工作区），之后每行一条消息。字段以 `format.ts` 为准。
- `<id>.json`：缓存（标题、provider、model、消息数、更新时间），让 `list` 不用读完整对话。丢了或坏了会从 `.jsonl` 重建，所以不是不变量的一部分。

## 不变量（改动时别破坏）

- **历史只增不改**。`Session.history` 只会追加，所以存储也只追加；录制器只靠 `Session.onMessage` 听消息，不要读 `history` 去"同步"。以后要做压缩，需要在格式里加一种"替换"记录并升 `FORMAT_VERSION`，而不是改写旧行。
- **没有消息就不建文件**。启动后直接退出不会留下空会话。
- **写盘失败不能打断对话**。`Recording` 只通过 `onError` 报告，继续接受之后的消息；`Session` 本身也会吞掉监听器抛出的异常。
- **id 会变成文件名，而且来自命令行**：`isValidId` 拒绝路径分隔符、前导点和结尾点（Windows 会吞掉）、以及 Windows 设备名（`CON.jsonl` 会打开控制台）。任何接受 id 的入口都要先过 `assertValidId`，而且要在 `try` 之前，否则会被当成"读不了"吞掉。
- **从磁盘读回的东西不可信**：每条消息都用 `isMessage` 校验结构再交给模型 provider；坏行跳过并计数（`skipped`），不是整个会话失败。头不对（缺失、id 与文件名不符）才算损坏，版本比当前新就报 `unsupported`。`StoreError` 的消息不引用文件内容。
- **接着写之前先补换行**：被崩溃截断的最后一行没有换行，`resume` 的第一次追加会先补上，否则新消息会接在残缺行后面丢掉。
- **会话含源码和命令输出**：目录 `0700`、文件 `0600`（POSIX），放在用户配置目录而不是工作区。
- 没有跨进程锁：两个进程同时往同一个会话写会交错。CLI 每次启动只写自己那一个。

## 恢复的流程

`store.load(id)` → `new Session({ history: loaded.messages, … })`（内核从历史重建 `snapshot()` 的事件，见 core 的 `eventsFromHistory`）→ `store.resume(session, loaded.meta)`。provider 和 model 的选择由调用方（CLI）决定。

## 测试

`test/*.test.mjs`：`node --test`，导入 `../dist/`，先 `pnpm build`。用 `ScriptedProvider` 和 `mkdtemp` 临时目录，不碰用户目录。覆盖往返一致、续写、崩溃截断、损坏文件、id 校验、列表和缓存重建、写盘失败。
