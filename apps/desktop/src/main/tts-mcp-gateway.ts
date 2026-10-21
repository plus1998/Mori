import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import type { McpSdkConfig } from "../shared/mcp";
import {
  buildTtsPromptAppend,
  ECO_TTS_FULL_TOOL,
  ECO_TTS_MCP_SERVER,
  ECO_TTS_TOOL,
  isEcoTtsToolName,
  TTS_CODEX_TOOL_TIMEOUT_SEC,
  TTS_MCP_TOOL_TIMEOUT_MS,
  type TtsArtifact,
  TtsError,
  type TtsToolInput,
} from "../shared/tts";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";
import { generateSpeechToWorkspace, normalizeTtsToolInput } from "./tts-client";
import type { TtsStore } from "./tts-store";

const CONTROL_SECRET_HEADER = "X-Eco-Tts-Control-Secret";

export interface TtsMcpInjection {
  enabled: boolean;
  serverName: typeof ECO_TTS_MCP_SERVER;
  sdkEntry?: Record<string, unknown>;
  codexServer?: CodexMcpServerForConfigSync;
  promptAppend?: string;
  unavailableReason?: string;
}

export interface TtsGatewayDeps {
  store: TtsStore;
  resolveWorkspacePath(threadId: string): string | undefined;
  resolveGenerationRoot(threadId: string): string | undefined;
  onArtifactChanged(artifact: TtsArtifact): void;
}

