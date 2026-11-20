import { expect, test } from "bun:test";
import { ECO_AGENT_BROWSER_ALLOWED_TOOL, ECO_AGENT_BROWSER_MCP_SERVER } from "../src/shared/browser";
import type { McpSdkConfig } from "../src/shared/mcp";

// Unit-test pure merge logic without Electron native browser views.
function mergeBrowserMcp(
  base: McpSdkConfig,
  injection: {
    enabled: boolean;
    sdkEntry?: Record<string, unknown>;
    autoApproveTools?: boolean;
  },
): McpSdkConfig {
  if (!injection.enabled || !injection.sdkEntry) {
    return base;
  }
  const allowedTools =
    injection.autoApproveTools === false
      ? [...base.allowedTools]
      : [...new Set([...base.allowedTools, ECO_AGENT_BROWSER_ALLOWED_TOOL])];
  return {
    mcpServers: {
      ...base.mcpServers,
      [ECO_AGENT_BROWSER_MCP_SERVER]: injection.sdkEntry,
    },
    allowedTools,
  };
}

test("agent browser MCP merges only when enabled", () => {
  const base: McpSdkConfig = {
    mcpServers: { docs: { type: "stdio", command: "echo" } },
    allowedTools: ["mcp__docs__*"],
  };
  const off = mergeBrowserMcp(base, { enabled: false });
  expect(off.mcpServers.mori_agent_browser).toBeUndefined();
  expect(off.allowedTools).toEqual(["mcp__docs__*"]);

  const on = mergeBrowserMcp(base, {
    enabled: true,
    autoApproveTools: true,
    sdkEntry: {
      type: "stdio",
      command: "/bin/agent-browser",
      args: ["--cdp", "9333", "mcp", "--tools", "core"],
      alwaysLoad: true,
    },
  });
  expect(on.mcpServers.mori_agent_browser).toEqual({
    type: "stdio",
    command: "/bin/agent-browser",
    args: ["--cdp", "9333", "mcp", "--tools", "core"],
    alwaysLoad: true,
  });
  expect(on.allowedTools).toContain(ECO_AGENT_BROWSER_ALLOWED_TOOL);
  expect(on.allowedTools).toContain("mcp__docs__*");

  const ask = mergeBrowserMcp(base, {
    enabled: true,
    autoApproveTools: false,
    sdkEntry: {
      type: "stdio",
      command: "/bin/agent-browser",
      args: ["--cdp", "9333", "mcp", "--tools", "core"],
      alwaysLoad: true,
    },
  });
  expect(ask.mcpServers.mori_agent_browser).toBeDefined();
  expect(ask.allowedTools).not.toContain(ECO_AGENT_BROWSER_ALLOWED_TOOL);
  expect(ask.allowedTools).toEqual(["mcp__docs__*"]);
});
