# @albireo/cli

单文件 `src/cli.ts`，编译为 `dist/cli.js`，bin 名是 `albireo` 和 `albi`（见 `package.json`）。

- 参数用 `node:util` 的 `parseArgs` 解析。**参数列表以 `HELP` 常量和 `parseArgs` 的 options 为准**，两处要一起改。
- 两种模式：
  - 服务模式（不带 `--prompt`）：启动 Session 和面板服务，打印面板地址，一直运行到 SIGINT/SIGTERM。
  - 无头模式（`--prompt`）：把输出流式写到 stdout，自动拒绝所有需要审批的调用，跑完退出。
- `--yolo` 把 `autoApprove` 扩大到全部风险等级；默认只放行 `read`。
- Provider 来自 core 的 `defaultRegistry()`。模型、端点等环境变量在那里读取，不在 CLI 里读。
- 出错时调用 `fail()`：写 stderr 并以非零码退出。参数错误用退出码 2。
