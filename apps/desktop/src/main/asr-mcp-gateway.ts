import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import fs from "node:fs/promises";
import path from "node:path";
import { transcribeAsr } from "./asr-client";
import { MAX_ASR_DATA_URL_BYTES } from "../shared/asr-limits";
import type { McpSdkConfig } from "../shared/mcp";
import {
  buildAsrPromptAppend,
  ECO_ASR_FULL_TOOL,
  ECO_ASR_MCP_SERVER,
  ECO_ASR_TOOL,
  ASR_MCP_TOOL_TIMEOUT_MS,
} from "../shared/asr-tool";
import type { AsrSettingsStore } from "./asr-settings-store";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";
const CONTROL_SECRET_HEADER = "X-Eco-Asr-Control-Secret";

export interface AsrMcpInjection {
  enabled: boolean;
  serverName: typeof ECO_ASR_MCP_SERVER;
  sdkEntry?: Record<string, unknown>;
  codexServer?: CodexMcpServerForConfigSync;
  promptAppend?: string;
  unavailableReason?: string;
}

export interface AsrGatewayDeps {
  store: AsrSettingsStore;
  fetchImpl?: typeof fetch;
  resolveWorkspacePath(threadId: string): string | undefined;
  isSessionEnabled(threadId: string): boolean;
}

