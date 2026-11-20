import { normalizeStoredMoriMcpName } from "@eco/shared";
/**
 * Pi runtime MCP proxy resolution — legacy replay only.
 *
 * Up to PI 0.85.1 Eco injected MCP through `pi-mcp-adapter`, which did not
 * register each MCP server's tools as direct tools: the agent called one `mcp`
 * gateway tool (`mcpScript` for batch scripts) with `{ tool, args, server? }`,
 * so the runtime event stream reported `tool_name: "mcp"` / `"mcpScript"`.
 *
 * PI 1.0.3 exposes the real tools (`mcp__mori_mcp__search_tools` /
 * `mcp__mori_mcp__call_tool`, plus each server's own tools), so new turns never
 * produce those names. The resolver stays to keep historical JSONL replay
 * readable, where re-resolving the target tool is what stops the activity feed
 * from showing every Eco integration (browser operations, computer use, image
 * creation, …) as a generic "calling MCP tool" line.
 */

import { ECO_HTML_HOST_MCP_SERVER } from "@eco/runtime/mori-html-host-names";
import { ECO_IMAGE_DISPLAY_MCP_SERVER } from "@eco/runtime/mori-image-display-names";
import { ECO_IMAGE_VIEW_MCP_SERVER } from "@eco/runtime/mori-image-view-names";
import { resolveEcoMcpHubToolCall } from "@eco/runtime/mori-mcp-hub-tool";
import { ECO_AGENT_BROWSER_MCP_SERVER } from "./browser";
import { ECO_COMPUTER_USE_MCP_SERVER } from "./computer-use";
import { ECO_IMAGE_GENERATION_MCP_SERVER } from "./image-generation";
import { ECO_WEB_SEARCH_MCP_SERVER } from "./integrated-web-search";

const PI_MCP_PROXY_TOOL_NAMES = new Set(["mcp", "mcpscript", "mcp_tool"]);

/** Eco integration server ids, longest first so prefix stripping is unambiguous. */
const ECO_INTEGRATED_MCP_SERVERS = [
  "mori_mcp",
  ECO_IMAGE_GENERATION_MCP_SERVER, // mori_image_generation
  ECO_IMAGE_DISPLAY_MCP_SERVER, // mori_image_display
  ECO_COMPUTER_USE_MCP_SERVER, // mori_computer_use
  ECO_HTML_HOST_MCP_SERVER, // mori_html_host
  ECO_AGENT_BROWSER_MCP_SERVER, // mori_agent_browser
  ECO_IMAGE_VIEW_MCP_SERVER, // mori_image_view
  ECO_WEB_SEARCH_MCP_SERVER, // mori_web_search
].sort((a, b) => b.length - a.length);

export interface PiMcpProxyCall {
  /** Tool token exactly as the agent wrote it (may include a server prefix). */
  tool: string;
  /** Explicit server disambiguator from the proxy input, when present. */
  server?: string;
  /** Nested tool arguments (mcpScript calls carry none here). */
  args?: Record<string, unknown>;
}

/** True for Pi's `mcp` / `mcpScript` / `mcp_tool` gateway tools. */
export function isPiMcpProxyToolName(toolName: string | undefined): boolean {
  const name = toolName?.trim().toLowerCase() ?? "";
  return PI_MCP_PROXY_TOOL_NAMES.has(name);
}

/**
 * Resolve which real MCP tool a Pi proxy invocation targets.
 *
 * - `mcp({ tool: "mori_agent_browser.agent_browser_open", args: {...} })`
 * - `mcp({ tool: "create_image", server: "mori_image_generation", args: {...} })`
 * - `mcpScript({ code: "await tools.mori_image_generation_create_image({...})" })`
 *
 * Returns undefined for gateway probes without a single target (`mcp({})`,
 * `search`, `describe`, `connect`, `server` listings, …).
 */
export function resolvePiMcpProxyCall(
  toolName: string | undefined,
  input: unknown,
): PiMcpProxyCall | undefined {
  const proxyName = toolName?.trim().toLowerCase() ?? "";
  if (!isPiMcpProxyToolName(toolName) || !isRecord(input)) {
    return undefined;
  }
  if (proxyName === "mcpscript") {
    const code = typeof input.code === "string" ? input.code : "";
    const match = code.match(/\btools\.([A-Za-z][A-Za-z0-9_]*)\s*\(/);
    if (!match?.[1]) {
      return undefined;
    }
    return { tool: match[1] };
  }
  const tool = typeof input.tool === "string" ? input.tool.trim() : "";
  if (!tool) {
    return undefined;
  }
  const server = typeof input.server === "string" ? input.server.trim() : "";
  const args = readRecord(input.args) ?? readRecord(input.arguments);
  const rawCall: PiMcpProxyCall = {
    tool,
    ...(server ? { server } : {}),
    ...(args ? { args } : {}),
  };
  // Pi may expose Eco's Hub through its own `mcp` proxy. Resolve the nested
  // `call_tool({ name, arguments })` here so all downstream activity metadata
  // sees the actual integration tool and its arguments.
  const wrapperName = resolvePiMcpProxyBaseToolName(rawCall);
  const hubCall = wrapperName ? resolveEcoMcpHubToolCall(wrapperName, args) : undefined;
  return hubCall
    ? {
        tool: hubCall.name,
        ...(hubCall.args ? { args: hubCall.args } : {}),
      }
    : rawCall;
}

/**
 * Canonical tool name for feed classification: `mcp__<server>__<tool>` when the
 * server is resolvable (explicit `server` field or known Eco integration
 * prefix). Returns undefined when the target stays anonymous — callers then
 * keep the generic proxy name so the feed shows a plain "MCP tool" line.
 */
export function resolvePiMcpProxyToolName(toolName: string | undefined, input: unknown): string | undefined {
  const call = resolvePiMcpProxyCall(toolName, input);
  if (!call) {
    return undefined;
  }
  const token = normalizeToolToken(call.tool);
  if (call.server) {
    const server = normalizeToolToken(call.server);
    return `mcp__${server}__${stripServerPrefix(token, server)}`;
  }
  if (token.startsWith("mcp__")) {
    return token;
  }
  for (const server of ECO_INTEGRATED_MCP_SERVERS) {
    const leaf = stripServerPrefix(token, server);
    if (leaf !== token) {
      return `mcp__${server}__${leaf}`;
    }
  }
  return undefined;
}

function resolvePiMcpProxyBaseToolName(call: PiMcpProxyCall): string | undefined {
  const token = normalizeToolToken(call.tool);
  if (call.server) {
    const server = normalizeToolToken(call.server);
    return `mcp__${server}__${stripServerPrefix(token, server)}`;
  }
  if (token.startsWith("mcp__")) {
    return token;
  }
  for (const server of ECO_INTEGRATED_MCP_SERVERS) {
    const leaf = stripServerPrefix(token, server);
    if (leaf !== token) {
      return `mcp__${server}__${leaf}`;
    }
  }
  return undefined;
}

function normalizeToolToken(value: string): string {
  return normalizeStoredMoriMcpName(value.trim().toLowerCase().replace(/-/g, "_"));
}

function stripServerPrefix(token: string, server: string): string {
  if (token === server) {
    return token;
  }
  const underscore = `${server}_`;
  if (token.startsWith(underscore)) {
    return token.slice(underscore.length);
  }
  const dot = `${server}.`;
  if (token.startsWith(dot)) {
    return token.slice(dot.length).replace(/\./g, "_");
  }
  return token;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
