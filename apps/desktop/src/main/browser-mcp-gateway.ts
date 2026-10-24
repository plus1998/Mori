import http from "node:http";
import type { AddressInfo } from "node:net";
import type { CodexMcpServerForConfigSync } from "@eco/runtime";
import {
  browserAgentSessionKey,
  buildEcoAgentBrowserPromptAppend,
  ECO_AGENT_BROWSER_ALLOWED_TOOL,
  ECO_AGENT_BROWSER_MCP_SERVER,
} from "../shared/browser";
import type { McpSdkConfig } from "../shared/mcp";
import { type AgentBrowserMcpToolResult, callAgentBrowserToolViaCli } from "./agent-browser-cli-bridge";
import { agentBrowserCoreToolsCatalog } from "./agent-browser-core-tools";
import { resolveAgentBrowserBinary } from "./agent-browser-resolve";
import { BrowserMcpAuthRegistry, createBrowserMcpControlSecret } from "./browser-mcp-auth";
import { BrowserMcpToolClaimRouter } from "./browser-mcp-router";
import { buildEcoHttpCodexServer, buildEcoHttpInjection } from "./mcp-http-descriptor";
import { handleMcpStreamableHttpRequest } from "./mcp-streamable-http";

const CONTROL_SECRET_HEADER = "X-Eco-Browser-Control-Secret";

/**
 * Agent-facing MCP is `eco_agent_browser` (HTTP Streamable MCP → Eco control).
 * Tool execution uses agent-browser CLI + thread CDP — not agent-browser's MCP
 * subprocess (avoids double MCP and Windows tools/call hang).
 */

