import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpSdkConfig } from "../shared/mcp";
import { buildEcoMcpHubDirectoryPrompt } from "../shared/mcp-hub-tool-usage";
import {
  ECO_IMAGE_GENERATION_MCP_SERVER,
  IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS,
} from "../shared/image-generation";
import { ECO_TTS_MCP_SERVER, TTS_MCP_TOOL_TIMEOUT_MS } from "../shared/tts";
import { buildEcoHttpInjection } from "./mcp-http-descriptor";
import { McpHub, type McpHubServer, type McpHubSession } from "./mcp-hub";
import { prepareMcpSdkConfigForRuntime } from "./mcp-runtime";
import { handleMcpStreamableHttpRequest } from "./mcp-streamable-http";
import { SharedMcpStdioUpstream } from "./shared-mcp-stdio-upstream";
import type { McpToolCallResult, McpToolDefinition } from "./mcp-streamable-http";

const CONTROL_SECRET_HEADER = "X-Eco-Mcp-Hub-Control-Secret";

export type McpHubThreadInjection = {
  token: string;
  sdkEntry: Record<string, unknown>;
  /** Compact directory of this thread's selected external MCP capabilities. */
  promptAppend?: string;
  /** Same server description for runtimes that still use Codex config sync. */
  codexServer: ReturnType<typeof buildEcoHttpInjection>["codexServer"];
  /** True when the global Codex pool needs one refresh for this descriptor. */
  codexServerChanged?: boolean;
};

export type McpHubGatewayServer = {
  name: string;
  server: McpHubServer;
};

type HubServerState = {
  name: string;
  server: McpHubServer;
  close?: () => Promise<void>;
  sourceEntry?: Record<string, unknown>;
  threadProxy?: ThreadScopedHttpMcpHubServer;
};

/**
 * Eco's opt-in MCP Hub transport.
 *
 * The gateway owns the local HTTP listener and gives each Eco thread a bearer
 * token. The token is bound before the runtime receives its MCP config, so the
 * model never supplies a session id to select a different authorization scope.
 * Existing built-in gateways keep their own listeners and execution authority;
 * when registered through `registerThreadServerEntry`, this class only proxies
 * the already-authenticated HTTP entry for that thread.
 */
export class McpHubGateway {
  private readonly hub = new McpHub();
  private readonly servers = new Map<string, HubServerState>();
  private readonly threadTokens = new Map<string, string>();
  private readonly threadPromptAppends = new Map<string, string>();
  private readonly threadCodexServers = new Map<
    string,
    ReturnType<typeof buildEcoHttpInjection>["codexServer"]
  >();
  private readonly threadProxies = new Map<string, ThreadScopedHttpMcpHubServer>();
  private readonly controlSecret = `ech_${randomBytes(24).toString("base64url")}`;
  private serverHttp: http.Server | undefined;
  private port: number | undefined;

  registerServer(input: McpHubGatewayServer): void {
    const name = normalizeServerName(input.name);
    if (!name) throw new Error("MCP Hub server name is required");
    this.removeServer(name);
    // Keep the adapter object intact. Spreading a class-backed server would
    // drop prototype methods (and their `this` binding) before the Hub calls
    // it, which only fails once a real list/call request arrives.
    const server: McpHubServer = {
      name,
      listTools: input.server.listTools.bind(input.server),
      callTool: input.server.callTool.bind(input.server),
    };
    this.hub.registerServer(server);
    this.servers.set(name, { name, server });
  }

  /**
   * Attach an existing thread-bound Eco gateway endpoint to the Hub.
   *
   * The built-in gateway remains the authority for lifecycle, approvals,
   * claims and tool execution. The Hub only forwards through the sdkEntry
   * minted for this thread, and retains a separate entry per thread so
   * concurrent sessions cannot share an Authorization header.
   */
  registerThreadServerEntry(input: {
    name: string;
    threadId: string;
    sdkEntry: Record<string, unknown>;
  }): void {
    const name = normalizeServerName(input.name);
    const threadId = input.threadId.trim();
    if (!name.startsWith("eco_")) {
      throw new Error("线程级 Hub 代理只允许 eco_* 内置网关");
    }
    if (!threadId) throw new Error("MCP Hub thread id is required");
    const existing = this.servers.get(name);
    let proxy = existing?.threadProxy;
    if (!proxy) {
      if (existing) this.removeServer(name);
      proxy = new ThreadScopedHttpMcpHubServer(name);
      this.hub.registerServer(proxy);
      this.threadProxies.set(name, proxy);
      this.servers.set(name, { name, server: proxy, threadProxy: proxy, close: () => proxy!.close() });
    }
    proxy.setThreadEntry(threadId, input.sdkEntry);
  }

