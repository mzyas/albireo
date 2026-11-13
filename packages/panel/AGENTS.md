# @albireo/panel

GUI 面板，目前就是一个静态文件 `public/index.html`（内联 CSS 和 JS），没有构建步骤，也没有依赖。由 `@albireo/server` 直接读文件提供，改完刷新浏览器就能看到。

- 从页面 URL 的 `?token=` 读取 token。SSE 用查询参数带上它，`POST /command` 用 `x-albireo-token` 头带上它。
- 页面状态完全由事件驱动：先渲染 `snapshot`，再逐条处理事件。要新增一种事件的显示，就在事件分发的 `switch` 里加分支。
- 协议定义见 [../server/AGENTS.md](../server/AGENTS.md)，两边要一起改。
- Biome 也检查这个 HTML，包括内联脚本和 a11y 规则。
- 计划迁移到 Vite + SolidJS（之后还要加 Electron 外壳）。迁移时需要加构建步骤、把它加进根 `tsconfig.json` 的 references，并更新本文件。
