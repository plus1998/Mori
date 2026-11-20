import { stableHash } from "./conversation-v2";

export const MORI_MCP_HUB_SERVER = "mori_mcp";

/**
 * Per-thread MCP Hub server name registered with the shared Codex app-server.
 *
 * Multiple Eco threads share one global MCP pool, so every thread's Hub must
 * register under a unique name derived from the Eco thread id. Desktop uses
 * this name for registration and system-prompt rewriting; the gateway uses it
 * to repair the `namespace` field that local models intermittently drop from
 * Hub function calls. All consumers must stay byte-identical, so the builder
 * lives here in @eco/shared.
 */
export function ecoMcpHubServerName(threadId: string): string {
  const normalized = threadId.trim();
  const readableSuffix = normalized.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-24);
  return `${MORI_MCP_HUB_SERVER}_${stableHash(normalized)}${readableSuffix ? `_${readableSuffix}` : ""}`;
}

/** Tool names the per-thread MCP Hub exposes (dispatched with the Hub namespace). */
export const ECO_MCP_HUB_TOOL_NAMES = ["call_tool", "search_tools"] as const;

/** Responses API `namespace` value for this thread's Hub tools. */
export function ecoMcpHubNamespace(threadId: string): string {
  return `mcp__${ecoMcpHubServerName(threadId)}`;
}