  /** Remove all external adapters while retaining active thread credentials. */
  clearServers(): void {
    this.threadPromptAppends.clear();
    for (const state of this.servers.values()) {
      if (state.threadProxy) continue;
      this.hub.unregisterServer(state.name);
      void state.close?.();
      this.servers.delete(state.name);
    }
  }

  /**
   * Synchronize the user MCP config into Hub adapters.
   * Built-in `eco_*` entries are skipped because their dedicated gateway owns
   * approval and thread routing. Unsupported SSE entries are returned to the
   * caller instead of silently disappearing.
   */
  syncSdkConfig(config: McpSdkConfig): { registered: string[]; unsupported: string[] } {
    const registered: string[] = [];
    const unsupported: string[] = [];
    const desired = new Set<string>();
    for (const [rawName, rawEntry] of Object.entries(config.mcpServers)) {
      const name = normalizeServerName(rawName);
      if (!name || name.startsWith("eco_")) continue;
      desired.add(name);
      const entry = isRecord(rawEntry) ? rawEntry : undefined;
      if (!entry) {
        // Do not leave an old adapter reachable after a malformed settings edit.
        this.removeServer(name);
        unsupported.push(name);
        continue;
      }
      const type = typeof entry.type === "string" ? entry.type : undefined;
      if (type === "sse") {
        this.removeServer(name);
        unsupported.push(name);
        continue;
      }
      const existing = this.servers.get(name);
      // Keep a running adapter so stdio process / remote MCP session remains
      // stable across Pi runs. Config changes replace it below.
      if (existing && sameEntry(existing, entry)) {
        registered.push(name);
        continue;
      }
      this.removeServer(name);
      if (typeof entry.command === "string" && entry.command.trim()) {
        const args = arrayOfStrings(entry.args);
        const env = recordOfStrings(entry.env);
        const upstream = new SharedMcpStdioUpstream();
        const adapter: McpHubServer = {
          name,
          listTools: async ({ signal }) => {
            await upstream.ensure(entry.command as string, args, env);
            const result = await upstream.listTools(signal);
            return { tools: result.tools.filter(isToolDefinition) };
          },
          callTool: async ({ name: toolName, arguments: toolArgs, signal }) => {
            await upstream.ensure(entry.command as string, args, env);
            return normalizeToolCallResult(await upstream.callTool(toolName, toolArgs, signal));
          },
        };
        this.hub.registerServer(adapter);
        this.servers.set(name, {
          name,
          server: adapter,
          close: () => upstream.close(),
          sourceEntry: entry,
        });
        registered.push(name);
        continue;
      }
      if (typeof entry.url === "string" && entry.url.trim()) {
        const adapter = new HttpMcpHubServer(
          name,
          entry.url.trim(),
          recordOfStrings(entry.headers),
          resolveMcpRequestTimeoutMs(entry),
        );
        this.hub.registerServer(adapter);
        this.servers.set(name, { name, server: adapter, close: () => adapter.close(), sourceEntry: entry });
        registered.push(name);
        continue;
      }
      // An invalid entry is visible to the caller and cannot be mistaken for
      // an empty server catalog.
      this.removeServer(name);
      unsupported.push(name);
    }
    for (const name of [...this.servers.keys()]) {
      if (this.servers.get(name)?.threadProxy) continue;
      if (!desired.has(name)) this.removeServer(name);
    }
    return { registered, unsupported };
  }

