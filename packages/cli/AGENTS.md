# @albireo/cli

入口是 `src/cli.ts`，编译为 `dist/cli.js`，bin 名是 `albireo` 和 `albi`（见 `package.json`）。`src/keys.ts` 是 `albireo keys` 子命令，`src/sessions.ts` 是 `albireo sessions` 子命令和"选哪个会话来恢复"的逻辑，`src/tty.ts` 是终端输入（不回显的提示、读取管道 stdin）。

- 参数用 `node:util` 的 `parseArgs` 解析。**参数列表以 `HELP` / `KEYS_HELP` 常量和对应的 `parseArgs` options 为准**，两处要一起改。
- 三种用法：
  - 服务模式（不带 `--prompt`）：启动 Session 和面板服务，打印面板地址，一直运行到 SIGINT/SIGTERM。
  - 无头模式（`--prompt`）：把输出流式写到 stdout，自动拒绝所有需要审批的调用，跑完退出。
  - `albireo keys …`：第一个参数是 `keys` 时，在解析主参数之前分流到 `runKeysCommand`，不启动 Session。不开面板也能查看、设置、清除 vault 里的凭据，例如只能 SSH 登录、没有浏览器的机器。
- `--yolo` 把 `autoApprove` 扩大到全部风险等级；默认只放行 `read`。
- **会话默认保存**（`@albireo/store`），存在用户配置目录下的 `sessions/`（`defaultSessionsDir()`，永远不在工作区里）。参数以 `HELP` 为准。
  - 启动时先决定恢复哪个会话（`chooseSession`），再决定 provider：显式的 `--provider` 优先，否则回到会话用过的 provider（它已经不存在就提示并用默认的）。model 只在和默认值不同时才带回来，这样不会把模型"钉死"，之后改 vault 里的 model 覆写仍然生效。
  - `--resume <id>` 找不到或 id 不合法是错误（退出码 1）；`--continue` 没有可接的会话就提示一句并开新会话。两者同时给是用法错误（退出码 2）。
  - 恢复的会话和当前 `--cwd` 不是同一个目录时只提示，不替用户换目录。
  - `--no-save` 不录制，但仍可以接着一个已保存的会话聊，且不改动它。
  - 退出前（无头模式跑完、服务模式收到 SIGINT/SIGTERM）必须 `await recording.flush()`，否则最后几条消息可能还没写完。写盘失败只提示一次，对话继续。
  - 子命令 `albireo sessions` 和 `keys` 一样，在解析主参数之前分流。
- Provider 来自 `@albireo/vault` 的 `createVaultRegistry()`，凭据存在加密 vault，非敏感端点定义存在同目录的 `providers.json`（`ProviderConfigStore.open()`），**不读环境变量**。启动时同时打开两者，再把 `SecretManager` 交给面板服务。
  - `--provider` 指定的 provider 不存在（或被 `providers.json` 校验拒绝）时，服务模式与无头模式都在报错中附带 `config.error`。
  - 服务模式：vault 为空、锁定、缺 key 或 `providers.json` 损坏都照常启动，打印状态，让用户在面板里配置。
  - 无头模式：所选 provider 为 `auth: "none"` 时不要求 vault 解锁或存 key；其余情况在口令模式下于 TTY 提示输入口令（不回显），非 TTY 或缺 key 时直接 `fail()`。能不能用以 vault 的 `providerProblem` 为准（和 registry 是同一套判断，baseURL 过不了检查也算），不能用时打印它给的原因。
- `albireo keys` 的约束：
  - 支持内置与 `providers.json` 中的全部自定义 provider；状态输出按 provider ID 动态对齐，对 `auth: "none"` 显示 `no key needed`，当 provider 存在 `problem`（例如 baseURL 过不了检查）时 `status` 与 `set` 会附带 `unusable: …` 说明。指定不存在的 provider 时若 `providers.json` 有错误，也会在报错中附带 `config.error`。
  - **API key 不从命令行参数读取**：TTY 上不回显提示，否则从管道 stdin 读。多出的位置参数直接报用法错误，错误信息里不回显这个参数（多半是误贴的 key）。
  - 写入走 `SecretManager`，校验和状态视图与面板一致。输出只有 `maskApiKey` 的提示。
  - 口令只能在 TTY 上输入；非 TTY 时在读取 stdin 之前就失败。
  - 已经在运行的内核要重启才会用上这里的改动（vault 的写入会合并磁盘上的最新内容，所以面板之后的保存不会覆盖掉它）。
  - 所有终端交互都经过 `KeysIO` 接口注入，测试用假的 `KeysIO` 和临时目录驱动。
- 出错时调用 `fail()`：写 stderr 并以非零码退出。参数错误用退出码 2，在提示里取消用 130。

## 测试

`test/*.test.mjs`：`node --test`，导入 `../dist/`，先 `pnpm build`。`sessions.test.mjs` 里有一个端到端测试：把配置目录挪进临时目录，对一个本地的 OpenAI 兼容假服务器真正跑 `dist/cli.js`（`--prompt`、`--continue`、`--resume`、`--no-save`），检查模型收到了之前的对话。用 `MemoryKeyProtector` 或 `protector: null`，加上 `mkdtemp` 临时目录，不碰真实的用户目录和系统凭据库。真实 TTY 下的不回显提示没有自动化测试。
