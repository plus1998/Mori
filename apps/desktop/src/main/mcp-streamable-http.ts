/**
 * Minimal MCP Streamable HTTP (JSON response mode) for Eco gateways.
 * Speaks initialize / ping / tools/list / tools/call over POST /mcp and
 * forwards tool ops to the existing private /v1 control handlers.
 *
 * Codex (rmcp) requires notifications (e.g. notifications/initialized) to
 * return HTTP 202 with an empty body — not 200 + a fake JSON-RPC result.
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#sending-messages-to-the-server
 */

import { randomUUID } from "node:crypto";
import type http from "node:http";

export const ECO_MCP_HTTP_PATH = "/mcp";

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
};

export type McpToolCallResult = {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
};

export type McpStreamableHttpHandlers = {
  serverName: string;
  instructions?: string;
  /** Return tool catalog (same shape as /v1/tools/list `tools`). */
  listTools: (input: {
    authToken?: string;
    headers: http.IncomingHttpHeaders;
    /** Aborted when the MCP client disconnects before the response is written. */
    signal: AbortSignal;
  }) => Promise<{
    tools: McpToolDefinition[];
  }>;
  /** Execute a tool (same shape as /v1/tools/call result). */
  callTool: (input: {
    name: string;
    arguments: Record<string, unknown>;
    authToken?: string;
    headers: http.IncomingHttpHeaders;
    /** Aborted when the MCP client disconnects before the response is written. */
    signal: AbortSignal;
  }) => Promise<McpToolCallResult>;
};

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type ActiveMcpRequest = {
  method: string;
  controller: AbortController;
};

type McpSessionState = {
  inFlight: Map<string, ActiveMcpRequest>;
  lastUsedAt: number;
};

/**
 * Streamable HTTP requests arrive on separate HTTP connections. Keep the
 * in-flight table outside a single request so a later
 * `notifications/cancelled` POST can reach the request it names. The key
 * includes the server's trusted control secret, the bearer auth identity and
 * the server-issued MCP session ID; a request ID alone is never sufficient.
 */
const mcpSessions = new Map<string, McpSessionState>();
const MCP_SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const MCP_SESSION_MAX_COUNT = 4096;

function pruneMcpSessions(now = Date.now()): void {
  for (const [key, state] of mcpSessions) {
    if (state.inFlight.size === 0 && now - state.lastUsedAt >= MCP_SESSION_IDLE_TTL_MS) {
      mcpSessions.delete(key);
    }
  }
  if (mcpSessions.size <= MCP_SESSION_MAX_COUNT) return;
  const idle = [...mcpSessions.entries()]
    .filter(([, state]) => state.inFlight.size === 0)
    .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt);
  for (const [key] of idle) {
    if (mcpSessions.size <= MCP_SESSION_MAX_COUNT) break;
    mcpSessions.delete(key);
  }
}

function jsonRpcIdKey(id: unknown): string | undefined {
  if (typeof id === "string" || typeof id === "number") {
    return `${typeof id}:${String(id)}`;
  }
  return undefined;
}

function authScopeKey(
  handlers: McpStreamableHttpHandlers,
  options: { controlSecret?: string } | undefined,
  authToken: string | undefined,
): string {
  // The control secret is checked before this function is reached, so it is
  // the trusted local-gateway identity even when no bearer token is present.
  return JSON.stringify([handlers.serverName, options?.controlSecret ?? "", authToken ?? ""]);
}

function sessionKey(scope: string, sessionId: string): string {
  return `${scope}\u0000${sessionId}`;
}

function registerSession(scope: string, sessionId: string): McpSessionState {
  pruneMcpSessions();
  const key = sessionKey(scope, sessionId);
  let state = mcpSessions.get(key);
  if (!state) {
    state = { inFlight: new Map(), lastUsedAt: Date.now() };
    mcpSessions.set(key, state);
  } else {
    state.lastUsedAt = Date.now();
  }
  return state;
}

function getSession(scope: string, sessionId: string | undefined): McpSessionState | undefined {
  pruneMcpSessions();
  if (!sessionId) return undefined;
  const state = mcpSessions.get(sessionKey(scope, sessionId));
  if (state) state.lastUsedAt = Date.now();
  return state;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" && reason.trim() ? reason : "MCP request cancelled");
  error.name = "AbortError";
  return error;
}

