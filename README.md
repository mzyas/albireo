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

密钥只从环境变量读取（不读 `.env`，也不保存），可用的变量见 [`.env.example`](.env.example)。

```bash
node packages/cli/dist/cli.js              # 启动内核，在浏览器里打开打印出的面板地址
node packages/cli/dist/cli.js --prompt "…" # 无头运行一次后退出
node packages/cli/dist/cli.js --help       # 全部参数
```

面板服务只监听本机回环地址，每次启动都会生成新的访问 token。需要写文件或执行命令的工具调用默认要在面板里批准。

## 开发

项目结构、各个包的设计约束和开发命令见 [AGENTS.md](AGENTS.md)，人和编码 Agent 都可以从这里读起。
