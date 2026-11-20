import {
  ECO_HTML_HOST_FULL_TOOL,
  ECO_HTML_HOST_MCP_SERVER,
  ECO_HTML_HOST_TOOL,
  isEcoHtmlHostToolName,
} from "./mori-html-host-names.js";

export {
  ECO_HTML_HOST_FULL_TOOL,
  ECO_HTML_HOST_MCP_SERVER,
  ECO_HTML_HOST_TOOL,
  isEcoHtmlHostToolName,
} from "./mori-html-host-names.js";

export interface HtmlHostToolCall {
  name: string;
  title?: string;
  pageId?: string;
}

const PI_MCP_PROXY_TOOL_NAMES = new Set(["mcp", "mcpscript", "mcp_tool"]);

export function resolveEcoHtmlHostToolCall(
  toolName: string | undefined,
  input: unknown,
): HtmlHostToolCall | undefined {
  if (isEcoHtmlHostToolName(toolName)) {
    return {
      name: toolName!.trim(),
      ...readHtmlHostToolFields(input),
    };
  }
  const proxy = readPiMcpProxyHtmlHostCall(toolName, input);
  if (!proxy) {
    return undefined;
  }
  return {
    name: proxy.name,
    ...readHtmlHostToolFields(proxy.args ?? input),
  };
}

export function readHtmlHostMetadataFromToolOutput(item: unknown):
  | {
      pageId: string;
      publicUrl: string;
      title?: string;
      expiresAt?: string;
      canExtend?: boolean;
    }
  | undefined {
  if (typeof item === "string") {
    return readHtmlHostFieldsFromResultText(item);
  }
  const text = readMcpToolOutputText(item);
  if (!text) {
    return undefined;
  }
  return readHtmlHostFieldsFromResultText(text);
}

function readHtmlHostToolFields(input: unknown): { title?: string; pageId?: string } {
  if (!input || typeof input !== "object") {
    return {};
  }
  const record = input as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title.trim() : undefined;
  const pageId =
    typeof record.pageId === "string"
      ? record.pageId.trim()
      : typeof record.page_id === "string"
        ? record.page_id.trim()
        : undefined;
  return {
    ...(title ? { title } : {}),
    ...(pageId ? { pageId } : {}),
  };
}

function readHtmlHostFieldsFromResultText(text: string):
  | {
      pageId: string;
      publicUrl: string;
      title?: string;
      expiresAt?: string;
      canExtend?: boolean;
    }
  | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.status === "failed") return undefined;
    const pageId =
      typeof record.pageId === "string"
        ? record.pageId.trim()
        : typeof record.page_id === "string"
          ? record.page_id.trim()
          : "";
    const publicUrl =
      typeof record.publicUrl === "string"
        ? record.publicUrl.trim()
        : typeof record.public_url === "string"
          ? record.public_url.trim()
          : typeof record.url === "string"
            ? record.url.trim()
            : "";
    if (!pageId || !publicUrl) return undefined;
    const title = typeof record.title === "string" ? record.title.trim() : undefined;
    const expiresAt =
      typeof record.expiresAt === "string"
        ? record.expiresAt.trim()
        : typeof record.expires_at === "string"
          ? record.expires_at.trim()
          : undefined;
    const canExtend =
      typeof record.canExtend === "boolean"
        ? record.canExtend
        : typeof record.can_extend === "boolean"
          ? record.can_extend
          : undefined;
    return {
      pageId,
      publicUrl,
      ...(title ? { title } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      ...(canExtend !== undefined ? { canExtend } : {}),
    };
  } catch {
    return undefined;
  }
}

function readPiMcpProxyHtmlHostCall(
  toolName: string | undefined,
  input: unknown,
): { name: string; args?: unknown } | undefined {
  const name = toolName?.trim().toLowerCase() ?? "";
  if (!PI_MCP_PROXY_TOOL_NAMES.has(name) || !input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const tool =
    typeof record.tool === "string"
      ? record.tool
      : typeof record.name === "string"
        ? record.name
        : undefined;
  if (!isEcoHtmlHostToolName(tool)) {
    return undefined;
  }
  return {
    name: tool!,
    args: record.args ?? record.arguments ?? record.input,
  };
}

function readMcpToolOutputText(item: unknown): string | undefined {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  if (typeof record.result === "string") return record.result;
  return undefined;
}
