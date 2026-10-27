import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import type { GenerationExecutionContext } from "../shared/generation-tools";
import {
  buildImageGenerationPromptAppend,
  ECO_IMAGE_GENERATION_FULL_TOOL,
  ECO_IMAGE_GENERATION_MCP_SERVER,
  ECO_IMAGE_GENERATION_TOOL,
  IMAGE_GENERATION_CODEX_TOOL_TIMEOUT_SEC,
  IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS,
  type ImageGenerationArtifact,
  ImageGenerationError,
  type ImageGenerationToolInput,
} from "../shared/image-generation";
import type { McpSdkConfig } from "../shared/mcp";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import { generateImagesToWorkspace, normalizeImageGenerationToolInput } from "./image-generation-client";
import type { ImageGenerationStore } from "./image-generation-store";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";

const CONTROL_SECRET_HEADER = "X-Eco-Image-Control-Secret";

export interface ImageGenerationMcpInjection {
  enabled: boolean;
  serverName: typeof ECO_IMAGE_GENERATION_MCP_SERVER;
  sdkEntry?: Record<string, unknown>;
  codexServer?: CodexMcpServerForConfigSync;
  promptAppend?: string;
  unavailableReason?: string;
}

export interface ImageGenerationGatewayDeps {
  generateCodex?: Parameters<typeof generateImagesToWorkspace>[0]["generateCodex"];
  store: ImageGenerationStore;
  resolveWorkspacePath(threadId: string): string | undefined;
  resolveGenerationRoot(threadId: string): string | undefined;
  onArtifactChanged(artifact: ImageGenerationArtifact): void;
}