  /** Synchronize an Eco SDK config and mint a thread-scoped wrapper entry. */
  async prepareThreadFromSdkConfig(input: {
    threadId: string;
    config: McpSdkConfig;
    allowedServers: Iterable<string>;
    runtimeName?: string;
  }): Promise<McpHubThreadInjection | undefined> {
    this.threadPromptAppends.delete(input.threadId.trim());
    const allowedServers = [...input.allowedServers].map(normalizeServerName).filter(Boolean);
    if (allowedServers.length === 0) {
      // A thread can turn off its last MCP between turns. Retire its bearer,
      // per-thread proxy credentials and Codex descriptor so the global pool
      // cannot retain a stale authorized endpoint.
      this.revokeThread(input.threadId);
      return undefined;
    }
    const config = prepareMcpSdkConfigForRuntime(input.config);
    const sync = this.syncSdkConfig(config);
    const unsupported = new Set(sync.unsupported);
    const blocked = allowedServers.filter((server) => unsupported.has(server));
    if (blocked.length > 0) {
      throw new Error(`MCP Hub 不支持服务器传输类型：${blocked.join(", ")}`);
    }
    const configuredPatterns = new Set(config.allowedTools.map((pattern) => pattern.trim()).filter(Boolean));
    const allowedTools: string[] = [];
    for (const server of allowedServers) {
      const matches = [...configuredPatterns].filter((pattern) => patternMatchesServer(pattern, server));
      allowedTools.push(...(matches.length > 0 ? matches : [`mcp__${server}__*`]));
    }
    const injection = await this.prepareThread({
      threadId: input.threadId,
      allowedServers,
      allowedTools,
      ...(input.runtimeName ? { runtimeName: input.runtimeName } : {}),
    });
    const directory = await this.hub.listServiceDirectory({
      token: injection.token,
      servers: allowedServers.filter((name) => !name.startsWith("eco_")),
    });
    const promptAppend = buildEcoMcpHubDirectoryPrompt(directory);
    if (promptAppend) this.threadPromptAppends.set(input.threadId.trim(), promptAppend);
    return { ...injection, ...(promptAppend ? { promptAppend } : {}) };
  }

  /** Bind one thread and return the only MCP server the runtime needs. */
  async prepareThread(input: {
    threadId: string;
    allowedServers?: Iterable<string>;
    /** mcp__server__tool patterns from McpStore. */
    allowedTools?: Iterable<string>;
    runtimeName?: string;
  }): Promise<McpHubThreadInjection> {
    const threadId = input.threadId.trim();
    if (!threadId) throw new Error("MCP Hub thread id is required");
    this.threadPromptAppends.delete(threadId);
    await this.start();
    // A running runtime may retain this descriptor across turns. Keep its
    // credential stable and update the bound permissions in place.
    const token = this.threadTokens.get(threadId) ?? `eht_${randomBytes(24).toString("base64url")}`;
    const allowedServers = [...(input.allowedServers ?? this.servers.keys())]
      .map(normalizeServerName)
      .filter(Boolean);
    const allowedTools = input.allowedTools === undefined
      ? undefined
      : [...input.allowedTools]
          .map((pattern) => convertToolPattern(pattern))
          .filter((pattern): pattern is string => Boolean(pattern));
    this.hub.bindSession({
      sessionId: threadId,
      token,
      allowedServers,
      ...(allowedTools ? { allowedTools } : {}),
    });
    this.threadTokens.set(threadId, token);
    // The Hub wrapper is the runtime-visible MCP server. When it contains the
    // image or speech generation gateway, the wrapper must carry the long timeout;
    // the nested gateway's timeout cannot protect an outer SDK call that has
    // already been aborted by the generic 60-second MCP default.
    const toolTimeoutMs = allowedServers.includes(ECO_IMAGE_GENERATION_MCP_SERVER)
      ? IMAGE_GENERATION_MCP_TOOL_TIMEOUT_MS
      : allowedServers.includes(ECO_TTS_MCP_SERVER)
        ? TTS_MCP_TOOL_TIMEOUT_MS
        : undefined;
    const toolTimeoutSec = toolTimeoutMs === undefined ? undefined : Math.ceil(toolTimeoutMs / 1000);
    const injection = buildEcoHttpInjection({
      name: input.runtimeName?.trim() || "eco_mcp",
      controlBaseUrl: this.controlBaseUrl,
      controlSecretHeader: CONTROL_SECRET_HEADER,
      controlSecret: this.controlSecret,
      authToken: token,
      ...(toolTimeoutSec !== undefined ? { toolTimeoutSec } : {}),
    });
    const previousCodexServer = this.threadCodexServers.get(threadId);
    const codexServerChanged = Boolean(
      input.runtimeName && JSON.stringify(previousCodexServer) !== JSON.stringify(injection.codexServer),
    );
    if (input.runtimeName) {
      this.threadCodexServers.set(threadId, injection.codexServer);
    }
    return {
      token,
      sdkEntry: {
        ...injection.sdkEntry,
        ...(toolTimeoutMs !== undefined
          ? {
              // Claude Agent SDK per-server call timeout.
              timeout: toolTimeoutMs,
              // PI MCP extension per-server timeout (converted to seconds by toPiMcpServerConfig).
              requestTimeoutMs: toolTimeoutMs,
            }
          : {}),
      },
      codexServer: injection.codexServer,
      ...(codexServerChanged ? { codexServerChanged: true } : {}),
    };
  }