export class AsrMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;
  private starting: Promise<void> | undefined;

  constructor(private readonly deps: AsrGatewayDeps) {}

  noteUpcomingTool(threadId: string, toolName?: string, toolUseId?: string): void {
    if (toolName === ECO_ASR_FULL_TOOL || toolName === ECO_ASR_TOOL) {
      this.claims.noteUpcoming(threadId, toolName, toolUseId);
    }
  }

  /** Stable process-global definition written to Codex config.toml. */
  async resolveGlobalCodexServer(): Promise<CodexMcpServerForConfigSync | undefined> {
    if (!this.deps.store.getStatus().hasApiKey) {
      return undefined;
    }
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_ASR_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [ECO_ASR_TOOL],
      toolTimeoutSec: 300,
    });
  }

  async resolveInjection(input: { threadId: string; sessionEnabled: boolean }): Promise<AsrMcpInjection> {
    if (!input.sessionEnabled) {
      this.auth.revokeThread(input.threadId);
      return { enabled: false, serverName: ECO_ASR_MCP_SERVER };
    }
    try {
      const config = this.deps.store.getClientConfig();
      if (!config) throw new Error("当前语音识别 Profile 尚未配置 API Key。");
      const globalCodexServer = await this.resolveGlobalCodexServer();
      if (!globalCodexServer) {
        return { enabled: false, serverName: ECO_ASR_MCP_SERVER };
      }
      const auth = this.auth.ensure(input.threadId);
      const http = buildEcoHttpInjection({
        name: ECO_ASR_MCP_SERVER,
        controlBaseUrl: this.controlBaseUrl,
        controlSecretHeader: CONTROL_SECRET_HEADER,
        controlSecret: this.controlSecret,
        authToken: auth.token,
        enabledTools: [ECO_ASR_TOOL],
        toolTimeoutSec: 300,
      });
      return {
        enabled: true,
        serverName: ECO_ASR_MCP_SERVER,
        sdkEntry: {
          ...http.sdkEntry,
          // Claude Agent SDK: per-server tool-call wall clock (default ~60s via MCP_TOOL_TIMEOUT).
          timeout: ASR_MCP_TOOL_TIMEOUT_MS,
          // PI MCP extension: toPiMcpServerConfig prefers requestTimeoutMs and converts it to seconds.
          requestTimeoutMs: ASR_MCP_TOOL_TIMEOUT_MS,
        },
        codexServer: http.codexServer,
        promptAppend: buildAsrPromptAppend(),
      };
    } catch (error) {
      this.auth.revokeThread(input.threadId);
      return {
        enabled: false,
        serverName: ECO_ASR_MCP_SERVER,
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: AsrMcpInjection): McpSdkConfig {
    if (!injection.enabled || !injection.sdkEntry) return base;
    return {
      mcpServers: { ...base.mcpServers, [ECO_ASR_MCP_SERVER]: injection.sdkEntry },
      // ASR is a session-enabled integration tool; route permissions through the normal MCP policy.
      allowedTools: [...base.allowedTools, ECO_ASR_FULL_TOOL],
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
    if (!this.port) throw new Error("语音识别 MCP 控制服务尚未启动。");
    return `http://127.0.0.1:${this.port}`;
  }

  private resolveThread(authToken: string | undefined): { threadId: string; toolUseId?: string } {
    const authenticated = this.auth.resolve(authToken);
    if (authenticated) {
      const claimed = this.claims.claimDetails(ECO_ASR_TOOL, authenticated.threadId);
      return {
        threadId: authenticated.threadId,
        ...(claimed?.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    if (authToken) throw new Error("语音识别会话令牌已失效。");
    const claimed = this.claims.claimDetails(ECO_ASR_TOOL);
    if (claimed) {
      return {
        threadId: claimed.threadId,
        ...(claimed.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    throw new Error("语音识别 MCP 无法绑定会话：缺少有效线程令牌或 tool.started claim。");
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = (request.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: ECO_ASR_MCP_SERVER,
          instructions:
            "Mori Speech Recognition. Transcribe local audio with the active voice input provider.",
          listTools: async () => ({ tools: [asrToolDefinition()] }),
          callTool: async ({ name, arguments: args, authToken, signal }) => {
            try {
              return await this.executeToolCall(name, args, authToken, signal);
            } catch (error) {
              return {
                isError: true,
                content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
              };
            }
          },
        },
        {
          controlSecretHeader: "x-eco-asr-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (request.headers["x-eco-asr-control-secret"] !== this.controlSecret) {
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
        sendJson(response, 200, { tools: [asrToolDefinition()] });
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
    if (name !== ECO_ASR_TOOL) {
      throw new Error(`未知语音识别工具：${name}`);
    }
    const { threadId } = this.resolveThread(authToken);
    if (!this.deps.isSessionEnabled(threadId)) throw new Error("本会话未开启语音识别集成。");
    signal?.throwIfAborted();
    const config = this.deps.store.getClientConfig();
    if (!config) throw new Error("当前语音识别 Profile 尚未配置 API Key。");
    const workspace = this.deps.resolveWorkspacePath(threadId);
    const inputPath = typeof rawArgs.path === "string" ? rawArgs.path.trim() : "";
    if (!inputPath) throw new Error("必须提供音频文件路径。");
    if (!path.isAbsolute(inputPath) && !workspace) throw new Error("会话缺少工作目录，请提供绝对路径。");
    const audioPath = path.resolve(workspace ?? ".", inputPath);
    const mimeTypes: Record<string, string> = {
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".mp4": "audio/mp4",
      ".flac": "audio/flac",
      ".ogg": "audio/ogg",
      ".webm": "audio/webm",
    };
    const mimeType = mimeTypes[path.extname(audioPath).toLowerCase()];
    if (!mimeType) throw new Error("不支持的音频格式。支持 WAV、MP3、M4A、MP4、FLAC、OGG、WebM。");
    const file = await fs.open(audioPath, "r");
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !stat.size) throw new Error("音频路径必须指向非空常规文件。");
      if (Math.ceil(stat.size / 3) * 4 + 32 > MAX_ASR_DATA_URL_BYTES)
        throw new Error("音频编码后超过 10 MiB ASR 限制，请先分段或压缩。");
      // Bound the read even if another process grows the file after stat().
      const maxBytes = Math.floor((MAX_ASR_DATA_URL_BYTES * 3) / 4);
      bytes = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      if (offset > stat.size) throw new Error("读取期间音频文件发生变化，请等待写入完成后重试。");
      bytes = bytes.subarray(0, offset);
    } finally {
      await file.close();
    }
    const result = await transcribeAsr(
      config,
      { audioWavBase64: bytes.toString("base64"), mimeType, filename: path.basename(audioPath) },
      { ...(this.deps.fetchImpl ? { fetch: this.deps.fetchImpl } : {}), ...(signal ? { signal } : {}) },
    );
    const structuredContent = { text: result.text, path: audioPath, model: config.model };
    return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
  }
}

export function asrToolDefinition(): McpToolDefinition {
  return {
    name: ECO_ASR_TOOL,
    description:
      "Transcribe speech from a local audio file using Mori's active voice input provider. Returns text for analysis. Supports WAV, MP3, M4A, MP4, FLAC, OGG, WebM subject to provider support; base64 request limit 10 MiB. Does not analyze non-speech sounds.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Absolute or workspace-relative local audio file path.",
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
