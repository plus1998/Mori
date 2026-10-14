import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import {
  ECO_IMAGE_DISPLAY_FULL_TOOL,
  ECO_IMAGE_DISPLAY_MCP_SERVER,
  ECO_IMAGE_DISPLAY_TOOL,
  isEcoImageDisplayToolName,
} from "@eco/runtime";
import type { ImageDisplayArtifact, ImageDisplayToolInput } from "../shared/image-display";
import { buildImageDisplayPromptAppend } from "../shared/image-display-tool";
import type { McpSdkConfig } from "../shared/mcp";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import { ImageDisplayError, ImageDisplayStore, normalizeImageDisplayToolInput } from "./image-display-store";
import { ImageViewReadError } from "./image-view-reader";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";

const CONTROL_SECRET_HEADER = "X-Eco-Image-Display-Control-Secret";

const DISPLAY_ERRORS: Record<string, string> = {
  invalid_source: "source 必须是 path、url 或 base64。",
  invalid_path: "path 必须是绝对路径。",
  invalid_url: "url 必须是 HTTPS 地址。",
  invalid_data: "base64 来源需要提供有效的 data。",
  invalid_mime: "mimeType 必须是 image/*。",
  not_found: "图片展示产物不存在。",
  too_large: "图片超过 20 MB，无法在 Feed 中预览。",
  unsupported_type: "文件内容不是受支持的 PNG、JPEG、GIF、WebP、SVG、ICO 或 BMP 图片。",
  load_failed: "读取或下载图片失败。",
};

export interface ImageDisplayMcpInjection {
  enabled: true;
  serverName: typeof ECO_IMAGE_DISPLAY_MCP_SERVER;
  sdkEntry: Record<string, unknown>;
  codexServer: CodexMcpServerForConfigSync;
  promptAppend: string;
}

export interface ImageDisplayGatewayDeps {
  store: ImageDisplayStore;
  onArtifactChanged(artifact: ImageDisplayArtifact): void;
}

