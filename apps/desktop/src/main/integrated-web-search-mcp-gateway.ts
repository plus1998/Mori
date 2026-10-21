import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import {
  formatIntegratedWebSearchResults,
  integratedWebSearchProviderLabel,
  searchIntegratedWeb,
  type IntegratedWebSearchProvider,
} from "@eco/runtime";
import {
  buildIntegratedWebSearchPromptAppend,
  ECO_WEB_SEARCH_FULL_TOOL,
  ECO_WEB_SEARCH_MCP_SERVER,
  ECO_WEB_SEARCH_TOOL,
  isEcoWebSearchToolName,
  shouldAutoApproveEcoWebSearchTools,
} from "../shared/integrated-web-search";
import type { McpSdkConfig } from "../shared/mcp";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import type { IntegratedWebSearchSettingsStore } from "./integrated-web-search-settings-store";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest, type McpToolDefinition } from "./mcp-streamable-http";

const CONTROL_SECRET_HEADER = "X-Eco-Web-Search-Control-Secret";

export interface IntegratedWebSearchMcpInjection {
  enabled: boolean;
  serverName: typeof ECO_WEB_SEARCH_MCP_SERVER;
  sdkEntry?: Record<string, unknown>;
  codexServer?: CodexMcpServerForConfigSync;
  promptAppend?: string;
  /** Whether the SDK should auto-approve the search tool (approvalMode === "always_allow"). */
  autoApproveTools?: boolean;
  unavailableReason?: string;
}

export interface IntegratedWebSearchGatewayDeps {
  store: IntegratedWebSearchSettingsStore;
  getApiKey: () => string | undefined;
}

