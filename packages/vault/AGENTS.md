# @albireo/vault

本地加密凭据库。CLI 和 server 的 API 凭据**只**从这里来，不读环境变量。依赖 `@albireo/core`（构建 Provider），只用 Node 内置模块，没有第三方运行时依赖。公开 API 从 `src/index.ts` 导出。

## 模块

| 文件               | 内容                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/crypto.ts`    | 信封格式（`VaultEnvelope`）、AES-256-GCM `seal`/`unseal`、HKDF / scrypt 派生、`parseEnvelope` 严格校验                         |
| `src/protector.ts` | `KeyProtector` 接口与实现：Windows DPAPI、macOS Keychain、Linux Secret Service、`MemoryKeyProtector`（测试）                   |
| `src/store.ts`     | `VaultStore`：状态机（uninitialized / locked / unlocked）、串行化写入、provider ID（内置 + 自定义）与凭据输入校验              |
| `src/providers.ts` | `ProviderConfigStore`：读取、严格校验并原子写入同目录下的 `providers.json`（非敏感端点、线协议、认证模式、`compat`、模型清单） |
| `src/registry.ts`  | `createVaultRegistry` / `registerVaultProviders`、`isProviderReady`、`UnconfiguredProvider`、`maskApiKey`、`redactError`       |
| `src/manager.ts`   | `SecretManager`：把 vault、`ProviderConfigStore`、`ProviderRegistry` 和 `Session` 绑在一起，供 server 路由调用                 |
| `src/fs.ts`        | 默认目录（`defaultVaultDir`，按平台取用户级配置目录）、私有目录与原子写入                                                      |

## 两种保护模式

- **os-keychain**：随机主密钥交给系统凭据库保管，vault 密钥由它经 HKDF 派生。打开时自动解锁。
- **passphrase**：没有可用的系统凭据库时使用（`SecretManager.unlock` 在 uninitialized 状态下也会显式创建这种 vault）；scrypt 派生，启动后处于 locked，需在面板解锁（无头模式在 TTY 上提示输入）。

模式写在文件头 `kdf.mode` 里，参数以 `crypto.ts` 的常量为准。

## 不变量（改动时别破坏）

- **绝不碰 `process.env` 里的凭据**。需要凭据的 provider（`auth: "api-key" | "bearer"`）没有 key 时注册 `UnconfiguredProvider`，不构造 SDK 客户端（SDK 会自己去读环境变量）；免鉴权本地端点（`auth: "none"`）直接可用且通过无害占位 + 屏蔽认证头防止 SDK 回退环境变量。`baseURL` 总是显式传入。
- **非敏感配置与凭据分离**：`providers.json` 与 `vault.enc.json` 同目录（永不进工作区），严禁出现 `apiKey` / `authToken`（出现即报错拒绝）；损坏的 `providers.json` 不会阻断启动，而是记录 `error` 并回退到内置 provider。
- **密钥不出现在任何响应或事件里**。对外只给 `ProviderSecretView`（`hasKey`、`maskApiKey` 的提示、配置元信息）。Provider 抛出的错误经 `redactError` 去掉 key。
- **密钥不进 argv**。和系统凭据库交互的子进程，数据只走 stdin/stdout；可执行文件用绝对路径（Linux 的 `secret-tool` 除外）。
- **文件头进 AAD**，每次写入换新 IV；`parseEnvelope` 在派生密钥之前就拒绝不认识的版本或 scrypt 参数（防止篡改文件触发昂贵计算）。改格式就升 `VAULT_VERSION`。
- **写入是原子的**：同目录临时文件 + rename，POSIX 下目录 `0700`、文件 `0600`。`VaultStore` 和 `ProviderConfigStore` 的写操作均经内部队列串行执行。
- **多个进程可能同时打开同一个 vault**，例如运行中的内核和 `albireo keys`。`updateProvider` 先重新读取并解密磁盘上的文件，在它的基础上修改，不会丢掉另一个进程写入的内容。`initialize` 在磁盘上已有 vault 时拒绝执行，不会覆盖它，也不会覆盖它的主密钥。文件被换成另一个 vault（salt 不同）时，写入直接报错。没有跨进程锁：两个进程在同一毫秒级窗口里写入时，仍可能丢失其中一次。只读的内存副本不会自动刷新。
- 锁定时把内存中的密钥 `Buffer` 清零。JS 字符串（解密后的 API key）无法清零，这是已知限制。

## 测试

- `test/*.test.mjs`：`node --test`，导入 `../dist/`，先 `pnpm build`。用 `MemoryKeyProtector` 和 `mkdtemp` 目录，不碰真实用户目录或系统凭据库。
- 唯一的例外：Windows 上有一条 DPAPI 往返测试（只写临时目录，不在系统里留任何东西）；macOS / Linux 的适配器没有自动化测试，改动后要在对应系统上手动验证。
