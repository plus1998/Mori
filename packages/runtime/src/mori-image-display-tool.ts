import path from "node:path";
import {
  ECO_IMAGE_DISPLAY_FULL_TOOL,
  ECO_IMAGE_DISPLAY_MCP_SERVER,
  ECO_IMAGE_DISPLAY_TOOL,
  isEcoImageDisplayToolName,
} from "./mori-image-display-names.js";
import { readMcpToolOutputText } from "./mcp-tool-output-text.js";

export {
  ECO_IMAGE_DISPLAY_FULL_TOOL,
  ECO_IMAGE_DISPLAY_MCP_SERVER,
  ECO_IMAGE_DISPLAY_TOOL,
  isEcoImageDisplayToolName,
} from "./mori-image-display-names.js";

export type ImageDisplaySourceKind = "path" | "url" | "base64";

export interface ImageDisplayToolCall {
  name: string;
  source?: ImageDisplaySourceKind;
  artifactId?: string;
}

const PI_MCP_PROXY_TOOL_NAMES = new Set(["mcp", "mcpscript", "mcp_tool"]);

export function resolveEcoImageDisplayToolCall(
  toolName: string | undefined,
  input: unknown,
): ImageDisplayToolCall | undefined {
  if (isEcoImageDisplayToolName(toolName)) {
    return {
      name: toolName!.trim(),
      ...readImageDisplayToolFields(input),
    };
  }
  const proxy = readPiMcpProxyImageDisplayCall(toolName, input);
  if (!proxy) {
    return undefined;
  }
  return {
    name: proxy.name,
    ...readImageDisplayToolFields(proxy.args ?? input),
  };
}

export function readImageDisplayArtifactFromToolOutput(item: unknown): string | undefined {
  return readImageDisplayMetadataFromToolOutput(item)?.artifactId;
}

export function readImageDisplayMetadataFromToolOutput(
  item: unknown,
): { artifactId: string; title?: string } | undefined {
  if (typeof item === "string") {
    return readImageDisplayFieldsFromResultText(item);
  }
  const text = readMcpToolOutputText(item);
  if (!text) {
    return undefined;
  }
  return readImageDisplayFieldsFromResultText(text);
}

export function readAbsolutePathFromMcpToolOutput(item: unknown): string | undefined {
  const text = readMcpToolOutputText(item);
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed && isAbsoluteImagePath(trimmed)) {
    return trimmed;
  }
  for (const line of trimmed.split(/\r?\n/u)) {
    const candidate = line.trim();
    if (candidate && isAbsoluteImagePath(candidate)) {
      return candidate;
    }
  }
  const match = trimmed.match(/(?:^|[\s"'(])((?:\/[^\s"'()]+)|(?:[A-Za-z]:\\[^\s"'()]+))/u);
  return match?.[1]?.trim();
}

function isAbsoluteImagePath(candidate: string): boolean {
  if (path.isAbsolute(candidate)) {
    return true;
  }
  return candidate.startsWith("/") && !candidate.startsWith("//");
}

export function isAgentBrowserScreenshotToolName(toolName: string | undefined): boolean {
  const name = toolName?.trim().toLowerCase() ?? "";
  if (!name) return false;
  return name.endsWith("__agent_browser_screenshot") || name === "agent_browser_screenshot";
}

function readImageDisplayToolFields(input: unknown): Pick<ImageDisplayToolCall, "source"> {
  if (!isRecord(input)) {
    return {};
  }
  const source = readSourceKind(input.source);
  return source ? { source } : {};
}

function readPiMcpProxyImageDisplayCall(
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
  const isDisplayImage =
    isEcoImageDisplayToolName(reconstructed) ||
    isEcoImageDisplayToolName(tool) ||
    (tool.toLowerCase() === ECO_IMAGE_DISPLAY_TOOL &&
      (!server || server.toLowerCase().includes(ECO_IMAGE_DISPLAY_MCP_SERVER)));
  if (!isDisplayImage) {
    return undefined;
  }
  const args = readRecord(input.args) ?? readRecord(input.arguments);
  return {
    name:
      isEcoImageDisplayToolName(reconstructed) && reconstructed.startsWith("mcp__")
        ? reconstructed
        : ECO_IMAGE_DISPLAY_FULL_TOOL,
    ...(args ? { args } : {}),
  };
}

function readSourceKind(value: unknown): ImageDisplaySourceKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "path" || normalized === "url" || normalized === "base64") {
    return normalized;
  }
  return undefined;
}

function readImageDisplayFieldsFromResultText(
  text: string,
): { artifactId: string; title?: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      const artifactId =
        typeof parsed.artifactId === "string" ? parsed.artifactId.trim() : "";
      if (artifactId) {
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        return { artifactId, ...(title ? { title } : {}) };
      }
    }
  } catch {
    // fall through
  }
  const match = trimmed.match(/"artifactId"\s*:\s*"([^"]+)"/u);
  const artifactId = match?.[1]?.trim();
  if (!artifactId) {
    return undefined;
  }
  const titleMatch = trimmed.match(/"title"\s*:\s*"((?:\\.|[^"\\])*)"/u);
  const title = titleMatch?.[1]?.replace(/\\"/gu, '"').trim();
  return { artifactId, ...(title ? { title } : {}) };
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
