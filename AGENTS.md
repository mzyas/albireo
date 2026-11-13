# AGENTS.md

Albireo 是一个与厂商无关的编码 Agent：无头内核（Session）+ GUI 面板，TypeScript，pnpm workspace。

本文件只给全局地图和规则。**改某个包之前，先读该包目录下的 `AGENTS.md`**，那里有它的模块划分、不变量和测试方式。

## 地图

| 包                | 职责                                                  | 细节                                                   |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `packages/core`   | 中立消息模型、Provider 适配器、Agent 循环、工具与审批 | [packages/core/AGENTS.md](packages/core/AGENTS.md)     |
| `packages/server` | 把 Session 通过 SSE + POST 暴露给面板（仅本机）       | [packages/server/AGENTS.md](packages/server/AGENTS.md) |
| `packages/cli`    | `albireo` / `albi` 命令行入口                         | [packages/cli/AGENTS.md](packages/cli/AGENTS.md)       |
| `packages/panel`  | 静态 GUI 面板，无构建步骤                             | [packages/panel/AGENTS.md](packages/panel/AGENTS.md)   |

依赖方向：`cli → server → core`，`cli → core`。`core` 不依赖任何其他包，也不知道界面存在；界面只通过 `Session` 的事件和方法交互。

## 命令

```bash
pnpm install          # Node 版本见 package.json 的 engines，pnpm 版本见 packageManager
pnpm build            # tsc -b，按 tsconfig 的 references 增量构建所有包
pnpm test             # 各包的 node:test；测试导入 dist/，所以先 build
pnpm lint             # Biome：lint + 格式 + import 排序
pnpm lint:fix         # 自动修复能修的部分
```

完成任何改动前，这三条必须都通过：`pnpm lint && pnpm build && pnpm test`。CI（`.github/workflows/ci.yml`）跑的就是这些。

## 配置在哪

| 关心什么                                                    | 看哪个文件                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| TS 编译选项（strict、`noUncheckedIndexedAccess`、NodeNext） | `tsconfig.base.json`；各包 `tsconfig.json` 只设 `outDir`/`rootDir`/`references` |
| 包之间的构建顺序                                            | 根 `tsconfig.json` 的 `references` 和各包的 `references`                        |
| Lint / 格式规则                                             | `biome.json`                                                                    |
| CI                                                          | `.github/workflows/ci.yml`                                                      |
| 环境变量                                                    | `.env.example`（Albireo 不读 `.env`，只读进程环境）                             |
| 换行符                                                      | `.gitattributes` 强制 LF                                                        |

## 规则

- ESM + NodeNext：TS 源码里的相对导入要写 `.js` 后缀（`./types.js`）。
- 新增包时：加到根 `tsconfig.json` 的 `references`，依赖其他包用 `workspace:*`，并写该包的 `AGENTS.md`。
- 不要提交密钥；不要让代码读取 `.env`。
- 需要真实 API 的检查放在 `packages/core/test-live/`，不进 `pnpm test` 和 CI。
- 抑制 lint 规则时用 `// biome-ignore <rule>: <理由>`，理由必填。
- 文档写“去哪里看”，不抄具体的值（版本号、CLI 参数、模型名）：那些以源码为准，抄过来就会过时。
