import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import {
  buildHtmlHostPromptAppend,
  ECO_HTML_HOST_FULL_TOOL,
  ECO_HTML_HOST_MCP_SERVER,
  ECO_HTML_HOST_TOOL,
  isEcoHtmlHostToolName,
} from "../shared/html-host-tool";
import type { HtmlHostArtifact, HtmlHostToolInput, HtmlHostingCapability } from "../shared/html-host";
import type { McpSdkConfig } from "../shared/mcp";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import {
  HtmlHostError,
  HtmlHostStore,
  normalizeHtmlHostToolInput,
  type HtmlHostApi,
} from "./html-host-store";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";

const CONTROL_SECRET_HEADER = "X-Eco-Html-Host-Control-Secret";

const HOST_ERRORS: Record<string, string> = {
  invalid_title: "title 不能为空。",
  invalid_html: "html 不能为空。",
  too_large: "HTML 超过 1 MiB 上限。",
  unavailable: "HTML 托管不可用：请先连接 Supabase Center 并部署 html-host-* Edge Functions。",
  not_connected: "未连接 Supabase Center，无法发布 HTML 页面。",
  publish_failed: "发布 HTML 页面失败。",
};

export interface HtmlHostMcpInjection {
  enabled: true;
  serverName: typeof ECO_HTML_HOST_MCP_SERVER;
  sdkEntry: Record<string, unknown>;
  codexServer: CodexMcpServerForConfigSync;
  promptAppend: string;
}

export interface HtmlHostGatewayDeps {
  store: HtmlHostStore;
  api: HtmlHostApi;
  onArtifactChanged(artifact: HtmlHostArtifact): void;
  getCapability(): Promise<HtmlHostingCapability>;
}

