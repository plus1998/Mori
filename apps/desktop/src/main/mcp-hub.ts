import type { McpStreamableHttpHandlers, McpToolCallResult, McpToolDefinition } from "./mcp-streamable-http";
import type { McpHubServiceDirectoryEntry } from "../shared/mcp-hub-tool-usage";

export type McpHubSession = {
  sessionId: string;
  token: string;
  parentSessionId?: string;
  /** Internal binding anchor; prevents a revoked parent id being rebound. */
  parentToken?: string;
  allowedServers: ReadonlySet<string>;
  allowedTools: ReadonlySet<string>;
  deniedTools: ReadonlySet<string>;
  allowAllTools: boolean;
};

export type McpHubServer = {
  name: string;
  /**
   * The bound session is supplied to adapters so a thread-scoped proxy can
   * select the matching upstream credential. Adapters that do not need
   * session context may ignore it.
   */
  listTools: (input: { signal: AbortSignal; session: McpHubSession }) => Promise<{ tools: McpToolDefinition[] }>;
  callTool: (input: {
    name: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
    session: McpHubSession;
  }) => Promise<McpToolCallResult>;
};

export type McpHubSearchResult = {
  tools: McpToolDefinition[];
  total: number;
  hasMore: boolean;
};

export type McpHubAuditEvent = {
  kind: "search" | "call" | "deny";
  sessionId: string;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  at: string;
};

/**
 * Session-aware MCP directory and dispatcher.
 *
 * Runtime adapters should expose this class through the fixed `search_tools`
 * and `call_tool` wrapper. The session token is resolved by Eco before a call
 * reaches this class; model-provided session identifiers are never accepted.
 */
export class McpHub {
  private readonly servers = new Map<string, McpHubServer>();
  private readonly sessions = new Map<string, McpHubSession>();
  private readonly catalog = new Map<string, McpToolDefinition>();

  constructor(
    private readonly hooks: {
      authorizeCall?: (input: {
        session: McpHubSession;
        server: string;
        tool: string;
        arguments: Record<string, unknown>;
      }) => Promise<void> | void;
      onAudit?: (event: McpHubAuditEvent) => void;
    } = {},
  ) {}

  registerServer(server: McpHubServer): void {
    const name = normalizeServerName(server.name);
    if (!name) throw new Error("MCP Hub server name is required");
    // Keep prototype methods and their `this` binding. A class-backed adapter
    // (for example the HTTP upstream bridge) would lose its methods if we
    // copied it with object spread here.
    this.servers.set(name, {
      name,
      listTools: server.listTools.bind(server),
      callTool: server.callTool.bind(server),
    });
    for (const [toolId] of this.catalog) {
      if (toolId.startsWith(`${name}:`)) this.catalog.delete(toolId);
    }
  }

  unregisterServer(name: string): void {
    const key = normalizeServerName(name);
    this.servers.delete(key);
    for (const [toolId] of this.catalog) {
      if (toolId.startsWith(`${key}:`)) this.catalog.delete(toolId);
    }
  }

  bindSession(input: {
    sessionId: string;
    token: string;
    parentSessionId?: string;
    allowedServers?: Iterable<string>;
    allowedTools?: Iterable<string>;
  }): McpHubSession {
    const sessionId = input.sessionId.trim();
    const token = input.token.trim();
    if (!sessionId || !token) throw new Error("MCP Hub session id and token are required");
    const parent = input.parentSessionId
      ? [...this.sessions.values()].find((candidate) => candidate.sessionId === input.parentSessionId)
      : undefined;
    const allowedServers = new Set([...(input.allowedServers ?? this.servers.keys())].map(normalizeServerName));
    const allowAllTools = input.allowedTools === undefined;
    const allowedTools = new Set([...(input.allowedTools ?? [])].map(canonicalToolId));
    if (parent) {
      for (const server of allowedServers)
        if (!parent.allowedServers.has(server)) allowedServers.delete(server);
      for (const tool of allowedTools) {
        if (!parent.allowAllTools && !parent.allowedTools.has(tool)) allowedTools.delete(tool);
      }
    }
    const session: McpHubSession = {
      sessionId,
      token,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(parent ? { parentToken: parent.token } : {}),
      allowedServers,
      allowedTools,
      deniedTools: new Set(),
      allowAllTools,
    };
    this.sessions.set(token, session);
    return session;
  }

  revokeToken(token: string): void {
    const revoked = token.trim();
    if (!revoked) return;
    const pending = [revoked];
    while (pending.length > 0) {
      const current = pending.pop()!;
      this.sessions.delete(current);
      for (const [childToken, session] of this.sessions) {
        if (session.parentToken === current) pending.push(childToken);
      }
    }
  }