  /** Prepared before runtime prompt assembly; never reuse another thread's directory. */
  getThreadPromptAppend(threadId: string): string | undefined {
    return this.threadPromptAppends.get(threadId.trim());
  }

  /** Return descriptors that must be present in Codex's process-global MCP pool. */
  listThreadCodexServers(): ReturnType<typeof buildEcoHttpInjection>["codexServer"][] {
    return [...this.threadCodexServers.values()];
  }

  getThreadCodexServerName(threadId: string): string | undefined {
    return this.threadCodexServers.get(threadId.trim())?.name;
  }

  revokeThread(threadId: string): boolean {
    const normalizedThreadId = threadId.trim();
    for (const proxy of this.threadProxies.values()) proxy.removeThread(normalizedThreadId);
    const token = this.threadTokens.get(normalizedThreadId);
    const hadCodexServer = this.threadCodexServers.has(normalizedThreadId);
    if (token) this.hub.revokeToken(token);
    this.threadTokens.delete(normalizedThreadId);
    this.threadPromptAppends.delete(normalizedThreadId);
    this.threadCodexServers.delete(normalizedThreadId);
    return Boolean(token || hadCodexServer);
  }

  get controlBaseUrl(): string {
    if (!this.port) throw new Error("MCP Hub control server not started");
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.serverHttp) return;
    this.serverHttp = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.serverHttp!.once("error", reject);
      this.serverHttp!.listen(0, "127.0.0.1", resolve);
    });
    this.port = (this.serverHttp.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    const states = [...this.servers.values()];
    this.servers.clear();
    this.threadProxies.clear();
    for (const state of states) {
      this.hub.unregisterServer(state.name);
      await state.close?.();
    }
    for (const token of this.threadTokens.values()) this.hub.revokeToken(token);
    this.threadTokens.clear();
    this.threadPromptAppends.clear();
    this.threadCodexServers.clear();
    const server = this.serverHttp;
    this.serverHttp = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private removeServer(name: string): void {
    const state = this.servers.get(name);
    if (!state) return;
    this.hub.unregisterServer(name);
    void state.close?.();
    this.threadProxies.delete(name);
    this.servers.delete(name);
  }


  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (path === "/mcp" || path.startsWith("/mcp/")) {
      await handleMcpStreamableHttpRequest(
        request,
        response,
        this.hub.createStreamableHttpHandlers(),
        { controlSecretHeader: CONTROL_SECRET_HEADER.toLowerCase(), controlSecret: this.controlSecret },
      );
      return;
    }
    if (request.headers[CONTROL_SECRET_HEADER.toLowerCase()] !== this.controlSecret) {
      sendJson(response, 401, { error: "unauthorized control secret" });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  }
}

type HttpMcpConnection = {
  client: Client;
  transport: StreamableHTTPClientTransport;
  ready: Promise<void>;
  inFlight: number;
  retired: boolean;
  closing?: Promise<void>;
};

class HttpMcpHubServer implements McpHubServer {
  private connection: HttpMcpConnection | undefined;
  private readonly connections = new Set<HttpMcpConnection>();
  private closed = false;

