import path from "node:path";
import {
  ECO_IMAGE_VIEW_FULL_TOOL,
  ECO_IMAGE_VIEW_MCP_SERVER,
  ECO_IMAGE_VIEW_TOOL,
  isEcoImageViewToolName,
} from "./mori-image-view-names.js";

export {
  ECO_IMAGE_VIEW_FULL_TOOL,
  ECO_IMAGE_VIEW_MCP_SERVER,
  ECO_IMAGE_VIEW_TOOL,
  isEcoImageViewToolName,
} from "./mori-image-view-names.js";

const PI_MCP_PROXY_TOOL_NAMES = new Set(["mcp", "mcpscript", "mcp_tool"]);

export function resolveEcoImageViewToolCall(
  toolName: string | undefined,
  input: unknown,
): { name: string; path?: string; ref?: string; prompt?: string } | undefined {
  const directPath = isEcoImageViewToolName(toolName) ? readAbsoluteImagePath(input) : undefined;
  const directRef = isEcoImageViewToolName(toolName) ? readImageReference(input) : undefined;
  const directPrompt = isEcoImageViewToolName(toolName) ? readImageViewPrompt(input) : undefined;
  if (isEcoImageViewToolName(toolName)) {
    return {
      name: toolName!.trim(),
      ...(directPath ? { path: directPath } : {}),
      ...(directRef ? { ref: directRef } : {}),
      ...(directPrompt ? { prompt: directPrompt } : {}),
    };
  }

  const proxy = readPiMcpProxyImageViewCall(toolName, input);
  if (!proxy) {
    return undefined;
  }
  const nestedPath = readAbsoluteImagePath(proxy.args) ?? readAbsoluteImagePath(input);
  const nestedRef = readImageReference(proxy.args) ?? readImageReference(input);
  const nestedPrompt = readImageViewPrompt(proxy.args) ?? readImageViewPrompt(input);
  return {
    name: proxy.name,
    ...(nestedPath ? { path: nestedPath } : {}),
    ...(nestedRef ? { ref: nestedRef } : {}),
    ...(nestedPrompt ? { prompt: nestedPrompt } : {}),
  };
}

export function readImageViewPathFromToolArgs(
  toolName: string | undefined,
  input: unknown,
): string | undefined {
  return resolveEcoImageViewToolCall(toolName, input)?.path;
}

export function readImageViewReferenceFromToolArgs(
  toolName: string | undefined,
  input: unknown,
): string | undefined {
  return resolveEcoImageViewToolCall(toolName, input)?.ref;
}

export function readImageViewPromptFromToolArgs(
  toolName: string | undefined,
  input: unknown,
): string | undefined {
  return resolveEcoImageViewToolCall(toolName, input)?.prompt;
}

/** The caller-chosen instruction whose answer is the tool's returned text. */
export function readImageViewPrompt(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ["prompt", "question"] as const) {
    const raw = input[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * PI's `mcp` / `mcpScript` proxy first probes available servers/tools
 * (`search`, `action`, …) before calling a real MCP tool via `{ tool, args }`.
 */
export function resolvePiMcpProxyDiscoveryCall(
  toolName: string | undefined,
  input: unknown,
): { kind: "search" } | undefined {
  const proxyName = toolName?.trim().toLowerCase() ?? "";
  if (!PI_MCP_PROXY_TOOL_NAMES.has(proxyName) || !isRecord(input)) {
    return undefined;
  }
  const tool = typeof input.tool === "string" ? input.tool.trim() : "";
  if (tool) {
    return undefined;
  }
  return { kind: "search" };
}

function readPiMcpProxyImageViewCall(
  toolName: string | undefined,
  input: unknown,
): { name: string; args?: Record<string, unknown> } | undefined {
  const proxyName = toolName?.trim().toLowerCase() ?? "";
  if (!PI_MCP_PROXY_TOOL_NAMES.has(proxyName) || !isRecord(input)) {
    return undefined;
  }
  const tool = typeof input.tool === "string" ? input.tool.trim() : "";
  if (!tool) {
    return undefined;
  }
  const server = typeof input.server === "string" ? input.server.trim() : "";
  const reconstructed = server ? `mcp__${server}__${tool}` : tool;
  const isViewImage =
    isEcoImageViewToolName(reconstructed) ||
    isEcoImageViewToolName(tool) ||
    (tool.toLowerCase() === ECO_IMAGE_VIEW_TOOL &&
      (!server || server.toLowerCase().includes(ECO_IMAGE_VIEW_MCP_SERVER)));
  if (!isViewImage) {
    return undefined;
  }
  const args = readRecord(input.args) ?? readRecord(input.arguments);
  return {
    name:
      isEcoImageViewToolName(reconstructed) && reconstructed.startsWith("mcp__")
        ? reconstructed
        : ECO_IMAGE_VIEW_FULL_TOOL,
    ...(args ? { args } : {}),
  };
}

function readAbsoluteImagePath(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const raw = input.path;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return undefined;
  return trimmed;
}

function readImageReference(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const raw = input.ref ?? input.reference ?? input.contentRef;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return /^sha256:[0-9a-f]{64}$/.test(trimmed) ? trimmed : undefined;
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