export class TtsMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;
  private starting: Promise<void> | undefined;

  constructor(private readonly deps: TtsGatewayDeps) {}

  noteUpcomingTool(threadId: string, toolName?: string, toolUseId?: string): void {
    if (isEcoTtsToolName(toolName)) {
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
      name: ECO_TTS_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [ECO_TTS_TOOL],
      toolTimeoutSec: TTS_CODEX_TOOL_TIMEOUT_SEC,
    });
  }

  async resolveInjection(input: { threadId: string; sessionEnabled: boolean }): Promise<TtsMcpInjection> {
    const settings = this.deps.store.getSettings();
    if (!settings.enabled || !input.sessionEnabled) {
      this.auth.revokeThread(input.threadId);
      return { enabled: false, serverName: ECO_TTS_MCP_SERVER };
    }
    try {
      const config = this.deps.store.getActiveClientConfig();
      const globalCodexServer = await this.resolveGlobalCodexServer();
      if (!globalCodexServer) {
        return { enabled: false, serverName: ECO_TTS_MCP_SERVER };
      }
      const auth = this.auth.ensure(input.threadId);
      const http = buildEcoHttpInjection({
        name: ECO_TTS_MCP_SERVER,
        controlBaseUrl: this.controlBaseUrl,
        controlSecretHeader: CONTROL_SECRET_HEADER,
        controlSecret: this.controlSecret,
        authToken: auth.token,
        enabledTools: [ECO_TTS_TOOL],
        toolTimeoutSec: TTS_CODEX_TOOL_TIMEOUT_SEC,
      });
      return {
        enabled: true,
        serverName: ECO_TTS_MCP_SERVER,
        sdkEntry: {
          ...http.sdkEntry,
          // Claude Agent SDK: per-server tool-call wall clock (default ~60s via MCP_TOOL_TIMEOUT).
          timeout: TTS_MCP_TOOL_TIMEOUT_MS,
          // PI MCP extension: toPiMcpServerConfig prefers requestTimeoutMs and converts it to seconds.
          requestTimeoutMs: TTS_MCP_TOOL_TIMEOUT_MS,
        },
        codexServer: http.codexServer,
        promptAppend: buildTtsPromptAppend(config),
      };
    } catch (error) {
      return {
        enabled: false,
        serverName: ECO_TTS_MCP_SERVER,
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: TtsMcpInjection): McpSdkConfig {
    if (!injection.enabled || !injection.sdkEntry) return base;
    return {
      mcpServers: { ...base.mcpServers, [ECO_TTS_MCP_SERVER]: injection.sdkEntry },
      // TTS is a session-enabled integration tool; route permissions through the normal MCP policy.
      allowedTools: [...base.allowedTools, ECO_TTS_FULL_TOOL],
    };
  }

  disposeThread(threadId: string): void {
    this.auth.revokeThread(threadId);
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = undefined;
    this.port = undefined;
  }

  private async start(): Promise<void> {
    if (this.port) return;
    if (!this.starting) {
      this.starting = (async () => {
        const server = http.createServer((request, response) => void this.handle(request, response));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        this.port = (server.address() as AddressInfo).port;
      })();
    }
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private get controlBaseUrl(): string {
    if (!this.port) throw new Error("语音生成 MCP 控制服务尚未启动。");
    return `http://127.0.0.1:${this.port}`;
  }

  private resolveThread(authToken: string | undefined): { threadId: string; toolUseId?: string } {
    const authenticated = this.auth.resolve(authToken);
    if (authenticated) {
      const claimed = this.claims.claimDetails(ECO_TTS_TOOL, authenticated.threadId);
      return {
        threadId: authenticated.threadId,
        ...(claimed?.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    if (authToken) throw new Error("语音生成会话令牌已失效。");
    const claimed = this.claims.claimDetails(ECO_TTS_TOOL);
    if (claimed) {
      return {
        threadId: claimed.threadId,
        ...(claimed.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    throw new Error("语音生成 MCP 无法绑定会话：缺少有效线程令牌或 tool.started claim。");
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = (request.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: ECO_TTS_MCP_SERVER,
          instructions:
            "Eco Speech Generation. Create playable voice artifacts in the conversation work directory.",
          listTools: async () => ({ tools: [ttsToolDefinition()] }),
          callTool: async ({ name, arguments: args, authToken, signal }) =>
            this.executeToolCall(name, args, authToken, signal),
        },
        {
          controlSecretHeader: "x-eco-tts-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (request.headers["x-eco-tts-control-secret"] !== this.controlSecret) {
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
        sendJson(response, 200, { tools: [ttsToolDefinition()] });
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
    if (name !== ECO_TTS_TOOL) {
      throw new Error(`未知语音生成工具：${name}`);
    }
    const claim = this.resolveThread(authToken);
    signal?.throwIfAborted();
    const threadId = claim.threadId;
    const workspacePath = this.deps.resolveWorkspacePath(threadId)?.trim();
    const generationRoot = this.deps.resolveGenerationRoot(threadId)?.trim();
    if (!workspacePath || !generationRoot) {
      throw new Error("语音生成会话缺少 workspace 或运行目录。");
    }
    if (!this.deps.store.getSettings().enabled) throw new Error("语音生成集成已关闭。");
    const config = this.deps.store.getActiveClientConfig();
    const normalized = normalizeTtsToolInput(rawArgs as unknown as TtsToolInput);
    const { text, ...parameters } = normalized;
    const artifact = this.deps.store.createArtifact({
      threadId,
      ...(claim.toolUseId && { toolUseId: claim.toolUseId }),
      text,
      parameters,
      config,
      workspacePath,
      generationRoot,
    });
    this.deps.onArtifactChanged(artifact);
    try {
      const audio = await generateSpeechToWorkspace({
        config,
        toolInput: normalized,
        generationRoot,
        threadDirectory: threadDirectoryName(threadId),
        ...(signal ? { signal } : {}),
      });
      const completed = this.deps.store.completeArtifact(artifact.id, audio);
      this.deps.onArtifactChanged(completed);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "completed", artifactId: artifact.id, audio }, null, 2),
          },
        ],
        structuredContent: {
          status: "completed",
          artifactId: artifact.id,
          provider: config.provider,
          model: config.model,
          audio,
        },
      };
    } catch (error) {
      const failure =
        error instanceof TtsError
          ? error
          : new TtsError("internal_error", error instanceof Error ? error.message : String(error));
      const failed = this.deps.store.failArtifact(artifact.id, failure.code, failure.message);
      this.deps.onArtifactChanged(failed);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "failed",
                artifactId: artifact.id,
                code: failure.code,
                message: failure.message,
                ...(failure.providerStatus ? { providerStatus: failure.providerStatus } : {}),
                ...(failure.requestId ? { requestId: failure.requestId } : {}),
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
        structuredContent: {
          status: "failed",
          artifactId: artifact.id,
          code: failure.code,
          message: failure.message,
        },
      };
    }
  }
}

function ttsToolDefinition(): McpToolDefinition {
  return {
    name: ECO_TTS_TOOL,
    description:
      "Create a speech audio artifact from a verbatim transcript. Choose voice and style (emotion, tone, pitch, pace and accent) to suit the task. Eco saves the file and displays it in Feed and cards.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["text", "voice", "style"],
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 32000,
          description: "Verbatim spoken text; no delivery instructions.",
        },
        voice: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Provider voice ID; Gemini examples: Kore, Puck, Aoede, Charon, Fenrir. Doubao examples: zh_female_vv_uranus_bigtts, en_male_tim_uranus_bigtts.",
        },
        style: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Delivery instructions: emotion, tone, pitch, pacing, accent and volume.",
        },
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
