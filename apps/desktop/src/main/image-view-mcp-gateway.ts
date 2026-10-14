import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import {
  ECO_IMAGE_VIEW_FULL_TOOL,
  ECO_IMAGE_VIEW_MCP_SERVER,
  ECO_IMAGE_VIEW_TOOL,
  isEcoImageViewToolName,
} from "@eco/runtime";
import { buildImageViewPromptAppend } from "../shared/image-view-tool";
import type { McpSdkConfig } from "../shared/mcp";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import { ImageViewReadError, type ImageViewReadFailureCode, readImageViewFile } from "./image-view-reader";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";

const CONTROL_SECRET_HEADER = "X-Eco-Image-View-Control-Secret";

const IMAGE_VIEW_READ_ERRORS: Record<ImageViewReadFailureCode, string> = {
  invalid_path: "图片路径不是有效的绝对路径。",
  not_found: "文件不存在，或该路径属于远程执行环境，Desktop 无法直接读取。",
  symbolic_link: "为避免读取目标不明确，图片预览不接受符号链接。",
  not_file: "该路径不是常规文件。",
  too_large: "图片超过 20 MB，无法在 Feed 中预览。",
  unsupported_type: "文件内容不是受支持的 PNG、JPEG、GIF、WebP、SVG、ICO 或 BMP 图片。",
};

export interface ImageViewMcpInjection {
  enabled: true;
  serverName: typeof ECO_IMAGE_VIEW_MCP_SERVER;
  sdkEntry: Record<string, unknown>;
  codexServer: CodexMcpServerForConfigSync;
  promptAppend: string;
}

export interface ImageViewAnalyzeInput {
  threadId: string;
  path?: string;
  ref?: string;
  prompt?: string;
  question?: string;
  toolUseId?: string;
  signal?: AbortSignal;
}

