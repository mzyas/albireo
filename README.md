# Albireo

一个与厂商无关的编码 Agent：**无头内核 + GUI 面板**，用 TypeScript 写成，OpenAI 与 Anthropic 两家模型可随时切换。

> 名字取自天鹅座的双星 Albireo：一颗金黄、一颗湛蓝，肉眼看是一个点，望远镜里是两颗。命令行入口为 `albireo`，短别名 `albi`。

## 结构

```
packages/
  core/    @albireo/core    无头内核：中立消息模型、Provider 适配器（Anthropic / OpenAI）、Agent 循环、工具与审批
  server/  @albireo/server  本地桥：把运行中的 Session 通过 SSE + POST 暴露给 GUI 面板
  cli/     @albireo/cli     `albireo` 命令行入口：启动内核和面板服务，或用 --prompt 无头运行一次
  panel/   @albireo/panel   GUI 面板（静态页面，目前无构建步骤）
```

```
┌────────────── Session（core）──────────────┐
│ 中立历史 · Agent 循环 · 工具 · 审批 · 事件流 │◄────► GUI 面板（SSE + POST）
└───────┬─────────────────────┬──────────────┘
        ▼                     ▼
 AnthropicProvider       OpenAIProvider
```

内核是一个无头的 Session，界面只是它的客户端：GUI 面板通过事件流看到全部过程，可以发消息、批准工具调用、中止、切换模型。目前没有终端交互界面。

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
node packages/cli/dist/cli.js                  # 启动内核，打印 GUI 面板地址（默认 anthropic）
node packages/cli/dist/cli.js -p openai        # 用 openai
node packages/cli/dist/cli.js --prompt "..."   # 无头模式，输出后退出
```

不带 `--prompt` 时内核会一直运行，在浏览器里打开打印出的地址即可使用；按 `Ctrl+C` 停止。
需要审批的工具调用会在终端里提示，并在面板里处理；无头模式下一律拒绝（除非加 `--yolo`）。

## 设计要点

- **中立历史**：消息、工具调用、工具结果用厂商无关的类型保存，换厂商时历史原样带过去。
- **原生回放**：同厂商同模型的助手消息会带上原生 payload（Anthropic 的 thinking 块必须原样回传），换模型时自动退回中立重建。
- **工具审批**：工具按风险分级 `read | write | exec`。默认只自动放行 `read`，其余需要在面板里批准；`--yolo` 才会全放行。
- **输入校验**：模型给出的工具入参先过 zod 校验，失败则作为错误结果回给模型，不会执行；路径一律限制在工作区内。
- **面板安全**：服务只绑定 `127.0.0.1`，校验 `Host` 头（防 DNS rebinding），每次启动生成随机 token，所有请求必须带 token。
- **Anthropic 默认配置**：`claude-opus-5-5`、自适应思考、`effort: high`、流式输出，并默认开启服务端拒绝回退（beta `server-side-fallback-2026-07-01`，`new AnthropicProvider({ fallbacks: false })` 可关闭）。

## 已知限制 / 下一步

- OpenAI 适配器走 Chat Completions（也兼容 OpenAI 兼容端点，设 `OPENAI_BASE_URL`）。默认模型 `gpt-5` 只是占位，用 `ALBIREO_OPENAI_MODEL` 或 `-m` 指定你实际可用的模型。
- 两个适配器尚未用真实密钥联调；核心逻辑和面板服务由脚本化 Provider 测试覆盖（`pnpm test`）。
- 面板目前是单个静态 HTML；计划换成 Vite + SolidJS，并套 Electron 桌面壳。
- 暂未实现：会话持久化、上下文压缩、MCP 工具接入、多会话。
- 待办（暂不实现）：远程访问（设备配对、每设备令牌、TLS、监听开关、权限分级、审计）。现在内核只监听本机回环地址。
