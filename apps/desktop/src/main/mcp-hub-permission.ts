import {
  composeCanUseToolHandlers,
  type SdkToolPermissionDecision,
  type SdkToolPermissionRequest,
} from "@eco/runtime";

export function createMcpHubNestedToolPermissionHandler(
  handlers: readonly ((request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision>)[],
): (request: SdkToolPermissionRequest) => Promise<SdkToolPermissionDecision> {
  const delegate = composeCanUseToolHandlers(...handlers);
  return async (request) => {
    if (
      request.toolName !== "mcp__eco_mcp__call_tool" &&
      request.toolName !== "eco_mcp_call_tool" &&
      !request.toolName.endsWith("__eco_mcp__call_tool")
    ) {
      return { behavior: "allow", updatedInput: request.input };
    }
    const toolId = typeof request.input.name === "string" ? request.input.name.trim() : "";
    const nested = isRecord(request.input.arguments) ? request.input.arguments : {};
    const separator = toolId.indexOf(":");
    if (separator <= 0 || !toolId.slice(separator + 1).trim()) {
      return {
        behavior: "deny",
        message: "Eco MCP Hub call_tool 缺少有效的已搜索工具 ID。",
        interrupt: false,
      };
    }
    const decision = await delegate({
      ...request,
      toolName: `mcp__${toolId.slice(0, separator)}__${toolId.slice(separator + 1)}`,
      input: nested,
    });
    return decision.behavior === "allow"
      ? { ...decision, updatedInput: { ...request.input, arguments: decision.updatedInput ?? nested } }
      : decision;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