export class IntegratedWebSearchMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private server: http.Server | undefined;
  private port: number | undefined;

  constructor(private readonly deps: IntegratedWebSearchGatewayDeps) {}

  noteUpcomingTool(threadId: string, toolName?: string, toolUseId?: string): void {
    if (isEcoWebSearchToolName(toolName)) {
      this.claims.noteUpcoming(threadId, toolName, toolUseId);
    }
  }

  async resolveGlobalCodexServer(): Promise<CodexMcpServerForConfigSync | undefined> {
    const settings = this.deps.store.get();
    const apiKey = this.deps.getApiKey()?.trim();
    if (!settings.enabled || !apiKey) {
      return undefined;
    }
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_WEB_SEARCH_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      enabledTools: [ECO_WEB_SEARCH_TOOL],
    });
  }

  async resolveInjection(input: {
    threadId: string;
    sessionEnabled: boolean;
  }): Promise<IntegratedWebSearchMcpInjection> {
    if (!input.sessionEnabled) {
      return { enabled: false, serverName: ECO_WEB_SEARCH_MCP_SERVER };
    }
    try {
      const settings = this.deps.store.get();
      const apiKey = this.deps.getApiKey()?.trim();
      if (!settings.enabled || !apiKey) {
        return {
          enabled: false,
          serverName: ECO_WEB_SEARCH_MCP_SERVER,
          unavailableReason: "Integrated Web Search is not configured (enable + API key).",
        };
      }
      const globalCodexServer = await this.resolveGlobalCodexServer();
      if (!globalCodexServer) {
        return { enabled: false, serverName: ECO_WEB_SEARCH_MCP_SERVER };
      }
      const auth = this.auth.ensure(input.threadId);
      const http = buildEcoHttpInjection({
        name: ECO_WEB_SEARCH_MCP_SERVER,
        controlBaseUrl: this.controlBaseUrl,
        controlSecretHeader: CONTROL_SECRET_HEADER,
        controlSecret: this.controlSecret,
        authToken: auth.token,
        enabledTools: [ECO_WEB_SEARCH_TOOL],
      });
      const providerLabel = integratedWebSearchProviderLabel(settings.provider);
      const autoApproveTools = shouldAutoApproveEcoWebSearchTools(settings.approvalMode);
      return {
        enabled: true,
        serverName: ECO_WEB_SEARCH_MCP_SERVER,
        sdkEntry: http.sdkEntry,
        codexServer: http.codexServer,
        promptAppend: buildIntegratedWebSearchPromptAppend(providerLabel),
        autoApproveTools,
      };
    } catch (error) {
      return {
        enabled: false,
        serverName: ECO_WEB_SEARCH_MCP_SERVER,
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  mergeIntoSdkConfig(base: McpSdkConfig, injection: IntegratedWebSearchMcpInjection): McpSdkConfig {
    if (!injection.enabled || !injection.sdkEntry) return base;
    const allowedTools = [...base.allowedTools];
    if (injection.autoApproveTools === false) {
      // always_ask: drop the tool so the SDK routes the call through the
      // Eco approval handler (same gating as built-in browser / computer use).
      const filtered = allowedTools.filter((tool) => tool !== ECO_WEB_SEARCH_FULL_TOOL);
      return {
        mcpServers: { ...base.mcpServers, [ECO_WEB_SEARCH_MCP_SERVER]: injection.sdkEntry },
        allowedTools: [...new Set(filtered)],
      };
    }
    if (!allowedTools.includes(ECO_WEB_SEARCH_FULL_TOOL)) {
      allowedTools.push(ECO_WEB_SEARCH_FULL_TOOL);
    }
    return {
      mcpServers: { ...base.mcpServers, [ECO_WEB_SEARCH_MCP_SERVER]: injection.sdkEntry },
      allowedTools: [...new Set(allowedTools)],
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
    if (!this.port) throw new Error("网络搜索 MCP 控制服务尚未启动。");
    return `http://127.0.0.1:${this.port}`;
  }

  private resolveThread(authToken: string | undefined): { threadId: string; toolUseId?: string } {
    const authenticated = this.auth.resolve(authToken);
    if (authenticated) {
      const claimed = this.claims.claimDetails(ECO_WEB_SEARCH_TOOL, authenticated.threadId);
      return {
        threadId: authenticated.threadId,
        ...(claimed?.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    const claimed = this.claims.claimDetails(ECO_WEB_SEARCH_TOOL);
    if (claimed) {
      return {
        threadId: claimed.threadId,
        ...(claimed.toolUseId && { toolUseId: claimed.toolUseId }),
      };
    }
    throw new Error("网络搜索 MCP 无法绑定会话：缺少有效线程令牌或 tool.started claim。");
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const urlPath = (request.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        {
          serverName: ECO_WEB_SEARCH_MCP_SERVER,
          instructions:
            "Eco Integrated Web Search (Tavily, Doubao, DeepSeek, or Brave). Use when you need up-to-date information.",
          listTools: async () => ({ tools: [webSearchToolDefinition()] }),
          callTool: async ({ name, arguments: args, authToken, signal }) =>
            this.executeToolCall(name, args, authToken, signal),
        },
        {
          controlSecretHeader: "x-eco-web-search-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    if (request.headers["x-eco-web-search-control-secret"] !== this.controlSecret) {
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
        sendJson(response, 200, { tools: [webSearchToolDefinition()] });
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
    if (name !== ECO_WEB_SEARCH_TOOL) {
      throw new Error(`未知网络搜索工具：${name}`);
    }
    this.resolveThread(authToken);
    const settings = this.deps.store.get();
    const apiKey = this.deps.getApiKey()?.trim();
    if (!settings.enabled || !apiKey) {
      throw new Error("Integrated Web Search is not configured.");
    }
    const query = typeof rawArgs.query === "string" ? rawArgs.query.trim() : "";
    const provider = settings.provider as IntegratedWebSearchProvider;
    signal?.throwIfAborted();
    const results = await searchIntegratedWeb(provider, query, apiKey, signal ? { signal } : undefined);
    const text = formatIntegratedWebSearchResults(provider, query, results);
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        provider,
        query,
        resultCount: results.length,
        results: results.map((entry) => ({
          title: entry.title,
          url: entry.url,
          description: entry.description,
        })),
      },
    };
  }
}

function webSearchToolDefinition(): McpToolDefinition {
  return {
    name: ECO_WEB_SEARCH_TOOL,
    description:
      "Search the public web via Eco Integrated Web Search (Tavily, Doubao, DeepSeek, or Brave). Use when you need up-to-date information.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, description: "Search query." },
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