export class ImageGenerationMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(private readonly deps: ImageGenerationGatewayDeps) {}

  noteUpcomingTool(threadId: string, toolName?: string, toolUseId?: string): void {
    if (
      toolName?.includes(ECO_IMAGE_GENERATION_MCP_SERVER) ||
      toolName?.includes(ECO_IMAGE_GENERATION_TOOL)
    ) {
      this.claims.noteUpcoming(threadId, toolName, toolUseId);
    }
  }

  /** Stable process-global definition written to Codex config.toml. */
  async resolveGlobalCodexServer(): Promise<CodexMcpServerForConfigSync | undefined> {
    if (!this.deps.store.getSettings().enabled) {
      return undefined;
    }
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_IMAGE_GENERATION_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [ECO_IMAGE_GENERATION_TOOL],
      toolTimeoutSec: IMAGE_GENERATION_CODEX_TOOL_TIMEOUT_SEC,
    });
  }

  async resolveInjection(input: {
    threadId: string;
    sessionEnabled: boolean;
  }): Promise<ImageGenerationMcpInjection> {
    const settings = this.deps.store.getSettings();
    if (!settings.enabled || !input.sessionEnabled) {
      return { enabled: false, serverName: ECO_IMAGE_GENERATION_MCP_SERVER };
    }
    try {
      const config = this.deps.store.getActiveClientConfig();
      const globalCodexServer = await this.resolveGlobalCodexServer();
      if (!globalCodexServer) {
        return { enabled: false, serverName: ECO_IMAGE_GENERATION_MCP_SERVER };
      }
      const auth = this.auth.ensure(input.threadId);
      const http = buildEcoHttpInjection({
        name: ECO_IMAGE_GENERATION_MCP_SERVER,
        controlBaseUrl: this.controlBaseUrl,
        controlSecretHeader: CONTROL_SECRET_HEADER,
        controlSecret: this.controlSecret,
        authToken: auth.token,
        enabledTools: [ECO_IMAGE_GENERATION_TOOL],
        toolTimeoutSec: IMAGE_GENERATION_CODEX_TOOL_TIMEOUT_SEC,
      });
      return {
        enabled: true,
        serverName: ECO_IMAGE_GENERATION_MCP_SERVER,
        sdkEntry: {
          ...http.sdkEntry,
          // Claude Agent SDK: per-server tool-call wall clock (default ~60s via MCP_TOOL_TIMEOUT).
          timeout: IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS,
          // PI MCP extension: toPiMcpServerConfig prefers requestTimeoutMs and converts it to seconds.
          requestTimeoutMs: IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS,
        },
        codexServer: http.codexServer,
        promptAppend: buildImageGenerationPromptAppend(config),
      };
    } catch (error) {
      return {
        enabled: false,
        serverName: ECO_IMAGE_GENERATION_MCP_SERVER,
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: ImageGenerationMcpInjection): McpSdkConfig {
    if (!injection.enabled || !injection.sdkEntry) return base;
    return {
      mcpServers: { ...base.mcpServers, [ECO_IMAGE_GENERATION_MCP_SERVER]: injection.sdkEntry },
      // Intentionally omit from allowedTools: every call must reach Eco's approval UI.
      allowedTools: base.allowedTools.filter((tool) => tool !== ECO_IMAGE_GENERATION_FULL_TOOL),
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
    if (!this.port) throw new Error("创意绘画 MCP 控制服务尚未启动。");
    return `http://127.0.0.1:${this.port}`;
  }

  private resolveThread(authToken: string | undefined): { threadId: string; toolUseId?: string } {
    const authenticated = this.auth.resolve(authToken);
    if (authenticated) {
      const claimed = this.claims.claimDetails(ECO_IMAGE_GENERATION_TOOL, authenticated.threadId);
      return {
        threadId: authenticated.threadId,
        ...(claimed?.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    const claimed = this.claims.claimDetails(ECO_IMAGE_GENERATION_TOOL);
    if (claimed) {
      return {
        threadId: claimed.threadId,
        ...(claimed.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    throw new Error("创意绘画 MCP 无法绑定会话：缺少有效线程令牌或 tool.started claim。");
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = (request.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: ECO_IMAGE_GENERATION_MCP_SERVER,
          instructions:
            "Mori Creative Drawing. Create or edit images into the conversation work directory; every call requires user approval.",
          listTools: async () => ({ tools: [imageGenerationToolDefinition()] }),
          callTool: async ({ name, arguments: args, authToken, signal }) =>
            this.executeToolCall(name, args, authToken, signal),
        },
        {
          controlSecretHeader: "x-eco-image-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (request.headers["x-eco-image-control-secret"] !== this.controlSecret) {
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
        sendJson(response, 200, { tools: [imageGenerationToolDefinition()] });
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
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async executeToolCall(
    name: string,
    rawArgs: Record<string, unknown>,
    authToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (name !== ECO_IMAGE_GENERATION_TOOL) {
      throw new Error(`未知创意绘画工具：${name}`);
    }
    const claim = this.resolveThread(authToken);
    const threadId = claim.threadId;
    const workspacePath = this.deps.resolveWorkspacePath(threadId)?.trim();
    const generationRoot = this.deps.resolveGenerationRoot(threadId)?.trim();
    if (!workspacePath || !generationRoot) {
      throw new Error("创意绘画会话缺少 workspace 或运行目录。");
    }
    const result = await this.generate(
      { ...claim, workspacePath, generationRoot },
      rawArgs as unknown as ImageGenerationToolInput,
      { ...(signal ? { signal } : {}) },
    );
    const { artifact, providerStatus, requestId } = result;
    const structuredContent =
      artifact.status === "failed"
        ? {
            status: "failed",
            artifactId: artifact.id,
            code: artifact.errorCode,
            message: artifact.errorMessage,
            partialImages: artifact.images,
          }
        : {
            status: "completed",
            artifactId: artifact.id,
            provider: artifact.provider,
            model: artifact.model,
            images: artifact.images,
          };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              ...structuredContent,
              ...(providerStatus ? { providerStatus } : {}),
              ...(requestId ? { requestId } : {}),
            },
            null,
            2,
          ),
        },
      ],
      ...(artifact.status === "failed" ? { isError: true } : {}),
      structuredContent,
    };
  }

  /** Shared generation path for MCP and the explicit desktop tool form. */
  async generate(
    context: GenerationExecutionContext,
    rawInput: ImageGenerationToolInput,
    options: { signal?: AbortSignal; profileId?: string; profileUpdatedAt?: string } = {},
  ): Promise<{ artifact: ImageGenerationArtifact; providerStatus?: number; requestId?: string }> {
    const { threadId, workspacePath, generationRoot, toolUseId } = context;
    const { signal } = options;
    signal?.throwIfAborted();
    if (!this.deps.store.getSettings().enabled) throw new Error("创意绘画集成已关闭。");
    const config = this.deps.store.getActiveClientConfig();
    const currentProfile = options.profileUpdatedAt
      ? this.deps.store.getSettings().profiles.find((profile) => profile.id === config.profileId)
      : undefined;
    if (
      (options.profileId && options.profileId !== config.profileId) ||
      (options.profileUpdatedAt && options.profileUpdatedAt !== currentProfile?.updatedAt)
    ) {
      throw new Error("生成配置已改变，请刷新工具后重试。");
    }
    const normalized = normalizeImageGenerationToolInput(rawInput, config);
    const { prompt, ...parameters } = normalized;
    const artifact = this.deps.store.createArtifact({
      threadId,
      ...(toolUseId && { toolUseId }),
      prompt,
      parameters,
      config,
      workspacePath,
      generationRoot,
    });
    this.deps.onArtifactChanged(artifact);
    try {
      const images = await generateImagesToWorkspace({
        config,
        toolInput: normalized,
        generationRoot,
        threadDirectory: threadDirectoryName(threadId),
        workspacePath,
        ...(this.deps.generateCodex ? { generateCodex: this.deps.generateCodex } : {}),
        ...(signal ? { signal } : {}),
      });
      const completed = this.deps.store.completeArtifact(artifact.id, images);
      this.deps.onArtifactChanged(completed);
      return { artifact: completed };
    } catch (error) {
      const failure =
        error instanceof ImageGenerationError
          ? error
          : new ImageGenerationError(
              "internal_error",
              error instanceof Error ? error.message : String(error),
            );
      const failed = this.deps.store.failArtifact(
        artifact.id,
        failure.code,
        failure.message,
        failure.partialImages,
      );
      this.deps.onArtifactChanged(failed);
      return {
        artifact: failed,
        ...(failure.providerStatus ? { providerStatus: failure.providerStatus } : {}),
        ...(failure.requestId ? { requestId: failure.requestId } : {}),
      };
    }
  }
}

function imageGenerationToolDefinition(): McpToolDefinition {
  return {
    name: ECO_IMAGE_GENERATION_TOOL,
    description:
      "Create or edit images with Mori's active Creative Drawing provider and save them into the current conversation work directory. Pass input_images for image-to-image edits when the active profile supports it. Every call requires user approval.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 32000 },
        input_images: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description:
            "Optional absolute or workspace-relative PNG/JPEG/WebP paths for image-to-image edits (OpenAI up to 16, Gemini up to 3).",
        },
        size: { type: "string", description: "OpenAI: auto or WIDTHxHEIGHT; Gemini: 1K, 2K, or 4K." },
        aspect_ratio: { type: "string", description: "Gemini only, for example 1:1 or 16:9." },
        quality: {
          type: "string",
          enum: ["auto", "low", "medium", "high"],
          description: "OpenAI-style providers only.",
        },
        count: { type: "integer", minimum: 1, maximum: 4, default: 1 },
        output_name: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "Safe filename prefix, never a path.",
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

function threadDirectoryName(threadId: string): string {
  let hash = 0x811c9dc5;
  for (const char of threadId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `thread-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