export class HtmlHostMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(private readonly deps: HtmlHostGatewayDeps) {}

  noteUpcomingTool(threadId: string, toolName?: string, toolUseId?: string): void {
    if (isEcoHtmlHostToolName(toolName) || toolName?.trim() === ECO_HTML_HOST_TOOL) {
      this.claims.noteUpcoming(threadId, toolName, toolUseId);
    }
  }

  async resolveGlobalCodexServer(): Promise<CodexMcpServerForConfigSync> {
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_HTML_HOST_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [ECO_HTML_HOST_TOOL],
    });
  }

  async resolveInjection(threadId: string): Promise<HtmlHostMcpInjection> {
    await this.start();
    const auth = this.auth.ensure(threadId);
    const http = buildEcoHttpInjection({
      name: ECO_HTML_HOST_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      authToken: auth.token,
      enabledTools: [ECO_HTML_HOST_TOOL],
    });
    return {
      enabled: true,
      serverName: ECO_HTML_HOST_MCP_SERVER,
      sdkEntry: http.sdkEntry,
      codexServer: http.codexServer,
      promptAppend: buildHtmlHostPromptAppend(),
    };
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: HtmlHostMcpInjection): McpSdkConfig {
    return {
      mcpServers: { ...base.mcpServers, [ECO_HTML_HOST_MCP_SERVER]: injection.sdkEntry },
      allowedTools: [...new Set([...base.allowedTools, ECO_HTML_HOST_FULL_TOOL])],
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
    if (!this.port) throw new Error("HTML host MCP control service is not started.");
    return `http://127.0.0.1:${this.port}`;
  }

  private resolveThread(authToken: string | undefined): { threadId: string; toolUseId?: string } {
    const authenticated = this.auth.resolve(authToken);
    if (authenticated) {
      const claimed = this.claims.claimDetails(ECO_HTML_HOST_TOOL, authenticated.threadId);
      return {
        threadId: authenticated.threadId,
        ...(claimed?.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    const claimed = this.claims.claimDetails(ECO_HTML_HOST_TOOL);
    if (claimed) {
      return {
        threadId: claimed.threadId,
        ...(claimed.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    throw new Error("HTML host MCP could not bind a thread: missing auth token or tool claim.");
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = (request.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: ECO_HTML_HOST_MCP_SERVER,
          instructions:
            "Eco HTML hosting for progress/report pages. Publish single-file HTML; Eco wraps chrome and returns a publicUrl.",
          listTools: async () => ({ tools: [htmlHostToolDefinition()] }),
          callTool: async ({ name, arguments: args, authToken }) =>
            this.executeToolCall(name, args, authToken),
        },
        {
          controlSecretHeader: "x-eco-html-host-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (request.headers["x-eco-html-host-control-secret"] !== this.controlSecret) {
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
        sendJson(response, 200, { tools: [htmlHostToolDefinition()] });
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
        result: mcpErrorResult(error instanceof Error ? error.message : String(error), "publish_failed"),
      });
    }
  }

  private async executeToolCall(
    name: string,
    rawArgs: Record<string, unknown>,
    authToken: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (name !== ECO_HTML_HOST_TOOL) {
      throw new Error(`Unknown HTML host tool: ${name}`);
    }
    const claim = this.resolveThread(authToken);
    let toolInput: HtmlHostToolInput;
    try {
      toolInput = normalizeHtmlHostToolInput(rawArgs);
    } catch (error) {
      const code = error instanceof HtmlHostError ? error.code : "invalid_html";
      return mcpErrorResult(HOST_ERRORS[code] ?? String(error), code);
    }

    const capability = await this.deps.getCapability();
    if (!capability.available) {
      return mcpErrorResult(
        capability.detail ?? HOST_ERRORS.unavailable!,
        capability.reason === "not_connected" ? "not_connected" : "unavailable",
      );
    }

    try {
      const published = await this.deps.api.publish({
        ...toolInput,
        threadId: claim.threadId,
      });
      const now = new Date().toISOString();
      const artifact: HtmlHostArtifact = {
        id: published.pageId,
        threadId: claim.threadId,
        ...(claim.toolUseId ? { toolUseId: claim.toolUseId } : {}),
        status: "completed",
        pageId: published.pageId,
        slug: published.slug,
        title: published.title,
        publicUrl: published.publicUrl,
        expiresAt: published.expiresAt,
        ...(published.extendedAt ? { extendedAt: published.extendedAt } : {}),
        canExtend: published.canExtend,
        createdAt: published.createdAt || now,
        updatedAt: now,
      };
      this.deps.store.upsert(artifact);
      this.deps.onArtifactChanged(artifact);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              pageId: published.pageId,
              publicUrl: published.publicUrl,
              title: published.title,
              expiresAt: published.expiresAt,
              canExtend: published.canExtend,
            }),
          },
        ],
      };
    } catch (error) {
      const code = error instanceof HtmlHostError ? error.code : "publish_failed";
      return mcpErrorResult(
        HOST_ERRORS[code] ?? (error instanceof Error ? error.message : String(error)),
        code,
      );
    }
  }
}

function mcpErrorResult(message: string, code: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "failed", code, message }) }],
    isError: true,
  };
}

function htmlHostToolDefinition(): McpToolDefinition {
  return {
    name: ECO_HTML_HOST_TOOL,
    description:
      "Publish a self-contained HTML page (progress / report / stats) to Eco Supabase hosting. Pass pageId to update an existing page without resetting its expiry. Returns { status, pageId, publicUrl, expiresAt, canExtend }; use the returned URL and expiry. Users can open or copy the link from the Feed card. Eco wraps content in chrome — do not draw the outer frame.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "html"],
      properties: {
        title: { type: "string", description: "Short page title shown in Eco chrome and Feed." },
        html: {
          type: "string",
          description: "Single-file HTML with inline CSS/JS. Eco embeds it; do not include Eco chrome.",
        },
        pageId: {
          type: "string",
          description: "Optional existing page id to update content without resetting TTL.",
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
    if (total > 2 * 1024 * 1024) throw new Error("request too large");
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
