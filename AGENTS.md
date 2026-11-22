# AGENTS.md

Albireo 是一个与厂商无关的编码 Agent：无头内核（Session）+ GUI 面板，TypeScript，pnpm workspace。

本文件只给全局地图和规则。**改某个包之前，先读该包目录下的 `AGENTS.md`**，那里有它的模块划分、不变量和测试方式。

## 地图

| 包                 | 职责                                                        | 细节                                                     |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------- |
| `packages/core`    | 中立消息模型、Provider 适配器、Agent 循环、工具与审批       | [packages/core/AGENTS.md](packages/core/AGENTS.md)       |
| `packages/vault`   | 加密凭据库，从中构建 `ProviderRegistry`                     | [packages/vault/AGENTS.md](packages/vault/AGENTS.md)     |
| `packages/store`   | 会话持久化：把对话存到磁盘，下次接着聊                      | [packages/store/AGENTS.md](packages/store/AGENTS.md)     |
| `packages/server`  | 管理多个会话，通过 SSE + POST 暴露给面板（仅本机）          | [packages/server/AGENTS.md](packages/server/AGENTS.md)   |
| `packages/cli`     | `albireo` / `albi` 命令行入口                               | [packages/cli/AGENTS.md](packages/cli/AGENTS.md)         |
| `packages/desktop` | Electron 外壳：运行内核，在窗口里显示面板，原生文件夹选择器 | [packages/desktop/AGENTS.md](packages/desktop/AGENTS.md) |
| `packages/panel`   | GUI 面板（Vite + SolidJS），构建成单个 `index.html`         | [packages/panel/AGENTS.md](packages/panel/AGENTS.md)     |

依赖方向：`cli → server → vault → core`；`cli → store → core`；`server → store`；`cli` 和 `server` 也直接依赖 `core`，`cli` 也直接依赖 `vault`。`desktop` 和 `cli` 一样是宿主：直接依赖 `server`、`vault`、`store`、`core`，运行时只把构建好的 `panel` 当文件加载。`store` 不依赖 `vault`。`core` 不依赖任何其他包，也不知道界面和凭据库存在；界面只通过 `Session` 的事件和方法交互。`panel` 在运行时不依赖任何 workspace 包，只以 `import type` 引用 `core`、`vault` 和 `server`（`@albireo/server/protocol`）的协议类型，由 server 在运行时提供。

## 命令

```bash
pnpm install          # Node 版本见 package.json 的 engines，pnpm 版本见 packageManager
pnpm build            # tsc -b（所有包的编译和类型检查），再构建面板（Vite）
pnpm test             # 各包的 node:test；多数测试导入 dist/，所以先 build（面板的测试直接跑源码）
pnpm lint             # Biome：lint + 格式 + import 排序
pnpm lint:fix         # 自动修复能修的部分
pnpm --filter @albireo/desktop start   # 桌面应用（先 build，细节见 packages/desktop/AGENTS.md）
```

完成任何改动前，这三条必须都通过：`pnpm lint && pnpm build && pnpm test`。CI（`.github/workflows/ci.yml`）跑的就是这些。

## 配置在哪

| 关心什么                                                    | 看哪个文件                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| TS 编译选项（strict、`noUncheckedIndexedAccess`、NodeNext） | `tsconfig.base.json`；各包 `tsconfig.json` 只设 `outDir`/`rootDir`/`references` |
| 包之间的构建顺序                                            | 根 `tsconfig.json` 的 `references` 和各包的 `references`                        |
| Lint / 格式规则                                             | `biome.json`                                                                    |
| CI                                                          | `.github/workflows/ci.yml`                                                      |
| API 凭据                                                    | 加密 vault，见 `packages/vault/AGENTS.md`；CLI 和 server 不从环境变量读凭据     |
| 环境变量                                                    | `.env.example`：只有 `packages/core/test-live/` 读它们（Albireo 不读 `.env`）   |
| 换行符                                                      | `.gitattributes` 强制 LF                                                        |

## 规则

- ESM + NodeNext：TS 源码里的相对导入要写 `.js` 后缀（`./types.js`）。
- 新增包时：加到根 `tsconfig.json` 的 `references`，依赖其他包用 `workspace:*`，并写该包的 `AGENTS.md`。
- 不要提交密钥；不要让代码读取 `.env`；CLI / server 的凭据只能来自 vault，不要加环境变量回退。
- 需要真实 API 的检查放在 `packages/core/test-live/`，不进 `pnpm test` 和 CI。
- 抑制 lint 规则时用 `// biome-ignore <rule>: <理由>`，理由必填。
- 文档写“去哪里看”，不抄具体的值（版本号、CLI 参数、模型名）：那些以源码为准，抄过来就会过时。