  constructor(
    readonly name: string,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly requestTimeoutMs?: number,
  ) {}

  async listTools(input: { signal: AbortSignal }): Promise<{ tools: McpToolDefinition[] }> {
    const result = await this.withSessionRecovery(input.signal, (client) =>
      client.listTools({}, { signal: input.signal }),
    );
    return {
      tools: result.tools.filter(isToolDefinition).map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      })),
    };
  }

  async callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<McpToolCallResult> {
    // This client is a second MCP hop for Codex's eco_mcp wrapper. Its SDK
    // default is 60s, so the outer runtime timeout alone cannot protect a
    // long-running built-in tool such as create_image.
    return normalizeToolCallResult(
      await this.withSessionRecovery(input.signal, (client) =>
        client.callTool({ name: input.name, arguments: input.arguments }, undefined, {
          signal: input.signal,
          ...(this.requestTimeoutMs !== undefined ? { timeout: this.requestTimeoutMs } : {}),
        }),
      ),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connection = undefined;
    await Promise.all([...this.connections].map((connection) => this.closeConnection(connection)));
  }

  private async withSessionRecovery<T>(
    signal: AbortSignal,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    let connection = await this.ensureConnected(signal);
    let retried = false;
    for (;;) {
      signal.throwIfAborted();
      if (connection.retired) {
        connection = await this.ensureConnected(signal);
        continue;
      }
      connection.inFlight++;
      try {
        return await operation(connection.client);
      } catch (error) {
        // A transport 404 on an established MCP session means that the server
        // rejected the request before tool dispatch. Never replay ambiguous
        // network failures, application errors, or a failed initialize.
        const expired =
          error instanceof StreamableHTTPError && error.code === 404 && connection.transport.sessionId;
        if (expired) this.retireConnection(connection);
        signal.throwIfAborted();
        if (!expired || retried || this.closed) throw error;
        retried = true;
      } finally {
        connection.inFlight--;
        if (connection.retired && connection.inFlight === 0) void this.closeConnection(connection);
      }
      // Compare connection identity when retiring: a late 404 from the old
      // generation must not discard a replacement another caller is using.
      // ensureConnected publishes the new generation before its handshake, so
      // concurrent callers share one initialization without sharing cancellation.
      connection = await this.ensureConnected(signal);
    }
  }

  private retireConnection(connection: HttpMcpConnection): void {
    if (this.connection === connection) this.connection = undefined;
    connection.retired = true;
    // Other requests may already be executing tools on the retired session.
    // Let them finish instead of aborting or replaying their side effects.
    if (connection.inFlight === 0) void this.closeConnection(connection);
  }

  private closeConnection(connection: HttpMcpConnection): Promise<void> {
    if (!connection.closing) {
      connection.closing = connection.client.close().finally(() => this.connections.delete(connection));
      void connection.closing.catch((error) =>
        console.error(`[mcp-hub] HTTP client cleanup failed: ${this.name}`, error),
      );
    }
    return connection.closing;
  }

  private async ensureConnected(signal: AbortSignal): Promise<HttpMcpConnection> {
    signal.throwIfAborted();
    if (this.closed) throw new Error(`MCP Hub HTTP connection is closed: ${this.name}`);
    let connection = this.connection;
    if (!connection) {
      const client = new Client({ name: "eco_mcp_hub", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: this.headers },
      });
      const created: HttpMcpConnection = {
        client,
        transport,
        ready: Promise.resolve(),
        inFlight: 0,
        retired: false,
      };
      this.connection = created;
      this.connections.add(created);
      created.ready = client.connect(transport as Parameters<Client["connect"]>[0]).catch((error) => {
        this.retireConnection(created);
        throw error;
      });
      connection = created;
    }
    // Aborting one caller must not cancel a handshake needed by other callers.
    let onAbort!: () => void;
    try {
      await Promise.race([
        connection.ready,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      signal.throwIfAborted();
      if (this.closed) throw new Error(`MCP Hub HTTP connection is closed: ${this.name}`);
      return connection;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * A Hub adapter for an existing Eco built-in HTTP gateway.
 *
 * Each thread gets its own MCP SDK client and transport. The adapter receives
 * the Hub session on every operation, so a call can never accidentally use a
 * different thread's gateway token when sessions run concurrently.
 */
class ThreadScopedHttpMcpHubServer implements McpHubServer {
  readonly name: string;
  private readonly entries = new Map<
    string,
    { url: string; headers: Record<string, string>; requestTimeoutMs?: number; fingerprint: string }
  >();
  private readonly connections = new Map<string, HttpMcpHubServer>();

  constructor(name: string) {
    this.name = name;
  }

  setThreadEntry(threadId: string, sdkEntry: Record<string, unknown>): void {
    const entry = parseHttpSdkEntry(sdkEntry);
    const fingerprint = JSON.stringify(entry);
    const current = this.entries.get(threadId);
    if (current?.fingerprint === fingerprint) return;
    const connection = this.connections.get(threadId);
    this.connections.delete(threadId);
    void connection?.close();
    this.entries.set(threadId, { ...entry, fingerprint });
  }

  removeThread(threadId: string): void {
    this.entries.delete(threadId);
    const connection = this.connections.get(threadId);
    this.connections.delete(threadId);
    void connection?.close();
  }

  async listTools(input: {
    signal: AbortSignal;
    session: McpHubSession;
  }): Promise<{ tools: McpToolDefinition[] }> {
    const connection = this.connectionFor(input.session.sessionId);
    return connection.listTools({ signal: input.signal });
  }

  async callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
    session: McpHubSession;
  }): Promise<McpToolCallResult> {
    const connection = this.connectionFor(input.session.sessionId);
    return connection.callTool({ name: input.name, arguments: input.arguments, signal: input.signal });
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    this.entries.clear();
    await Promise.all(connections.map((connection) => connection.close()));
  }

  private connectionFor(threadId: string): HttpMcpHubServer {
    const entry = this.entries.get(threadId);
    if (!entry) {
      throw new Error(`MCP Hub 内置网关未绑定线程：${threadId}`);
    }
    const existing = this.connections.get(threadId);
    if (existing) return existing;
    const connection = new HttpMcpHubServer(
      this.name,
      entry.url,
      entry.headers,
      entry.requestTimeoutMs,
    );
    this.connections.set(threadId, connection);
    return connection;
  }
}

function parseHttpSdkEntry(entry: Record<string, unknown>): {
  url: string;
  headers: Record<string, string>;
  requestTimeoutMs?: number;
} {
  const type = typeof entry.type === "string" ? entry.type : "http";
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  if (type !== "http" || !url) {
    throw new Error("线程级 Hub 内置网关代理只支持 HTTP Streamable MCP sdkEntry");
  }
  const requestTimeoutMs = resolveMcpRequestTimeoutMs(entry);
  return {
    url,
    headers: recordOfStrings(entry.headers),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
  };
}

function resolveMcpRequestTimeoutMs(entry: Record<string, unknown>): number | undefined {
  for (const key of ["requestTimeoutMs", "timeout"] as const) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeServerName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function convertToolPattern(pattern: string): string | undefined {
  const value = pattern.trim();
  if (!value) return undefined;
  if (value === "*") return "*";
  if (value.startsWith("mcp__")) {
    const rest = value.slice(5);
    const separator = rest.indexOf("__");
    if (separator > 0) {
      const server = normalizeServerName(rest.slice(0, separator));
      const tool = rest.slice(separator + 2).trim();
      return server && tool ? `${server}:${tool}` : undefined;
    }
  }
  return value.includes(":") ? value : undefined;
}

function patternMatchesServer(pattern: string, server: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.startsWith("mcp__")) return false;
  const rest = pattern.slice(5);
  const separator = rest.indexOf("__");
  return separator > 0 && normalizeServerName(rest.slice(0, separator)) === server;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) as Record<string, string>;
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
  return isRecord(value) && typeof value.name === "string";
}

function normalizeToolCallResult(value: unknown): McpToolCallResult {
  if (isRecord(value)) return value as McpToolCallResult;
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function sameEntry(state: HubServerState, entry: Record<string, unknown>): boolean {
  return Boolean(state.sourceEntry && JSON.stringify(state.sourceEntry) === JSON.stringify(entry));
}