function cancelMcpRequest(state: McpSessionState | undefined, params: unknown): void {
  if (!state || !isRecord(params)) return;
  const requestId = jsonRpcIdKey(params.requestId);
  if (!requestId) return;
  const active = state.inFlight.get(requestId);
  if (!active || active.method === "initialize") return;
  const reason = typeof params.reason === "string" ? params.reason : "MCP request cancelled";
  active.controller.abort(abortError(reason));
}

function beginMcpRequest(
  state: McpSessionState | undefined,
  id: JsonRpcId,
  method: string,
  parentSignal?: AbortSignal,
): { signal: AbortSignal; finish: () => void } | { duplicate: true } {
  const controller = new AbortController();
  const key = jsonRpcIdKey(id);
  if (!state || !key) {
    return { signal: controller.signal, finish: () => undefined };
  }
  if (state.inFlight.has(key)) {
    return { duplicate: true };
  }
  const active = { method, controller };
  state.inFlight.set(key, active);
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: controller.signal,
    finish: () => {
      parentSignal?.removeEventListener("abort", onParentAbort);
      if (state.inFlight.get(key) === active) {
        state.inFlight.delete(key);
      }
    },
  };
}

function extractBearer(headers: http.IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token || undefined;
  }
  return undefined;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...(extraHeaders ?? {}),
  });
  response.end(payload);
}

function sendEmpty(
  response: http.ServerResponse,
  status: number,
  extraHeaders?: Record<string, string>,
): void {
  response.writeHead(status, {
    "Content-Length": 0,
    ...(extraHeaders ?? {}),
  });
  response.end();
}

async function readRawBody(request: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    signal?.throwIfAborted();
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** JSON-RPC 2.0 notification: has `method`, no `id` member (Codex sends these after initialize). */
export function isJsonRpcNotification(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.method !== "string" || !value.method.trim()) {
    return false;
  }
  if (!("id" in value)) {
    return true;
  }
  return value.method.startsWith("notifications/");
}

/**
 * Handle POST /mcp. Returns true when the request was consumed.
 * Caller must already have validated the Eco control secret (or allow this helper to).
 */
export async function handleMcpStreamableHttpRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  handlers: McpStreamableHttpHandlers,
  options?: {
    /** When set, reject unless header matches. */
    controlSecretHeader?: string;
    controlSecret?: string;
  },
): Promise<boolean> {
  const url = (request.url ?? "").split("?")[0] ?? "";
  if (url !== ECO_MCP_HTTP_PATH && !url.startsWith(`${ECO_MCP_HTTP_PATH}/`)) {
    return false;
  }

  if (options?.controlSecretHeader && options.controlSecret) {
    if (request.headers[options.controlSecretHeader.toLowerCase()] !== options.controlSecret) {
      sendJson(response, 401, { error: "unauthorized control secret" });
      return true;
    }
  }

  if (request.method === "GET" || request.method === "DELETE") {
    // JSON-only mode: no long-lived SSE session. Spec: 405 when SSE is unsupported.
    // Codex treats GET 405 as ServerDoesNotSupportSse and continues with POST-only.
    sendEmpty(response, 405, { Allow: "POST" });
    return true;
  }

  if (request.method !== "POST") {
    sendEmpty(response, 405, { Allow: "POST" });
    return true;
  }

  try {
    // Streamable HTTP explicitly says a transport disconnect is not a
    // cancellation signal. A handler therefore receives a signal only when a
    // matching `notifications/cancelled` arrives on the same auth/session
    // scope. A body read that is interrupted simply ends this HTTP exchange;
    // any already-running handler is allowed to finish.
    const raw = await readRawBody(request);
    let parsed: unknown;
    try {
      parsed = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      if (response.destroyed) return true;
      sendJson(response, 400, { error: "invalid json" });
      return true;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const authToken = extractBearer(request.headers);
    const authScope = authScopeKey(handlers, options, authToken);
    const sessionHeader =
      typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined;
    let sessionId = sessionHeader?.trim() || undefined;
    let sessionState = getSession(authScope, sessionId);
    // Eco's built-in gateways historically accepted authenticated one-shot
    // calls without an MCP initialize handshake. Preserve that compatibility
    // while keeping the cancellation table scoped to the bearer identity.
    if (!sessionState && !sessionId && authToken) {
      sessionId = `bearer:${authToken}`;
      sessionState = registerSession(authScope, sessionId);
    }
    const responses: unknown[] = [];
    let sawNotification = false;
    let sawRequest = false;

    for (const entry of messages) {
      if (!isRecord(entry)) continue;
      const method = typeof entry.method === "string" ? entry.method : "";
      if (isJsonRpcNotification(entry)) {
        sawNotification = true;
        if (method === "notifications/cancelled") {
          cancelMcpRequest(sessionState, entry.params);
        }
        continue;
      }
      const msg = entry as JsonRpcRequest;
      if (!method) {
        continue;
      }
      sawRequest = true;
      const id = (msg.id ?? null) as JsonRpcId;

      if (method === "initialize") {
        // Initialization starts a new server-issued session. Never reuse a
        // caller-supplied ID: doing so would let two logical sessions share a
        // cancellation namespace.
        sessionId = randomUUID();
        sessionState = registerSession(authScope, sessionId);
        const protocolVersion =
          typeof msg.params?.protocolVersion === "string" && msg.params.protocolVersion.trim()
            ? msg.params.protocolVersion.trim()
            : "2024-11-05";
        responses.push({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: handlers.serverName, version: "1.0.0" },
            ...(handlers.instructions ? { instructions: handlers.instructions } : {}),
          },
        });
        continue;
      }

      // Once the server has issued a session ID, every request that expects a
      // response must carry that ID. This also prevents a request from one
      // session from entering another session's cancellation table.
      if (!sessionState) {
        if (!response.destroyed) {
          if (sessionId) {
            // The client still holds a session this server no longer knows —
            // the idle TTL evicted it, a gateway restarted, or the session
            // belongs to another auth scope. Streamable HTTP requires 404 for
            // an unrecognized session, and that status is what makes clients
            // recover: Codex (rmcp) and the MCP SDK both transparently
            // re-initialize and re-send the request only on 404. Answering
            // 400 here left long-lived assistant threads permanently unable
            // to call MCP tools after 30 idle minutes, because the client
            // kept reusing the dead session ID.
            sendJson(response, 404, { error: "MCP session not found" });
          } else {
            // No session was offered at all: this is not an expiry signal, the
            // client must start with a fresh initialize handshake.
            sendJson(response, 400, { error: "missing or invalid MCP session id" });
          }
        }
        return true;
      }

      let operation: ReturnType<typeof beginMcpRequest> | undefined;
      try {
        if (method === "ping") {
          responses.push({ jsonrpc: "2.0", id, result: {} });
          continue;
        }
        if (method === "tools/list") {
          operation = beginMcpRequest(sessionState, id, method);
          if ("duplicate" in operation) {
            responses.push({
              jsonrpc: "2.0",
              id,
              error: { code: -32600, message: "request id is already in progress" },
            });
            continue;
          }
          const listed = await handlers.listTools({
            ...(authToken ? { authToken } : {}),
            headers: request.headers,
            signal: operation.signal,
          });
          if (operation.signal.aborted) continue;
          responses.push({
            jsonrpc: "2.0",
            id,
            result: { tools: listed.tools ?? [] },
          });
          continue;
        }
        if (method === "tools/call") {
          const params = isRecord(msg.params) ? msg.params : {};
          const name = typeof params.name === "string" ? params.name : "";
          if (!name) {
            throw new Error("tools/call requires name");
          }
          const args = isRecord(params.arguments) ? params.arguments : {};
          operation = beginMcpRequest(sessionState, id, method);
          if ("duplicate" in operation) {
            responses.push({
              jsonrpc: "2.0",
              id,
              error: { code: -32600, message: "request id is already in progress" },
            });
            continue;
          }
          const result = await handlers.callTool({
            name,
            arguments: args,
            ...(authToken ? { authToken } : {}),
            headers: request.headers,
            signal: operation.signal,
          });
          if (operation.signal.aborted) continue;
          responses.push({ jsonrpc: "2.0", id, result });
          continue;
        }
        responses.push({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      } catch (error) {
        if (operation && "signal" in operation && operation.signal.aborted) continue;
        if (response.destroyed) return true;
        responses.push({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        if (operation && "finish" in operation) {
          operation.finish();
        }
      }
    }

    // Spec: notification-only POST → 202 Accepted, empty body (Codex handshake).
    if (!sawRequest && sawNotification) {
      if (response.destroyed) return true;
      sendEmpty(response, 202, sessionId ? { "Mcp-Session-Id": sessionId } : undefined);
      return true;
    }

    if (!sawRequest) {
      if (response.destroyed) return true;
      sendJson(response, 400, { error: "expected JSON-RPC request or notification" });
      return true;
    }

    // A request that was cancelled must not receive a JSON-RPC response. End
    // the corresponding POST with an empty accepted response so the HTTP
    // exchange does not hang; mixed batches still return surviving responses.
    if (responses.length === 0) {
      if (response.destroyed) return true;
      sendEmpty(response, 202, sessionId ? { "Mcp-Session-Id": sessionId } : undefined);
      return true;
    }

    const body = Array.isArray(parsed) ? responses : (responses[0] ?? { jsonrpc: "2.0", result: {} });
    if (response.destroyed) return true;
    sendJson(response, 200, body, sessionId ? { "Mcp-Session-Id": sessionId } : undefined);
    return true;
  } catch (error) {
    if (request.destroyed || response.destroyed) {
      return true;
    }
    throw error;
  }
}

export function mcpHttpUrl(controlBaseUrl: string): string {
  return `${controlBaseUrl.replace(/\/$/, "")}${ECO_MCP_HTTP_PATH}`;
}

/**
 * Codex-shaped Streamable HTTP handshake against an Eco gateway `/mcp`.
 * Catches dead ports, bad control secrets, and notification/202 incompatibilities
 * before Codex app-server swallows them as a silent "handshake failed".
 */
export async function probeCodexStyleHttpMcpHandshake(input: {
  name: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<{ toolCount: number }> {
  const headers: Record<string, string> = {
    accept: "text/event-stream, application/json",
    "content-type": "application/json",
    ...(input.headers ?? {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  try {
    const initRes = await fetch(input.url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "eco_handshake_probe", version: "1.0.0" },
        },
      }),
    });
    if (initRes.status !== 200) {
      throw new Error(`initialize HTTP ${initRes.status}`);
    }
    const sessionId = initRes.headers.get("mcp-session-id");
    await initRes.json().catch(() => undefined);

    const notified = await fetch(input.url, {
      method: "POST",
      headers: {
        ...headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    if (notified.status !== 202) {
      const body = await notified.text().catch(() => "");
      throw new Error(
        `notifications/initialized expected HTTP 202 (empty), got ${notified.status}${
          body ? `: ${body.slice(0, 200)}` : ""
        }`,
      );
    }

    const listRes = await fetch(input.url, {
      method: "POST",
      headers: {
        ...headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    if (listRes.status !== 200) {
      throw new Error(`tools/list HTTP ${listRes.status}`);
    }
    const listBody = (await listRes.json()) as {
      result?: { tools?: unknown[] };
      error?: { message?: string };
    };
    if (listBody.error) {
      throw new Error(`tools/list error: ${listBody.error.message ?? JSON.stringify(listBody.error)}`);
    }
    if (!Array.isArray(listBody.result?.tools)) {
      throw new Error("tools/list missing tools array");
    }
    return { toolCount: listBody.result.tools.length };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Mori HTTP MCP \`${input.name}\` Codex 握手探测失败（${input.url}）：${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Probe Eco-hosted HTTP MCP entries that will be written into Codex config.toml. */
export async function assertEcoHttpMcpServersReachable(
  servers: ReadonlyArray<{
    name: string;
    transport: string;
    url?: string;
    httpHeaders?: Record<string, string>;
  }>,
  onLog?: (message: string) => void,
): Promise<void> {
  for (const server of servers) {
    if (server.transport !== "http" || !server.url?.trim()) {
      continue;
    }
    // Only Eco-hosted builtins — do not block prepare on arbitrary user HTTP MCPs.
    if (!server.name.startsWith("eco_")) {
      continue;
    }
    const result = await probeCodexStyleHttpMcpHandshake({
      name: server.name,
      url: server.url.trim(),
      ...(server.httpHeaders ? { headers: server.httpHeaders } : {}),
    });
    onLog?.(
      `[eco-codex] http mcp handshake ok name=${server.name} tools=${result.toolCount} url=${server.url}`,
    );
  }
}
