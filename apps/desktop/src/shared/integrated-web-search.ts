import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export const ECO_WEB_SEARCH_MCP_SERVER = "eco_web_search";
export const ECO_WEB_SEARCH_TOOL = "search";
export const ECO_WEB_SEARCH_FULL_TOOL = `mcp__${ECO_WEB_SEARCH_MCP_SERVER}__${ECO_WEB_SEARCH_TOOL}`;

export function isEcoWebSearchToolName(name: string | undefined): boolean {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return false;
  }
  // Only match Eco's server id — bare `__search` collides with other MCP servers (claim routing).
  return normalized.includes(ECO_WEB_SEARCH_MCP_SERVER);
}

export type WebSearchApprovalMode = "always_allow" | "always_ask";

export const WEB_SEARCH_APPROVAL_MODES = ["always_allow", "always_ask"] as const;

export function isWebSearchApprovalMode(value: unknown): value is WebSearchApprovalMode {
  return typeof value === "string" && (WEB_SEARCH_APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * always_allow auto-approves; always_ask shows the same approval card as other tools.
 */
export function shouldAutoApproveEcoWebSearchTools(mode: WebSearchApprovalMode): boolean {
  return mode === "always_allow";
}

/**
 * Web-search tools gated by approvalMode:
 * - Eco integrated MCP tool (`mcp__eco_web_search__search`)
 * - provider-native WebSearch (Claude `WebSearch`; PI `web_search` maps to `WebSearch`)
 */
export function isWebSearchApprovalToolName(toolName: string | undefined): boolean {
  if (!toolName) {
    return false;
  }
  return isEcoWebSearchToolName(toolName) || toolName.trim() === "WebSearch";
}

export function buildIntegratedWebSearchPromptAppend(providerLabel: string): string {
  return [
    "Integrated web search (Eco): search public webpages for current information and reference sources.",
    buildEcoMcpHubToolUsage({ server: ECO_WEB_SEARCH_MCP_SERVER }),
    `Active search provider: ${providerLabel}. Use this integration for web searches in this conversation.`,
  ].join("\n");
}