export class ImageDisplayMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(private readonly deps: ImageDisplayGatewayDeps) {}

  noteUpcomingTool(threadId: string, toolName?: string, toolUseId?: string): void {
    if (isEcoImageDisplayToolName(toolName) || toolName?.trim() === ECO_IMAGE_DISPLAY_TOOL) {
      this.claims.noteUpcoming(threadId, toolName, toolUseId);
    }
  }

  async resolveGlobalCodexServer(): Promise<CodexMcpServerForConfigSync> {
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_IMAGE_DISPLAY_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [ECO_IMAGE_DISPLAY_TOOL],
    });
  }

  async resolveInjection(threadId: string): Promise<ImageDisplayMcpInjection> {
    await this.start();
    const auth = this.auth.ensure(threadId);
    const http = buildEcoHttpInjection({
      name: ECO_IMAGE_DISPLAY_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      authToken: auth.token,
      enabledTools: [ECO_IMAGE_DISPLAY_TOOL],
    });
    return {
      enabled: true,
      serverName: ECO_IMAGE_DISPLAY_MCP_SERVER,
      sdkEntry: http.sdkEntry,
      codexServer: http.codexServer,
      promptAppend: buildImageDisplayPromptAppend(),
    };
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: ImageDisplayMcpInjection): McpSdkConfig {
    return {
      mcpServers: { ...base.mcpServers, [ECO_IMAGE_DISPLAY_MCP_SERVER]: injection.sdkEntry },
      allowedTools: [...new Set([...base.allowedTools, ECO_IMAGE_DISPLAY_FULL_TOOL])],
    };
  }

  disposeThread(threadId: string): void {
    this.auth.revokeThread(threadId);
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.port = undefined;
  }

  private async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(0, "127.0.0.1", resolve);
      this.server!.once("error", reject);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  private get controlBaseUrl(): string {
    if (!this.port) throw new Error("图片展示 MCP 控制服务尚未启动。");
    return `http://127.0.0.1:${this.port}`;
  }

  private resolveThread(authToken: string | undefined): { threadId: string; toolUseId?: string } {
    const authenticated = this.auth.resolve(authToken);
    if (authenticated) {
      const claimed = this.claims.claimDetails(ECO_IMAGE_DISPLAY_TOOL, authenticated.threadId);
      return {
        threadId: authenticated.threadId,
        ...(claimed?.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    const claimed = this.claims.claimDetails(ECO_IMAGE_DISPLAY_TOOL);
    if (claimed) {
      return {
        threadId: claimed.threadId,
        ...(claimed.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    throw new Error("图片展示 MCP 无法绑定会话：缺少有效线程令牌或 tool.started claim。");
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = (request.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: ECO_IMAGE_DISPLAY_MCP_SERVER,
          instructions:
            "Eco image display for the user. Stores images as feed artifacts; returns artifactId text.",
          listTools: async () => ({ tools: [imageDisplayToolDefinition()] }),
          callTool: async ({ name, arguments: args, authToken, signal }) =>
            this.executeToolCall(name, args, authToken, signal),
        },
        {
          controlSecretHeader: "x-eco-image-display-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (request.headers["x-eco-image-display-control-secret"] !== this.controlSecret) {
      sendJson(response, 401, { error: "unauthorized control secret" });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method not allowed" });
      return;
    }
    const body = await readJsonBody(request).catch((error) => ({ __error: String(error) }));
    if ("__error" in body) {
      sendJson(response, 400, { error: body.__error });
      return;
    }
    const bearer =
      typeof request.headers.authorization === "string" &&
      request.headers.authorization.toLowerCase().startsWith("bearer ")
        ? request.headers.authorization.slice(7).trim()
        : undefined;
    const authToken = typeof body.authToken === "string" ? body.authToken : bearer;
    try {
      if (request.url === "/v1/tools/list") {
        sendJson(response, 200, { tools: [imageDisplayToolDefinition()] });
        return;
      }
      if (request.url !== "/v1/tools/call") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      const name = typeof body.name === "string" ? body.name : "";
      const rawArgs = isRecord(body.arguments) ? body.arguments : {};
      const result = await this.executeToolCall(name, rawArgs, authToken);
      sendJson(response, 200, { result });
    } catch (error) {
      sendJson(response, 200, {
        result: mcpErrorResult(error instanceof Error ? error.message : String(error), "display_failed"),
      });
    }
  }

  private async executeToolCall(
    name: string,
    rawArgs: Record<string, unknown>,
    authToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (name !== ECO_IMAGE_DISPLAY_TOOL) {
      throw new Error(`未知图片展示工具：${name}`);
    }
    const claim = this.resolveThread(authToken);
    signal?.throwIfAborted();
    let toolInput: ImageDisplayToolInput;
    try {
      toolInput = normalizeImageDisplayToolInput(rawArgs as unknown as ImageDisplayToolInput);
    } catch (error) {
      const code = error instanceof ImageDisplayError ? error.code : "invalid_source";
      return mcpErrorResult(DISPLAY_ERRORS[code] ?? String(error), code);
    }
    try {
      const artifact = await this.deps.store.ingestFromToolInput({
        threadId: claim.threadId,
        ...(claim.toolUseId ? { toolUseId: claim.toolUseId } : {}),
        toolInput,
        ...(signal ? { signal } : {}),
      });
      this.deps.onArtifactChanged(artifact);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "ok" }),
          },
        ],
      };
    } catch (error) {
      const code =
        error instanceof ImageDisplayError
          ? error.code
          : error instanceof ImageViewReadError
            ? error.code
            : "load_failed";
      return mcpErrorResult(DISPLAY_ERRORS[code] ?? String(error), code);
    }
  }
}

function mcpErrorResult(message: string, code: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "failed", code, message }) }],
    isError: true,
  };
}

function imageDisplayToolDefinition(): McpToolDefinition {
  return {
    name: ECO_IMAGE_DISPLAY_TOOL,
    description:
      "Display an image to the user. On success returns { status: \"ok\" }. Eco places it in the workspace cards / task panel — tell the user to open it there. Do not embed Markdown image links or paste base64 into replies.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["source"],
      properties: {
        source: {
          type: "string",
          enum: ["path", "url", "base64"],
          description: "Image source kind.",
        },
        path: { type: "string", description: "Absolute local path when source=path." },
        url: { type: "string", description: "HTTPS URL when source=url." },
        data: { type: "string", description: "Base64 payload when source=base64." },
        mimeType: { type: "string", description: "Optional MIME type for base64 input." },
        title: { type: "string", description: "Optional caption shown in the feed." },
      },
    },
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 4 * 1024 * 1024) throw new Error("request too large");
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  if (!isRecord(parsed)) throw new Error("invalid json object");
  return parsed;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
