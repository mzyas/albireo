# @albireo/vault

本地加密凭据库。CLI 和 server 的 API 凭据**只**从这里来，不读环境变量。依赖 `@albireo/core`（构建 Provider），只用 Node 内置模块，没有第三方运行时依赖。公开 API 从 `src/index.ts` 导出。

## 模块

| 文件                 | 内容                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/credentials.ts` | baseURL query 的白名单（只收版本参数）、像凭据的 header 名的识别规则、baseURL 显示掩码；`providers.json` 和 vault 共用         |
| `src/crypto.ts`      | 信封格式（`VaultEnvelope`）、AES-256-GCM `seal`/`unseal`、HKDF / scrypt 派生、`parseEnvelope` 严格校验                         |
| `src/protector.ts`   | `KeyProtector` 接口与实现：Windows DPAPI、macOS Keychain、Linux Secret Service、`MemoryKeyProtector`（测试）                   |
| `src/store.ts`       | `VaultStore`：状态机（uninitialized / locked / unlocked）、串行化写入、provider ID（内置 + 自定义）与凭据输入校验              |
| `src/providers.ts`   | `ProviderConfigStore`：读取、严格校验并原子写入同目录下的 `providers.json`（非敏感端点、线协议、认证模式、`compat`、模型清单） |
| `src/registry.ts`    | `createVaultRegistry` / `registerVaultProviders`、`isProviderReady`、`UnconfiguredProvider`、`maskApiKey`、`redactError`       |
| `src/manager.ts`     | `SecretManager`：把 vault、`ProviderConfigStore`、`ProviderRegistry` 和 `Session` 绑在一起，供 server 路由调用                 |
| `src/fs.ts`          | 默认目录（`defaultVaultDir`，按平台取用户级配置目录）、私有目录与原子写入                                                      |

## 两种保护模式

- **os-keychain**：随机主密钥交给系统凭据库保管，vault 密钥由它经 HKDF 派生。打开时自动解锁。
- **passphrase**：没有可用的系统凭据库时使用（`SecretManager.unlock` 在 uninitialized 状态下也会显式创建这种 vault）；scrypt 派生，启动后处于 locked，需在面板解锁（无头模式在 TTY 上提示输入）。

模式写在文件头 `kdf.mode` 里，参数以 `crypto.ts` 的常量为准。

## 不变量（改动时别破坏）

- **绝不碰 `process.env` 里的凭据**。需要凭据的 provider（`auth: "api-key" | "bearer"`）没有 key 时注册 `UnconfiguredProvider`，不构造 SDK 客户端（SDK 会自己去读环境变量）；免鉴权本地端点（`auth: "none"`）直接可用且通过无害占位 + 屏蔽认证头防止 SDK 回退环境变量。`baseURL` 总是显式传入。
- **非敏感配置与凭据分离**：`providers.json` 与 `vault.enc.json` 同目录（永不进工作区），严禁出现 `apiKey` / `authToken`。URL query 只允许版本类参数，`anthropic-messages` 的 baseURL 不能带 query（Anthropic SDK 会把请求路径拼在 query 后面）。header 名看起来像凭据（key、token、密码、签名、cookie 一类）就拒绝，其余元数据头照收，因为网关各有自己的头，白名单跟不上；规则都在 `credentials.ts`。`null` 抑制头仍允许。网关额外要求的凭据头（不是 provider 的那一个 API key）目前没有地方存。损坏的 `providers.json` 不会阻断启动：整个文件读不了或不是合法 JSON 时，首次打开回退到内置 provider，运行中重载则保留上次有效的定义（加载过条目之后文件消失也按读不了处理，编辑器改名保存时会短暂缺失）；单个条目无效时只跳过该条目（运行中重载保留它上次的有效版本），其余条目照常加载。两种情况都记录 `error`。写入前仍要求整个文件有效，避免悄悄丢掉用户手写的条目。vault 里的 baseURL override 也走同一套 URL 校验。
- **密钥不出现在任何响应或事件里**。对外只给 `ProviderSecretView`（`hasKey`、`maskApiKey` 的提示、配置元信息）；自定义 header（含 `models[].headers`）只暴露名字，值一律替换为掩码，`null` 抑制头保持 `null`。vault 里的 baseURL override 显示时，版本参数以外的 query 值也打码（旧数据可能带凭据）。Provider 抛出的错误经 `redactError` 去掉 key。
- **密钥不进 argv**。和系统凭据库交互的子进程，数据只走 stdin/stdout；可执行文件用绝对路径（Linux 的 `secret-tool` 除外）。
- **文件头进 AAD**，每次写入换新 IV；`parseEnvelope` 在派生密钥之前就拒绝不认识的版本或 scrypt 参数（防止篡改文件触发昂贵计算）。改格式就升 `VAULT_VERSION`。
- **写入是原子的**：同目录临时文件 + rename，POSIX 下目录 `0700`、文件 `0600`。`VaultStore` 和 `ProviderConfigStore` 的写操作均经内部队列串行执行。
- **多个进程可能同时打开同一个 vault**，例如运行中的内核和 `albireo keys`。`updateProvider` 先重新读取并解密磁盘上的文件，在它的基础上修改，不会丢掉另一个进程写入的内容。`initialize` 在磁盘上已有 vault 时拒绝执行，不会覆盖它，也不会覆盖它的主密钥。文件被换成另一个 vault（salt 不同）时，写入直接报错。没有跨进程锁：两个进程在同一毫秒级窗口里写入时，仍可能丢失其中一次。只读的内存副本不会自动刷新。
- 锁定时把内存中的密钥 `Buffer` 清零。JS 字符串（解密后的 API key）无法清零，这是已知限制。
- **vault 条目按 provider ID 存，不能被同 ID 的新 provider 继承**。`SecretManager.upsertProviderConfig` 新建自定义 provider（内存和磁盘上都没有这个 ID）时先清掉 vault 里同 ID 的残留，所以 vault 锁定时拒绝新建；内置 provider 的覆写不算新建。可选的初始 `apiKey` 在写 `providers.json` 之前存进 vault，存不进去就不写条目。`deleteCustomProvider` 在 vault 锁定时拒绝，先删配置再删 key：配置写不进去时什么都没丢，key 删失败留下的残留由下次新建清掉。手工从文件里删掉再手工加回同一个 ID，会沿用 vault 里的旧 key，这是已知行为。
- `ProviderConfigStore` 的 `reload`、`upsert`、`remove` 都在同一个队列段里完成读盘和提交，不会被并发写入夹在中间，用旧内容覆盖新内容；`SecretManager` 另用一个队列把配置写入和对应的 vault 操作串起来。当前活跃的自定义 provider 不会从内存里消失（否则 registry 会注销它，会话也就刷新不了）：`retain` 在每次提交时同步询问当前 provider，文件里没有它时保留上次的定义并在 `configError` 里提示，其余改动照常生效；会话切走后自动重载把它去掉。询问发生在提交那一刻，读写期间发生的切换也算数。活跃 provider 的配置修改照常生效：空闲时立即生效，运行中则等本轮结束。`reloadProviderConfig()` 只在定义、错误或保留状态真的变化时才通知，因此可被 `GET /secrets` 反复调用。`albireo keys status` 只让该进程读取最新配置，不会让运行中的内核重载。

## 测试

- `test/*.test.mjs`：`node --test`，导入 `../dist/`，先 `pnpm build`。用 `MemoryKeyProtector` 和 `mkdtemp` 目录，不碰真实用户目录或系统凭据库。
- 唯一的例外：Windows 上有一条 DPAPI 往返测试（只写临时目录，不在系统里留任何东西）；macOS / Linux 的适配器没有自动化测试，改动后要在对应系统上手动验证。