export class ImageViewMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(private readonly deps: { analyze(input: ImageViewAnalyzeInput): Promise<string> }) {}

  noteUpcomingTool(threadId: string, toolName?: string, toolUseId?: string): void {
    if (isEcoImageViewToolName(toolName) || toolName?.trim() === ECO_IMAGE_VIEW_TOOL) {
      this.claims.noteUpcoming(threadId, toolName, toolUseId);
    }
  }

  noteThreadPrompt(threadId: string, prompt: string): void {
    void threadId;
    void prompt;
  }

  async resolveGlobalCodexServer(): Promise<CodexMcpServerForConfigSync> {
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_IMAGE_VIEW_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [ECO_IMAGE_VIEW_TOOL],
    });
  }

  async resolveInjection(threadId: string): Promise<ImageViewMcpInjection> {
    await this.start();
    const auth = this.auth.ensure(threadId);
    const http = buildEcoHttpInjection({
      name: ECO_IMAGE_VIEW_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      authToken: auth.token,
      enabledTools: [ECO_IMAGE_VIEW_TOOL],
    });
    return {
      enabled: true,
      serverName: ECO_IMAGE_VIEW_MCP_SERVER,
      sdkEntry: http.sdkEntry,
      codexServer: http.codexServer,
      promptAppend: buildImageViewPromptAppend(),
    };
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: ImageViewMcpInjection): McpSdkConfig {
    return {
      mcpServers: { ...base.mcpServers, [ECO_IMAGE_VIEW_MCP_SERVER]: injection.sdkEntry },
      allowedTools: [...new Set([...base.allowedTools, ECO_IMAGE_VIEW_FULL_TOOL])],
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
    if (!this.port) throw new Error("看图 MCP 控制服务尚未启动。");
    return `http://127.0.0.1:${this.port}`;
  }

  private resolveThread(authToken: string | undefined): { threadId: string; toolUseId?: string } {
    const authenticated = this.auth.resolve(authToken);
    if (authenticated) {
      const claimed = this.claims.claimDetails(ECO_IMAGE_VIEW_TOOL, authenticated.threadId);
      return {
        threadId: authenticated.threadId,
        ...(claimed?.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    const claimed = this.claims.claimDetails(ECO_IMAGE_VIEW_TOOL);
    if (claimed) {
      return {
        threadId: claimed.threadId,
        ...(claimed.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    throw new Error("看图 MCP 无法绑定会话：缺少有效线程令牌或 tool.started claim。");
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = (request.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: ECO_IMAGE_VIEW_MCP_SERVER,
          instructions:
            "Eco local image viewing. Pass an absolute path or durable ref plus a caller-chosen prompt. The tool returns the vision model's text response.",
          listTools: async () => ({ tools: [imageViewToolDefinition()] }),
          callTool: async ({ name, arguments: args, authToken, signal }) =>
            this.executeToolCall(name, args, authToken, signal),
        },
        {
          controlSecretHeader: "x-eco-image-view-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (request.headers["x-eco-image-view-control-secret"] !== this.controlSecret) {
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
        sendJson(response, 200, { tools: [imageViewToolDefinition()] });
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
        result: mcpErrorResult(error instanceof Error ? error.message : String(error), "analyze_failed"),
      });
    }
  }

  private async executeToolCall(
    name: string,
    rawArgs: Record<string, unknown>,
    authToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (name !== ECO_IMAGE_VIEW_TOOL) {
      throw new Error(`未知看图工具：${name}`);
    }
    const claim = this.resolveThread(authToken);
    signal?.throwIfAborted();
    const imagePath = typeof rawArgs.path === "string" ? rawArgs.path.trim() : "";
    const rawReference = rawArgs.ref ?? rawArgs.reference ?? rawArgs.contentRef;
    const reference = typeof rawReference === "string" ? rawReference.trim() : "";
    const prompt = typeof rawArgs.prompt === "string" ? rawArgs.prompt.trim() : "";
    const question = typeof rawArgs.question === "string" ? rawArgs.question.trim() : "";
    if (imagePath && reference) {
      return mcpErrorResult("请只提供图片 path 或 ref 其中一个。", "invalid_image_reference");
    }
    if (!imagePath && !reference) {
      return mcpErrorResult("必须提供图片的绝对 path 或 durable ref。", "invalid_image_reference");
    }
    if (imagePath && !path.isAbsolute(imagePath)) {
      return mcpErrorResult(IMAGE_VIEW_READ_ERRORS.invalid_path, "invalid_path");
    }
    if (reference && !/^sha256:[0-9a-f]{64}$/.test(reference)) {
      return mcpErrorResult("图片 ref 不是有效的 sha256 内容引用。", "invalid_reference");
    }
    if (imagePath) {
      try {
        await readImageViewFile(imagePath);
      } catch (error) {
        if (error instanceof ImageViewReadError) {
          return mcpErrorResult(IMAGE_VIEW_READ_ERRORS[error.code], error.code);
        }
        throw error;
      }
    }

    const analyzeInput: ImageViewAnalyzeInput = {
      threadId: claim.threadId,
      ...(imagePath ? { path: imagePath } : {}),
      ...(reference ? { ref: reference } : {}),
      ...(prompt ? { prompt } : question ? { question } : {}),
      ...(claim.toolUseId && { toolUseId: claim.toolUseId }),
      ...(signal ? { signal } : {}),
    };
    const resultText = await this.deps.analyze({
      ...analyzeInput,
    });
    const { maybeSpillMcpTextContent } = await import("./mcp-tool-result-spill.js");
    const spilled = await maybeSpillMcpTextContent({
      text: resultText,
      serverName: ECO_IMAGE_VIEW_MCP_SERVER,
      toolName: ECO_IMAGE_VIEW_TOOL,
      threadId: claim.threadId,
    });
    return { content: [{ type: "text", text: spilled.text }] };
  }
}

function mcpErrorResult(message: string, code: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "failed", code, message }) }],
    isError: true,
  };
}

function imageViewToolDefinition(): McpToolDefinition {
  return {
    name: ECO_IMAGE_VIEW_TOOL,
    description:
      "Inspect an image with Eco's vision model using a caller-provided prompt. Provide either an absolute local path or a durable ref. The returned text is passed through without a prescribed response format. Keep image bytes out of the main prompt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      anyOf: [{ required: ["path"] }, { required: ["ref"] }],
      properties: {
        path: { type: "string", minLength: 1, description: "Absolute local image path." },
        ref: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
          description: "Durable Composer image reference.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          description: "The caller's complete instruction for inspecting this image.",
        },
        question: {
          type: "string",
          description: "Deprecated alias for prompt, retained for older clients.",
        },
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
    if (total > 1024 * 1024) throw new Error("request too large");
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
