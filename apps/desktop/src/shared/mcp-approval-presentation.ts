/** Friendly presentation only: runtime identifiers remain unchanged for routing and isolation. */
export function presentMcpApproval<
  T extends {
    kind?: string;
    filesystemTool?: string;
    filesystemPath?: string;
    command: string;
    reason: string;
    description?: string;
  },
>(request: T): T {
  if (request.kind !== "mcp" && request.filesystemTool !== "MCP") return request;
  const path = request.filesystemPath;
  const separator = path?.indexOf("/") ?? -1;
  if (!path || separator < 1) return request;
  const server = path.slice(0, separator);
  const fullTool = path.slice(separator + 1);
  const prefix = `mcp__${server}__`;
  const leaf = fullTool.startsWith(prefix) ? fullTool.slice(prefix.length) : fullTool;
  const hub = /^eco_mcp(?:_[a-z0-9_-]+)?$/i.test(server);
  const displayServer = hub ? "Mori MCP Hub" : server;
  const displayTool =
    hub && leaf === "search_tools" ? "查找 MCP 工具" : hub && leaf === "call_tool" ? "执行 MCP 工具" : leaf;
  const argumentsText = request.description?.match(/with arguments\s+([\s\S]+?)\s*\?\s*$/i)?.[1];
  return {
    ...request,
    filesystemPath: `${displayServer} · ${displayTool}${argumentsText ? `\n${argumentsText}` : ""}`,
    description: hub && leaf === "search_tools" ? "查找 MCP 工具" : `调用 ${displayServer} · ${displayTool}`,
    reason:
      hub && leaf === "search_tools"
        ? "检索当前会话可用的工具名称、说明和参数定义。"
        : `Agent 请求调用 ${displayServer} 的 ${displayTool} 工具。`,
  };
}
