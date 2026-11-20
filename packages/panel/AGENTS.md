# @albireo/panel

GUI 面板，目前就是一个静态文件 `public/index.html`（内联 CSS 和 JS），没有构建步骤，也没有依赖。由 `@albireo/server` 直接读文件提供，改完刷新浏览器就能看到。

- 从页面 URL 的 `?token=` 读取 token。SSE 用查询参数带上它，`POST /command` 用 `x-albireo-token` 头带上它。
- 页面状态完全由事件驱动：先渲染 `snapshot`，再逐条处理事件。要新增一种事件的显示，就在事件分发的 `switch` 里加分支。
- 协议定义见 [../server/AGENTS.md](../server/AGENTS.md)，两边要一起改。
- `API Keys` 按钮和 `<dialog id="keys">` 管理加密 vault 与自定义 provider：provider 列表、模型建议（`<datalist>`）和状态全部动态来自 `GET /secrets`（收到 `snapshot` 或 `secrets_changed` 时重新拉取并同步顶部 provider 下拉框）。页面上只有掩码提示，新增自定义 provider 时先 `POST /providers` 存配置，再用 `POST /secrets/provider` 存可选的初始密钥；密钥存失败时 provider 照样留着，提示用户在它自己的表单里再填，不做回滚。删除走 `DELETE /providers/:id`。口令 vault 锁定时新增和删除按钮都禁用（服务端也会拒绝）；vault 打不开时不禁用。provider 表单只在 Base URL / Model 被编辑过时才提交这两个字段，单独存 key 或清除 key 都不会改写它们，也不会丢掉没保存的编辑。所有密钥输入框在保存或关闭弹窗后清空。
- 用户输入一律用 `textContent` / `value` 赋值，不拼 HTML。
- Biome 也检查这个 HTML，包括内联脚本和 a11y 规则。
- 计划迁移到 Vite + SolidJS（之后还要加 Electron 外壳）。迁移时需要加构建步骤、把它加进根 `tsconfig.json` 的 references，并更新本文件。
