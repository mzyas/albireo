# Albireo

一个与厂商无关的编码 Agent：**TUI 内核 + GUI 面板**，用 TypeScript 写成，OpenAI 与 Anthropic 两家模型可随时切换。

> 名字取自天鹅座的双星 Albireo：一颗金黄、一颗湛蓝，肉眼看是一个点，望远镜里是两颗。命令行入口为 `albireo`，短别名 `albi`。

## 结构

```
packages/
  core/    @albireo/core    无头内核：中立消息模型、Provider 适配器（Anthropic / OpenAI）、Agent 循环、工具与审批
  server/  @albireo/server  本地桥：把运行中的 Session 通过 SSE + POST 暴露给 GUI 面板
  tui/     @albireo/tui     终端界面（Ink）+ `albireo` 命令行入口；同时负责启动面板服务
  panel/   @albireo/panel   GUI 面板（静态页面，目前无构建步骤）
```

```
            ┌────────────── Session（core）──────────────┐
  TUI ◄────►│ 中立历史 · Agent 循环 · 工具 · 审批 · 事件流 │◄────► GUI 面板（SSE + POST）
            └───────┬─────────────────────┬──────────────┘
                    ▼                     ▼
             AnthropicProvider       OpenAIProvider
```

TUI 和 GUI 是同一个 Session 的两个视图：两边看到同一份事件流，任何一边都能发消息、批准工具调用、中止、切换模型。

## 使用

```bash
pnpm install
pnpm build
```

密钥通过环境变量提供（Albireo 不读取 `.env`，也不保存密钥）：

```powershell
$env:ANTHROPIC_API_KEY = "..."
$env:OPENAI_API_KEY    = "..."
```

```bash
node packages/tui/dist/cli.js                  # 默认 anthropic
node packages/tui/dist/cli.js -p openai        # 用 openai
node packages/tui/dist/cli.js --prompt "..."   # 无头模式，输出后退出
```

TUI 内命令：`/provider <anthropic|openai> [model]`、`/model <id>`、`/panel`（显示 GUI 面板地址）、`/abort`、`/exit`。
提示符上按 `Esc` 中止当前回合；审批提示按 `y` / `n`。

## 设计要点

- **中立历史**：消息、工具调用、工具结果用厂商无关的类型保存，换厂商时历史原样带过去。
- **原生回放**：同厂商同模型的助手消息会带上原生 payload（Anthropic 的 thinking 块必须原样回传），换模型时自动退回中立重建。
- **工具审批**：工具按风险分级 `read | write | exec`。默认只自动放行 `read`，其余需要在 TUI 或面板里批准；`--yolo` 才会全放行。
- **输入校验**：模型给出的工具入参先过 zod 校验，失败则作为错误结果回给模型，不会执行；路径一律限制在工作区内。
- **面板安全**：服务只绑定 `127.0.0.1`，校验 `Host` 头（防 DNS rebinding），每次启动生成随机 token，所有请求必须带 token。
- **Anthropic 默认配置**：`claude-opus-5-5`、自适应思考、`effort: high`、流式输出，并默认开启服务端拒绝回退（beta `server-side-fallback-2026-07-01`，`new AnthropicProvider({ fallbacks: false })` 可关闭）。

## 已知限制 / 下一步

- OpenAI 适配器走 Chat Completions（也兼容 OpenAI 兼容端点，设 `OPENAI_BASE_URL`）。默认模型 `gpt-5` 只是占位，用 `ALBIREO_OPENAI_MODEL` 或 `-m` 指定你实际可用的模型。
- 两个适配器尚未用真实密钥联调；核心逻辑、面板服务、TUI 渲染由脚本化 Provider 测试覆盖（`pnpm test`）。
- 面板目前是单个静态 HTML；需要更复杂的界面时再换成 Vite + React 子包。
- 暂未实现：会话持久化、上下文压缩、MCP 工具接入、多会话。
