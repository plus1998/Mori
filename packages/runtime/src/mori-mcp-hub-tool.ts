/**
 * Runtime-side decoding for Eco's fixed MCP Hub wrapper.
 *
 * A Hub session exposes only `search_tools` and `call_tool`.  Activity
 * rendering still needs the nested canonical id (`eco_server:tool`) so it can
 * show the actual operation instead of the wrapper name.
 */

import { MORI_MCP_HUB_SERVER, normalizeStoredMoriMcpName } from "@eco/shared";

export const ECO_MCP_HUB_MCP_SERVER = MORI_MCP_HUB_SERVER;
export const ECO_MCP_HUB_SEARCH_TOOL = "search_tools";
export const ECO_MCP_HUB_CALL_TOOL = "call_tool";

export const ECO_MCP_HUB_SEARCH_FULL_TOOL =
  `mcp__${ECO_MCP_HUB_MCP_SERVER}__${ECO_MCP_HUB_SEARCH_TOOL}`;
export const ECO_MCP_HUB_CALL_FULL_TOOL =
  `mcp__${ECO_MCP_HUB_MCP_SERVER}__${ECO_MCP_HUB_CALL_TOOL}`;

export interface EcoMcpHubToolCall {
  /** Canonical runtime name, e.g. `mcp__mori_image_view__view_image`. */
  name: string;
  /** Arguments for the nested tool, not the Hub wrapper arguments. */
  args?: Record<string, unknown>;
}

export interface EcoMcpHubSearchCall {
  query?: string;
}

/**
 * Namespaced wrapper names as the Codex app-server runtime exposes them:
 * `mcp__<server>__<tool>`. The server part is either the fixed `mori_mcp` or
 * the per-thread runtime name `mori_mcp_<hash>_<threadSuffix>` that the
 * desktop main process derives from the thread id for Codex sessions
 * (`codexHubServerName`). The suffix is a sequence of `_`-prefixed
 * alphanumeric chunks, so match it structurally instead of with an exact
 * string.
 */
const HUB_NAMESPACED_WRAPPER_PATTERN =
  /^mcp__mori_mcp(?:_[a-z0-9_-]+)?__(search_tools|call_tool)$/;

function hubWrapperToolInNamespacedName(normalized: string): string | undefined {
  return HUB_NAMESPACED_WRAPPER_PATTERN.exec(normalized)?.[1];
}

/** True for the fixed Hub `call_tool` wrapper name. */
export function isEcoMcpHubCallToolName(toolName: string | undefined): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    // `ECO_MCP_HUB_CALL_FULL_TOOL` (`mcp__mori_mcp__call_tool`) is the zero-chunk
    // case of the namespaced pattern below.
    normalized === `${ECO_MCP_HUB_MCP_SERVER}_${ECO_MCP_HUB_CALL_TOOL}` ||
    hubWrapperToolInNamespacedName(normalized) === ECO_MCP_HUB_CALL_TOOL
  );
}

/** True for the fixed Hub `search_tools` wrapper name. */
export function isEcoMcpHubSearchToolName(toolName: string | undefined): boolean {
  const normalized = normalizeToolName(toolName);
  return (
    // `ECO_MCP_HUB_SEARCH_FULL_TOOL` is the zero-chunk case of the pattern.
    normalized === `${ECO_MCP_HUB_MCP_SERVER}_${ECO_MCP_HUB_SEARCH_TOOL}` ||
    hubWrapperToolInNamespacedName(normalized) === ECO_MCP_HUB_SEARCH_TOOL
  );
}

/**
 * Resolve a Hub call into the nested canonical MCP tool id and its arguments.
 * The model-facing protocol uses `name: "server:tool"` and `arguments: {}`.
 */
export function resolveEcoMcpHubToolCall(
  toolName: string | undefined,
  input: unknown,
): EcoMcpHubToolCall | undefined {
  if (!isEcoMcpHubCallToolName(toolName)) {
    return undefined;
  }
  const record = readRecord(input);
  if (!record) {
    return undefined;
  }
  const nestedName =
    readString(record.name) ??
    readString(record.tool_id) ??
    readString(record.toolId) ??
    readString(record.tool_name);
  const name = canonicalNestedToolName(nestedName);
  if (!name) {
    return undefined;
  }
  const args = readRecord(record.arguments) ?? readRecord(record.args) ?? readRecord(record.input);
  return {
    name,
    ...(args ? { args } : {}),
  };
}

/** Resolve a Hub search call so feeds can render “查找 MCP 工具”. */
export function resolveEcoMcpHubSearchCall(
  toolName: string | undefined,
  input: unknown,
): EcoMcpHubSearchCall | undefined {
  if (!isEcoMcpHubSearchToolName(toolName)) {
    return undefined;
  }
  const record = readRecord(input);
  if (!record) {
    return {};
  }
  const query = readString(record.query) ?? readString(record.detail);
  return query ? { query } : {};
}

function canonicalNestedToolName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("mcp__")) {
    return normalizeStoredMoriMcpName(trimmed);
  }
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator >= trimmed.length - 1) {
    return undefined;
  }
  const server = normalizeStoredMoriMcpName(normalizeServerName(trimmed.slice(0, separator)));
  const tool = trimmed.slice(separator + 1).trim();
  return server && tool ? `mcp__${server}__${tool}` : undefined;
}

function normalizeToolName(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  return normalizeStoredMoriMcpName(normalized.replace(/^eco_eco_mcp_/, "eco_mcp_"));
}

function normalizeServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