export type BrowserMcpGatewayDeps = {
  ensureCdpPort: (threadId: string) => Promise<number>;
  agentBrowserEnv: (cdpPort: number, threadId: string) => Record<string, string>;
  ensureScopeGuestsReady?: (threadId: string) => Promise<void>;
  /** Resolve after guest readiness; the CLI connection is bound to this exact page. */
  getFocusedTargetId: (threadId: string) => string;
  afterAgentBrowserClose?: (threadId: string) => Promise<void>;
  /** Fired when a tools/call is bound to a thread (presence overlay). */
  onToolCall?: (threadId: string, toolName: string) => void;
  /** Eco-native fast paths (screenshot/open) that bypass agent-browser CLI. */
  invokeNativeTool?: (
    threadId: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentBrowserMcpToolResult | null | undefined>;
};

/**
 * Eco-owned browser MCP: fixed server name `eco_agent_browser`, auth + claim routing to
 * per-thread CDP; agent-browser invoked via CLI only.
 */
export class BrowserMcpGateway {
  private readonly auth = new BrowserMcpAuthRegistry();
  private readonly claims = new BrowserMcpToolClaimRouter();
  private readonly controlSecret = createBrowserMcpControlSecret();
  private controlServer: http.Server | undefined;
  private controlPort: number | undefined;
  private disposed = false;
  private readonly disposedThreads = new Set<string>();
  private readonly threadCalls = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: BrowserMcpGatewayDeps) {}

  async start(): Promise<void> {
    if (this.controlServer) {
      return;
    }
    this.controlServer = http.createServer((req, res) => {
      void this.handleControl(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.controlServer!.listen(0, "127.0.0.1", () => resolve());
      this.controlServer!.once("error", reject);
    });
    this.controlPort = (this.controlServer.address() as AddressInfo).port;
  }

  get controlBaseUrl(): string {
    if (!this.controlPort) {
      throw new Error("Browser MCP control server not started");
    }
    return `http://127.0.0.1:${this.controlPort}`;
  }

  /** Call from Eco when tool.started for browser tools on a thread. */
  noteUpcomingTool(threadId: string, toolName?: string): void {
    this.claims.noteUpcoming(threadId, toolName);
  }

  /** Stable process-global definition written to Codex config.toml. */
  async prepareCodexServer(): Promise<CodexMcpServerForConfigSync> {
    await this.start();
    return buildEcoHttpCodexServer({
      name: ECO_AGENT_BROWSER_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
    });
  }

  /**
   * Auth + HTTP injection for a thread. Does not start CDP or mint an about:blank
   * page — that happens on the first tools/call.
   */
  async prepareThread(threadId: string): Promise<{
    token: string;
    cdpPort?: number;
    sdkEntry: Record<string, unknown>;
    codexServer: CodexMcpServerForConfigSync;
    promptAppend: string;
  }> {
    if (this.disposed) throw new Error("浏览器服务已关闭。");
    this.disposedThreads.delete(threadId);
    await this.start();
    const record = this.auth.ensure(threadId);
    const http = buildEcoHttpInjection({
      name: ECO_AGENT_BROWSER_MCP_SERVER,
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      authToken: record.token,
    });

    return {
      token: record.token,
      sdkEntry: http.sdkEntry,
      codexServer: http.codexServer,
      promptAppend: buildEcoAgentBrowserPromptAppend(threadId),
    };
  }

  private resolveThreadForCall(input: { authToken?: string; toolName?: string }): string {
    const fromAuth = this.auth.resolve(input.authToken);
    if (fromAuth) {
      return fromAuth.threadId;
    }
    const claimed = this.claims.claim(input.toolName);
    if (claimed) {
      return claimed;
    }
    throw new Error(
      "Browser MCP 无法绑定会话：缺少有效 Authorization，且没有匹配的 tool.started claim。并发会话需要 Eco 看到 tool.started 或使用带 token 的连接。",
    );
  }

  private async invokeToolViaCli(
    threadId: string,
    cdpPort: number,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.disposed || this.disposedThreads.has(threadId)) throw new Error("浏览器会话已关闭。");
    const resolved = resolveAgentBrowserBinary();
    if (!resolved.available || !resolved.binaryPath) {
      throw new Error(resolved.reason ?? "agent-browser 不可用");
    }
    const sessionKey = browserAgentSessionKey(threadId);
    const env = this.deps.agentBrowserEnv(cdpPort, threadId);
    return callAgentBrowserToolViaCli({
      binaryPath: resolved.binaryPath,
      cdpPort,
      ...(!["agent_browser_tools_profiles", "agent_browser_close"].includes(toolName)
        ? { cdpTargetId: this.deps.getFocusedTargetId(threadId) }
        : {}),
      sessionKey,
      threadId,
      env,
      toolName,
      args,
      ...(signal ? { signal } : {}),
    });
  }

  private async executeToolCall(
    name: string,
    args: Record<string, unknown>,
    authToken: string | undefined,
    signal?: AbortSignal,
  ): Promise<AgentBrowserMcpToolResult> {
    const threadId = this.resolveThreadForCall({
      ...(authToken !== undefined ? { authToken } : {}),
      toolName: name,
    });
    // Native tab switches and CLI commands share one ordered stream per thread.
    const previous = this.threadCalls.get(threadId) ?? Promise.resolve();
    const call = previous
      .catch(() => {})
      .then(() => this.executeThreadToolCall(threadId, name, args, signal));
    this.threadCalls.set(threadId, call);
    try {
      return await call;
    } finally {
      if (this.threadCalls.get(threadId) === call) this.threadCalls.delete(threadId);
    }
  }

  private async executeThreadToolCall(
    threadId: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentBrowserMcpToolResult> {
    if (this.disposed || this.disposedThreads.has(threadId)) throw new Error("浏览器会话已关闭。");
    this.deps.onToolCall?.(threadId, name);
    signal?.throwIfAborted();
    const nativeResult = await this.deps.invokeNativeTool?.(threadId, name, args, signal);
    const result =
      nativeResult ??
      (await (async () => {
        const cdp = await this.deps.ensureCdpPort(threadId);
        await this.deps.ensureScopeGuestsReady?.(threadId);
        return this.invokeToolViaCli(threadId, cdp, name, args, signal);
      })());
    if (name === "agent_browser_close" && !result.isError) {
      await this.deps.afterAgentBrowserClose?.(threadId);
    }
    return result;
  }

  private async handleControl(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = (req.url ?? "").split("?")[0] ?? "";
    if (urlPath === "/mcp" || urlPath.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        req,
        res,
        {
          serverName: ECO_AGENT_BROWSER_MCP_SERVER,
          instructions: "Eco built-in browser. Tools apply only to the authenticated conversation thread.",
          listTools: async () => ({ tools: agentBrowserCoreToolsCatalog() }),
          callTool: async ({ name, arguments: args, authToken, signal }) =>
            this.executeToolCall(name, args, authToken, signal),
        },
        {
          controlSecretHeader: "x-eco-browser-control-secret",
          controlSecret: this.controlSecret,
        },
      );
      return;
    }

    const secret = req.headers["x-eco-browser-control-secret"];
    if (secret !== this.controlSecret) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized control secret" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) {
      chunks.push(c as Buffer);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const authHeader = req.headers.authorization;
    const bearer =
      typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
        ? authHeader.slice(7).trim()
        : undefined;
    const authToken = (typeof body.authToken === "string" ? body.authToken : undefined) ?? bearer;

    try {
      const url = req.url || "";
      if (url === "/v1/tools/list") {
        // Static core catalog — no agent-browser MCP child, no CDP mint.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tools: agentBrowserCoreToolsCatalog() }));
        return;
      }
      if (url === "/v1/tools/call") {
        const name = typeof body.name === "string" ? body.name : "";
        if (!name) {
          throw new Error("tools/call requires name");
        }
        const args =
          body.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
            ? (body.arguments as Record<string, unknown>)
            : {};
        const result = await this.executeToolCall(name, args, authToken);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  disposeThread(threadId: string): void {
    this.disposedThreads.add(threadId);
    this.auth.revokeThread(threadId);
  }

  async close(): Promise<void> {
    this.disposed = true;
    if (this.controlServer) {
      await new Promise<void>((resolve) => this.controlServer!.close(() => resolve()));
      this.controlServer = undefined;
    }
  }
}

export function mergeEcoBrowserSdkConfig(
  base: McpSdkConfig,
  injection: { enabled: boolean; sdkEntry?: Record<string, unknown>; autoApproveTools?: boolean },
): McpSdkConfig {
  if (!injection.enabled || !injection.sdkEntry) {
    return base;
  }
  const allowedTools =
    injection.autoApproveTools === false
      ? [...base.allowedTools]
      : [...new Set([...base.allowedTools, ECO_AGENT_BROWSER_ALLOWED_TOOL])];
  const nextServers = { ...base.mcpServers };
  for (const key of Object.keys(nextServers)) {
    if (key === ECO_AGENT_BROWSER_MCP_SERVER || key.startsWith("eco_ab_")) {
      delete nextServers[key];
    }
  }
  return {
    mcpServers: {
      ...nextServers,
      [ECO_AGENT_BROWSER_MCP_SERVER]: injection.sdkEntry,
    },
    allowedTools,
  };
}
