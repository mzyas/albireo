# Albireo

[![CI](https://github.com/mzyas/albireo/actions/workflows/ci.yml/badge.svg)](https://github.com/mzyas/albireo/actions/workflows/ci.yml)

一个与厂商无关的编码 Agent：**无头内核 + GUI 面板**，用 TypeScript 写成，OpenAI 与 Anthropic 的模型可以随时切换，对话历史原样带过去。

> 名字取自天鹅座的双星 Albireo：一颗金黄、一颗湛蓝，肉眼看是一个点，望远镜里是两颗。

早期开发中，接口可能随时变化。

## 快速开始

```bash
pnpm install
pnpm build
```

API 密钥在面板的 **API Keys** 里填写，或者在终端里用 `keys` 子命令填写。密钥加密保存在用户配置目录（不在工作区里），主密钥由系统凭据库保管，没有系统凭据库时用你设置的口令保护。Albireo 不从环境变量读取密钥。

```bash
node packages/cli/dist/cli.js              # 启动内核，在浏览器里打开打印出的面板地址
node packages/cli/dist/cli.js --prompt "…" # 无头运行一次后退出
node packages/cli/dist/cli.js keys set anthropic  # 在终端里保存 API 密钥（输入不回显）
node packages/cli/dist/cli.js --help       # 全部参数
```

除了内置的 Anthropic / OpenAI，还可以接兼容 Anthropic Messages 或 OpenAI Chat Completions 协议的端点（DeepSeek、OpenRouter、Ollama、LiteLLM、自建网关等）。在面板的 **API Keys** 里添加，或者写进用户配置目录（和加密 vault 同目录）的 `providers.json`，可用字段以 `packages/vault/src/providers.ts` 的校验逻辑为准。这个文件只放非敏感配置，key 一律存进加密 vault。

面板服务只监听本机回环地址，每次启动都会生成新的访问 token。需要写文件或执行命令的工具调用默认要在面板里批准。

## 开发

项目结构、各个包的设计约束和开发命令见 [AGENTS.md](AGENTS.md)，人和编码 Agent 都可以从这里读起。