  resolveSession(token: string | undefined): McpHubSession {
    const session = token ? this.sessions.get(token.trim()) : undefined;
    if (!session) throw new Error("MCP Hub session credential is missing or invalid");
    if (session.parentSessionId) {
      const parent = this.parentSession(session);
      if (!parent) throw new Error("MCP Hub parent session is no longer valid");
    }
    return session;
  }

  revokeTool(input: { token: string; toolId: string }): void {
    const session = this.resolveSession(input.token);
    const toolId = canonicalToolId(input.toolId);
    const deniedTools = new Set(session.deniedTools);
    deniedTools.add(toolId);
    const allowedTools = new Set(session.allowedTools);
    allowedTools.delete(toolId);
    this.sessions.set(session.token, { ...session, allowedTools, deniedTools });
  }

  /** Read only selected session-authorized services; never expose schemas in the initial directory. */
  async listServiceDirectory(input: {
    token: string;
    servers: Iterable<string>;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<McpHubServiceDirectoryEntry[]> {
    const session = this.resolveSession(input.token);
    const allowedServers = this.effectiveServers(session);
    const names = [...new Set([...input.servers].map(normalizeServerName))]
      .filter((name) => allowedServers.has(name))
      .sort();
    const listed = await Promise.allSettled(names.map(async (name) => {
      const server = this.servers.get(name);
      if (!server) throw new Error(`MCP Hub server unavailable: ${name}`);
      const timeout = AbortSignal.timeout(input.timeoutMs ?? 10_000);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      signal.throwIfAborted();
      let onAbort: (() => void) | undefined;
      try {
        return await Promise.race([
          server.listTools({ signal, session }),
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    }));
    input.signal?.throwIfAborted();
    // Permissions may have changed while metadata was in flight.
    const current = this.resolveSession(input.token);
    const currentServers = this.effectiveServers(current);
    const policy = this.effectiveToolPolicy(current);
    return names.flatMap((server, index) => {
      if (!currentServers.has(server)) return [];
      const result = listed[index]!;
      if (result.status === "rejected") {
        return [{ server, tools: [], error: result.reason instanceof Error ? result.reason.message : String(result.reason) }];
      }
      const tools = result.value.tools.flatMap((tool) => {
        const leaf = typeof tool.name === "string" ? tool.name.trim() : "";
        const name = `${server}:${leaf}`;
        if (!leaf || !isToolAuthorized(policy, name, leaf)) return [];
        return [{ name, ...(typeof tool.description === "string" ? { description: tool.description } : {}) }];
      });
      return [{ server, tools }];
    });
  }

  async searchTools(input: {
    token: string;
    query?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<McpHubSearchResult> {
    const session = this.resolveSession(input.token);
    const query = String(input.query ?? "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)));
    const visible: McpToolDefinition[] = [];
    for (const [serverName, server] of this.servers) {
      if (!this.effectiveServers(session).has(serverName)) continue;
      const listed = await server.listTools({
        signal: input.signal ?? new AbortController().signal,
        session,
      });
      for (const tool of listed.tools) {
        const leaf = typeof tool.name === "string" ? tool.name.trim() : "";
        if (!leaf) continue;
        const toolId = `${serverName}:${leaf}`;
        const policy = this.effectiveToolPolicy(session);
        if (!isToolAuthorized(policy, toolId, leaf)) continue;
        if (query && !`${toolId} ${tool.description ?? ""}`.toLowerCase().includes(query)) continue;
        this.catalog.set(toolId, { ...tool, name: toolId });
        visible.push({ ...tool, name: toolId });
      }
    }
    this.hooks.onAudit?.({ kind: "search", sessionId: session.sessionId, at: new Date().toISOString() });
    return { tools: visible.slice(0, limit), total: visible.length, hasMore: visible.length > limit };
  }

  async callTool(input: {
    token: string;
    toolId: string;
    arguments?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<McpToolCallResult> {
    const session = this.resolveSession(input.token);
    const toolId = canonicalToolId(input.toolId);
    const separator = toolId.indexOf(":");
    if (separator <= 0) throw new Error(`Invalid MCP Hub tool id: ${input.toolId}`);
    const serverName = toolId.slice(0, separator);
    const toolName = toolId.slice(separator + 1);
    if (!this.effectiveServers(session).has(serverName)) {
      this.hooks.onAudit?.({
        kind: "deny",
        sessionId: session.sessionId,
        server: serverName,
        tool: toolName,
        at: new Date().toISOString(),
      });
      throw new Error(`MCP Hub server denied: ${serverName}`);
    }
    const policy = this.effectiveToolPolicy(session);
    if (policy.denied.has(toolId) || policy.denied.has(toolName) || (!policy.allowAll && !matchesTool(policy.tools, toolId, toolName))) {
      this.hooks.onAudit?.({
        kind: "deny",
        sessionId: session.sessionId,
        server: serverName,
        tool: toolName,
        at: new Date().toISOString(),
      });
      throw new Error(`MCP Hub tool denied: ${toolId}`);
    }
    const server = this.servers.get(serverName);
    if (!server) throw new Error(`MCP Hub server unavailable: ${serverName}`);
    await this.hooks.authorizeCall?.({
      session,
      server: serverName,
      tool: toolName,
      arguments: input.arguments ?? {},
    });
    this.hooks.onAudit?.({
      kind: "call",
      sessionId: session.sessionId,
      server: serverName,
      tool: toolName,
      arguments: input.arguments ?? {},
      at: new Date().toISOString(),
    });
    return server.callTool({
      name: toolName,
      arguments: input.arguments ?? {},
      signal: input.signal ?? new AbortController().signal,
      session,
    });
  }

  private effectiveServers(session: McpHubSession): Set<string> {
    const result = new Set(session.allowedServers);
    if (session.parentSessionId) {
      const parent = this.parentSession(session);
      if (parent)
        for (const server of result) if (!this.effectiveServers(parent).has(server)) result.delete(server);
    }
    return result;
  }

  private effectiveToolPolicy(session: McpHubSession): {
    allowAll: boolean;
    tools: Set<string>;
    denied: Set<string>;
  } {
    const result = new Set(session.allowedTools);
    const denied = new Set(session.deniedTools);
    if (session.parentSessionId) {
      const parent = this.parentSession(session);
      if (parent) {
        const inherited = this.effectiveToolPolicy(parent);
        for (const tool of inherited.denied) denied.add(tool);
        if (inherited.allowAll) return { allowAll: session.allowAllTools, tools: result, denied };
        if (session.allowAllTools) return { ...inherited, denied };
        for (const tool of result) if (!inherited.tools.has(tool)) result.delete(tool);
      }
    }
    return { allowAll: session.allowAllTools, tools: result, denied };
  }

  private parentSession(session: McpHubSession): McpHubSession | undefined {
    if (!session.parentSessionId) return undefined;
    const parent = session.parentToken ? this.sessions.get(session.parentToken) : undefined;
    return parent?.sessionId === session.parentSessionId ? parent : undefined;
  }

  /** Adapter for Eco's Streamable HTTP transport. */
  createStreamableHttpHandlers(): McpStreamableHttpHandlers {
    return {
      serverName: "eco_mcp",
      instructions: "Search the session-authorized MCP catalog, then call a returned tool id.",
      listTools: async () => ({
        tools: [
          {
            name: "search_tools",
            description: "Search tools authorized for this Eco session.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "number" } },
              additionalProperties: false,
            },
          },
          {
            name: "call_tool",
            description: "Call an authorized tool returned by search_tools.",
            inputSchema: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" }, arguments: { type: "object" } },
              additionalProperties: false,
            },
          },
        ],
      }),
      callTool: async ({ name, arguments: args, authToken, signal }) => {
        if (!authToken) throw new Error("MCP Hub bearer credential is required");
        if (name === "search_tools") {
          const result = await this.searchTools({
            token: authToken,
            ...(typeof args.query === "string" ? { query: args.query } : {}),
            ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
            signal,
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
        }
        if (name === "call_tool") {
          const toolId = typeof args.name === "string" ? args.name : "";
          const nested =
            args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
              ? (args.arguments as Record<string, unknown>)
              : {};
          return this.callTool({ token: authToken, toolId, arguments: nested, signal });
        }
        throw new Error(`MCP Hub exposes only search_tools and call_tool (got ${name})`);
      },
    };
  }
}

function matchesTool(allowed: ReadonlySet<string>, toolId: string, leaf: string): boolean {
  return [...allowed].some((pattern) => {
    if (pattern === "*" || pattern === toolId || pattern === leaf) return true;
    if (pattern.endsWith("*") && toolId.startsWith(pattern.slice(0, -1))) return true;
    return false;
  });
}

function isToolAuthorized(
  policy: { allowAll: boolean; tools: ReadonlySet<string>; denied: ReadonlySet<string> },
  toolId: string,
  leaf: string,
): boolean {
  return !policy.denied.has(toolId) && !policy.denied.has(leaf)
    && (policy.allowAll || matchesTool(policy.tools, toolId, leaf));
}

function canonicalToolId(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0) return trimmed;
  const server = normalizeServerName(trimmed.slice(0, separator));
  const tool = trimmed.slice(separator + 1).trim();
  return server && tool ? `${server}:${tool}` : trimmed;
}

function normalizeServerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
