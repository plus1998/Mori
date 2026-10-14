# 改动说明：外部 MCP 能力目录注入

用户通过 Eco 添加并在当前会话启用的外部 MCP，现在会在 Agent 搜索工具之前提供能力目录。目录由 Hub 在准备会话时读取实际 `tools/list` 元数据生成，先按当前会话及父会话的服务、工具权限过滤，再加入上下文。

## 注入内容

- 服务的 Hub 名称，直接用作 `search_tools` 的 `query`。
- 当前获准使用的工具数量。
- 每个服务最多 5 个能力示例：实际工具 ID 与 description 摘录，每段摘录最多 160 个 Unicode 字符，超出用 `…` 标记。
- 未展示的工具数量。示例不是完整目录，Agent 仍需搜索目标服务或相关工具名称、能力关键词。

不从 MongoDB、MySQL 等品牌名推断权限或功能。MCP 没有提供 description 时明确标记缺失；连接失败或超时明确给出 `metadataError`，不会生成虚构简介，也不会将失败记成零个工具。

完整 description 和 input schema 仍通过搜索获得。参数 schema、连接地址、命令、环境变量、认证头不加入初始目录。Hub 的公共调用说明与内置工具提示词合并去重，Codex 的包装工具名继续改写为该会话的注册名称。

## 接入与刷新

- Codex：Hub 准备完成后，目录进入 `systemPromptAppend`。
- Claude：SDK 会话准备完成后，目录合入运行输入的全局提示。
- Pi：目录加入 `appendSystemPrompt`。
- Cursor/ACP：协议没有 system-prompt 字段，目录作为本轮上下文加入发给 Agent 的 prompt；用户原始消息及审批中的用户问题不改写。

每次会话运行准备时重新读取目录，复用 Hub 已有连接；不同服务并行获取元数据，每个请求最多等待 10 秒。仅内置能力启用时不会读取内置网关的工具清单，也不会重复注入内置目录。关闭外部 MCP、重绑权限、撤销会话或关闭 Hub 时清除对应旧目录。

## 代码与验证

- [目录读取与权限过滤](../apps/desktop/src/main/mcp-hub.ts)
- [会话准备与目录生命周期](../apps/desktop/src/main/mcp-hub-gateway.ts)
- [提示词生成与长度限制](../apps/desktop/src/shared/mcp-hub-tool-usage.ts)
- [Agent 接入路径](../apps/desktop/src/main/index.ts)
- [ACP 上下文传递](../apps/desktop/src/main/acp-runtime-run.ts)

测试使用真实 HTTP 及 stdio MCP 测试服务，覆盖元数据注入、会话隔离、权限刷新、父会话撤权、描述缺失、故障及超时，以及关闭外部 MCP 后旧目录清除。没有使用用户的数据库执行查询。
