# 改动说明：Eco 内置工具提示词

更新日期：2026-10-09。当前代码已采用轻量能力说明：每类能力提供名称、用途和服务搜索目标，公共 Hub 调用规则合并后只出现一次。调用方仍按会话设置选择要注入的能力。

具体工具的名称、description、参数和局部使用规则通过搜索获取；浏览器长流程由随附的 eco-agent-browser Skill 提供。会话隔离、桌面共享、供应商参数差异和绘画失败后的配置决策仍在上下文中保留。

用户添加的外部 MCP 也已接入[能力目录注入](mcp-hub-external-tool-directory.md)：提供本会话启用的服务搜索名称、工具数量和实际 description 的简短能力示例；具体定义仍按需搜索。

## 运行时实际生成的示例

下面直接由代码生成，示例启用了全部 8 类能力，绘画使用 OpenAI 类配置、启用图生图，搜索服务为 Tavily。Example 和 example-image-model 为示例值；实际运行时使用用户当前配置，Codex 会进一步将 Hub 工具名改写成该线程的注册名称。

```text
Built-in browser (Eco): browse and interact with websites, read pages, fill forms, extract data, capture screenshots and verify web UIs.
Eco MCP Hub: call `mcp__eco_mcp__search_tools` with a Hub target in `query`, read the returned descriptions and input schemas, then call `mcp__eco_mcp__call_tool` with the returned tool id in `name` and its input in `arguments`. Reuse discovered definitions within this turn. Use direct MCP tools only when explicitly listed. Eco manages connections, session routing and approvals; do not launch substitute MCP servers or CLIs. Report discovery or execution failures.
Hub target: `eco_agent_browser`.
Tabs are auth-bound to the current conversation thread; cookies, localStorage and IndexedDB are shared within this workspace. Eco binds the browser session automatically; do not pass a custom `session`.
Use the bundled Skill `eco-agent-browser` for browser workflows. Discover capabilities through tool search; this server exposes tools only.

Built-in Computer Use (Eco): inspect and operate local applications and desktop interfaces through accessibility APIs.
Hub target: `eco_computer_use`.
Desktop state is shared across conversations; actions affect the same OS UI. Action approvals follow the current Eco settings.
Act on current accessibility state; refresh it after navigation or failed actions. Prefer element indices, using coordinates only when no accessibility element matches.

Built-in Creative Drawing (Eco): generate illustrations and visual assets; edit reference images when the active profile supports image-to-image. Use this integration for image generation and editing.
Hub target: `eco_image_generation`.
Active profile: Example; provider=openai; model=example-image-model.
OpenAI-style providers accept size, quality, and count=1..4; aspect_ratio is unsupported.
Image-to-image is enabled: pass input_images (1..16 absolute or workspace-relative PNG/JPEG/WebP paths) with the edit prompt.
Eco handles approval for every drawing call. After an error, changes to provider, model, size, quality, count or aspect ratio require the user's decision.

Built-in image viewing (Eco): analyze images, read screenshots and inspect visual results with a vision model; returns a text answer to your question.
Hub target: `eco_image_view`.
On Codex, use this Eco tool for image inspection with custom providers; the native view_image tool remains available with the built-in OpenAI account.

Built-in image display (Eco): present images, screenshots and visual results to the user in workspace cards and the task sidebar. Image analysis is provided by Eco image viewing.
Hub target: `eco_image_display`.

Built-in HTML page hosting (Eco Artifacts): publish or update shareable, self-contained HTML pages for progress reports and statistics.
Hub target: `eco_html_host`.

Integrated web search (Eco): search public webpages for current information and reference sources.
Hub target: `eco_web_search`.
Active search provider: Tavily. Use this integration for web searches in this conversation.

Built-in scheduling (Eco): continue this conversation after a delay, or run independent scheduled tasks in new conversations; inspect, update and cancel schedules.
Hub target: `eco_scheduling`.
Choose a conversation wakeup to continue current work. Independent task prompts must include all required context because each occurrence starts a new conversation.
Execution requires Eco running on an awake local computer; a conversation wakeup does not wake a sleeping computer.
```

## 文本长度对比

相同示例配置，合并且去除重复 Hub 说明后：

| 版本 | 字符数 |
| --- | --- |
| 修改前 | 7437 |
| 修改后 | 3516 |

文本长度减少 52.7%。这是字符数对比，不是 Token 测量；实际长度随启用能力和配置名称变化。

## 从常驻上下文移至 description 的说明

- 图片查看：用路径或引用传递图片，不把图片字节放进主上下文。
- 图片展示：展示位置、成功返回、图片链接和 base64 回复规则。
- HTML 页面发布：已有页面更新不重置有效期，使用返回的链接和到期信息。
- 定时消息：延时范围、每会话唤醒次数以及成功后确认。
- 独立定时任务：时间与时区格式以及成功后确认。

这些规则已经写入实际工具 description，不依赖模型猜测。工具的输入 schema、执行逻辑和权限配置保持原有行为。

## 验证

- 77 项相关 Bun 测试通过，覆盖 Hub 提示词合并、Codex 名称改写、浏览器/图片网关、会话隔离和 Pi 注入。
- 全仓库 TypeScript 类型检查通过。

## 代码位置

- [公共 Hub 调用说明](../apps/desktop/src/shared/mcp-hub-tool-usage.ts)
- [浏览器](../apps/desktop/src/shared/browser.ts)
- [电脑操控](../apps/desktop/src/shared/computer-use.ts)
- [创意绘画](../apps/desktop/src/shared/image-generation.ts)
- [图片查看](../apps/desktop/src/shared/image-view-tool.ts)
- [图片展示](../apps/desktop/src/shared/image-display-tool.ts)
- [HTML 页面发布](../apps/desktop/src/shared/html-host-tool.ts)
- [联网搜索](../apps/desktop/src/shared/integrated-web-search.ts)
- [定时消息与任务](../apps/desktop/src/shared/scheduling.ts)
