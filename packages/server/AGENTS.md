# @albireo/server

单文件 `src/index.ts`，导出 `startPanelServer(session, opts)`，把一个运行中的 `Session` 暴露给 GUI 面板。

## 协议

- `GET /`：返回面板的 `index.html`（默认来自同级的 `packages/panel/public/`，可以用 `opts.publicDir` 覆盖）。
- `GET /events`：SSE。先发一条 `{ type: "snapshot", ... }`，之后转发 `Session` 的每个事件。订阅和取快照在同一个 tick 里完成，所以事件不会漏也不会重复。
- `POST /command`：JSON body，`type` 取 `send | approve | abort | switch`，成功时返回 202。可用命令以源码里的 `switch` 为准。

## 安全（这是硬性要求，不是可选项）

Agent 能执行任意命令，所以这个服务必须锁死：

- 只绑定 `127.0.0.1`。
- 校验 `Host` 头，只接受回环地址加实际端口，防 DNS rebinding。
- 每次启动生成随机 token。所有请求都要带上，可以放在 `?token=` 或 `x-albireo-token` 头里，用常量时间比较。
- body 有大小上限。

新增路由时，它必须经过同一套检查（检查写在 handler 开头，别在它前面插路由）。要做远程访问是另一件事，需要单独设计，不要放宽现有检查。

## 测试

目前没有专门的测试。改协议时，记得同步修改 `packages/panel/public/index.html` 里的调用方。
