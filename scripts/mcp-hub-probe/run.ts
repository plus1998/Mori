/**
 * Minimal Eco MCP Hub probe.
 *
 * Run with:
 *   bun scripts/mcp-hub-probe/run.ts
 *
 * The probe deliberately exposes only `search_tools` and `call_tool`.  The
 * virtual upstream tools are returned only after search and are never included
 * in tools/list.  Credentials are bearer tokens minted by this probe; logs
 * retain only a short SHA-256 fingerprint.
 */

import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  handleMcpStreamableHttpRequest,
  probeCodexStyleHttpMcpHandshake,
  type McpToolCallResult,
  type McpToolDefinition,
} from "../../apps/desktop/src/main/mcp-streamable-http";
import { BrowserMcpToolClaimRouter } from "../../apps/desktop/src/main/browser-mcp-router";
import { prepareMcpSdkConfigForRuntime } from "../../apps/desktop/src/main/mcp-runtime";
import {
  buildMcpSdkConfig,
  buildCodexMcpServersForConfigSync,
  type McpServerConfigView,
} from "../../apps/desktop/src/shared/mcp";
import { prepareCodexMcpServersForRuntime } from "../../apps/desktop/src/main/mcp-runtime";
import { resolveSdkSessionOptions, ClaudeAgentSdkDriver } from "../../packages/runtime/src/claude-agent-sdk";
import type { AgentRuntimeRunInput } from "../../packages/runtime/src/index";
import { createPiMcpExtensionFactory } from "../../packages/runtime/src/pi-mcp-extension-factory";
import { piToolsForSessionMode } from "../../packages/runtime/src/pi-session-mode";
import { AcpAgentDriver } from "../../packages/runtime/src/acp-agent-driver";
import { toAcpMcpServers } from "../../packages/runtime/src/acp-mcp";
import { readCodexDependencyPins, readCodexCliVersion } from "../../packages/runtime/src/codex-version";

type Identity = "A" | "B" | "A-child";
type ApprovalDecision = "allow" | "reject";

type SessionRecord = {
  identity: Identity;
  token: string;
  parent?: Identity;
  allowed: Set<string>;
};

type ProbeLog = Record<string, unknown>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const codexHarnessExecutable = path.join(repoRoot, "apps/desktop/node_modules/.bin/codex");

const VIRTUAL_TOOLS: Record<string, McpToolDefinition> = {
  echo_context: {
    name: "echo_context",
    description: "Return server-derived connection identity and request metadata.",
    inputSchema: {
      type: "object",
      properties: {
        clientSessionId: { type: "string", description: "Ignored; intentionally untrusted." },
        marker: { type: "string" },
      },
      additionalProperties: true,
    },
  },
  restricted_probe_x: {
    name: "restricted_probe_x",
    description: "Permission probe X.",
    inputSchema: { type: "object", properties: { marker: { type: "string" } }, additionalProperties: true },
  },
  restricted_probe_y: {
    name: "restricted_probe_y",
    description: "Permission probe Y.",
    inputSchema: { type: "object", properties: { marker: { type: "string" } }, additionalProperties: true },
  },
  mock_write: {
    name: "mock_write",
    description: "Approval probe. Increments only after an allow decision.",
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "string" }, clientSessionId: { type: "string" } },
      additionalProperties: true,
    },
  },
  slow_probe: {
    name: "slow_probe",
    description: "Delayed probe used to observe timeout and disconnect behavior.",
    inputSchema: { type: "object", properties: { delayMs: { type: "number" } }, additionalProperties: true },
  },
  result_probe: {
    name: "result_probe",
    description: "Returns text, image, structuredContent, and an explicit success result.",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
  },
};

const HUB_TOOLS: McpToolDefinition[] = [
  {
    name: "search_tools",
    description: "Search tools that this session is authorized to use. Results include schemas.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      additionalProperties: false,
    },
  },
  {
    name: "call_tool",
    description: "Call an authorized upstream tool returned by search_tools.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        arguments: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
];

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function safeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (/token|secret|password|authorization|api[_-]?key/i.test(key)) {
      output[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      output[key] = safeArgs(value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function textResult(text: string, extra: Record<string, unknown> = {}): McpToolCallResult {
  return { content: [{ type: "text", text }], ...extra };
}

export class HubState {
  readonly logs: ProbeLog[] = [];
  readonly sessions = new Map<string, SessionRecord>();
  readonly approval = new Map<Identity, ApprovalDecision>();
  readonly approvalEvents: ProbeLog[] = [];
  mockWriteCount = 0;
  slowStarted = 0;
  slowCompleted = 0;
  slowCancelled = 0;
  disconnected = 0;
  private requestCount = 0;

  issue(identity: Identity, allowed: Iterable<string>, parent?: Identity): SessionRecord {
    const token = `probe_${randomUUID().replaceAll("-", "")}`;
    const record: SessionRecord = { identity, token, allowed: new Set(allowed), ...(parent ? { parent } : {}) };
    this.sessions.set(token, record);
    this.logs.push({
      event: "session_bound",
      identity,
      tokenFingerprint: fingerprint(token),
      ...(parent ? { parent } : {}),
    });
    return record;
  }

  find(authToken: string | undefined): SessionRecord {
    const record = authToken ? this.sessions.get(authToken) : undefined;
    if (!record) throw new Error("missing or invalid Hub credential");
    return record;
  }

  effectiveAllowed(record: SessionRecord): Set<string> {
    const result = new Set(record.allowed);
    if (record.parent) {
      const parent = [...this.sessions.values()].find((candidate) => candidate.identity === record.parent);
      if (parent) {
        const parentAllowed = this.effectiveAllowed(parent);
        for (const tool of result) if (!parentAllowed.has(tool)) result.delete(tool);
      }
    }
    return result;
  }

  nextRequest(identity: Identity, name: string, args: Record<string, unknown>): string {
    const requestId = `req_${++this.requestCount}`;
    this.logs.push({
      event: "upstream_call",
      phase: "started",
      requestId,
      identity,
      tool: name,
      args: safeArgs(args),
    });
    return requestId;
  }

  completeRequest(requestId: string, identity: Identity, name: string, result: "ok" | "error"): void {
    this.logs.push({ event: "upstream_call", phase: "completed", requestId, identity, tool: name, result });
  }

  revoke(identity: Identity, tool: string): void {
    for (const record of this.sessions.values()) {
      if (record.identity === identity) record.allowed.delete(tool);
    }
    this.logs.push({ event: "permission_revoked", identity, tool });
  }

  listTools(authToken?: string): { tools: McpToolDefinition[] } {
    const record = this.find(authToken);
    this.logs.push({ event: "tools_list", identity: record.identity, tokenFingerprint: fingerprint(record.token) });
    return { tools: HUB_TOOLS };
  }

  async callTool(input: {
    name: string;
    arguments: Record<string, unknown>;
    authToken?: string;
    signal?: AbortSignal;
  }): Promise<McpToolCallResult> {
    const record = this.find(input.authToken);
    if (input.name === "search_tools") {
      const query = typeof input.arguments.query === "string" ? input.arguments.query.toLowerCase().trim() : "";
      const limit = typeof input.arguments.limit === "number" && input.arguments.limit > 0 ? input.arguments.limit : 50;
      const allowed = this.effectiveAllowed(record);
      const tools = Object.values(VIRTUAL_TOOLS).filter(
        (tool) => allowed.has(tool.name) && (!query || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query)),
      );
      const page = tools.slice(0, limit);
      const result = {
        tools: page,
        total: tools.length,
        hasMore: tools.length > page.length,
        permissionSource: record.parent ? { kind: "parent_session", parent: record.parent } : { kind: "session_binding" },
      };
      this.logs.push({ event: "search_tools", identity: record.identity, query, returned: page.map((tool) => tool.name) });
      return textResult(JSON.stringify(result), { structuredContent: result });
    }
    if (input.name !== "call_tool") {
      throw new Error(`Hub exposes only search_tools and call_tool (got ${input.name})`);
    }
    const nestedName = typeof input.arguments.name === "string" ? input.arguments.name.trim() : "";
    const nestedArgs =
      input.arguments.arguments && typeof input.arguments.arguments === "object" && !Array.isArray(input.arguments.arguments)
        ? (input.arguments.arguments as Record<string, unknown>)
        : {};
    if (!nestedName) throw new Error("call_tool requires name");
    const allowed = this.effectiveAllowed(record);
    // The two Hub primitives are always available; only their virtual
    // upstream targets are subject to the session policy.
    if (nestedName !== "search_tools" && !allowed.has(nestedName)) {
      this.logs.push({ event: "upstream_call", phase: "rejected", identity: record.identity, tool: nestedName, args: safeArgs(nestedArgs) });
      throw new Error(`permission denied for ${nestedName}`);
    }
    if (nestedName === "search_tools") {
      const query = typeof nestedArgs.query === "string" ? nestedArgs.query.toLowerCase().trim() : "";
      const limit = typeof nestedArgs.limit === "number" && nestedArgs.limit > 0 ? nestedArgs.limit : 50;
      const tools = Object.values(VIRTUAL_TOOLS).filter(
        (tool) => allowed.has(tool.name) && (!query || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query)),
      );
      const page = tools.slice(0, limit);
      const result = {
        tools: page,
        total: tools.length,
        hasMore: tools.length > page.length,
        permissionSource: record.parent ? { kind: "parent_session", parent: record.parent } : { kind: "session_binding" },
      };
      this.logs.push({ event: "search_tools", identity: record.identity, query, returned: page.map((tool) => tool.name) });
      return textResult(JSON.stringify(result), { structuredContent: result });
    }
    // Approval must happen before an upstream execution is recorded.  The
    // rejected path therefore has no `upstream_call/started` event at all.
    if (nestedName === "mock_write") {
      const decision = this.approval.get(record.identity) ?? "reject";
      const approvalRequestId = `approval_${++this.requestCount}`;
      this.approvalEvents.push({
        identity: record.identity,
        tool: nestedName,
        args: safeArgs(nestedArgs),
        decision,
        requestId: approvalRequestId,
      });
      if (decision !== "allow") {
        this.logs.push({
          event: "approval_rejected",
          requestId: approvalRequestId,
          identity: record.identity,
          tool: nestedName,
          args: safeArgs(nestedArgs),
        });
        return textResult("mock_write rejected by Hub approval", {
          isError: true,
          structuredContent: { identity: record.identity, tool: nestedName, requestId: approvalRequestId, decision },
        });
      }
      const requestId = this.nextRequest(record.identity, nestedName, nestedArgs);
      this.mockWriteCount += 1;
      this.completeRequest(requestId, record.identity, nestedName, "ok");
      return textResult("mock_write applied", {
        structuredContent: { identity: record.identity, tool: nestedName, requestId, count: this.mockWriteCount },
      });
    }

    const requestId = this.nextRequest(record.identity, nestedName, nestedArgs);
    try {
      if (nestedName === "echo_context") {
        const context = {
          identity: record.identity,
          credentialFingerprint: fingerprint(record.token),
          requestId,
          clientSessionIdIgnored: typeof nestedArgs.clientSessionId === "string" ? nestedArgs.clientSessionId : undefined,
        };
        this.completeRequest(requestId, record.identity, nestedName, "ok");
        return textResult(JSON.stringify(context), { structuredContent: context });
      }
      if (nestedName === "restricted_probe_x" || nestedName === "restricted_probe_y") {
        const result = { identity: record.identity, tool: nestedName, marker: nestedArgs.marker ?? null, requestId };
        this.completeRequest(requestId, record.identity, nestedName, "ok");
        return textResult(JSON.stringify(result), { structuredContent: result });
      }
      if (nestedName === "slow_probe") {
        const delayMs = Math.max(10, Math.min(2_000, Number(nestedArgs.delayMs ?? 250)));
        this.slowStarted += 1;
        try {
          await waitWithAbort(delayMs, input.signal);
        } catch (error) {
          if (input.signal?.aborted) {
            this.slowCancelled += 1;
            this.logs.push({ event: "upstream_call", phase: "cancelled", requestId, identity: record.identity, tool: nestedName });
          }
          throw error;
        }
        this.slowCompleted += 1;
        this.completeRequest(requestId, record.identity, nestedName, "ok");
        return textResult(`slow_probe completed after ${delayMs}ms`, { structuredContent: { requestId, delayMs } });
      }
      if (nestedName === "result_probe") {
        this.completeRequest(requestId, record.identity, nestedName, "ok");
        return {
          content: [
            { type: "text", text: "result_probe text" },
            { type: "image", data: PNG_1X1, mimeType: "image/png" },
          ],
          structuredContent: { identity: record.identity, requestId, ok: true },
          isError: false,
        };
      }
      throw new Error(`unknown upstream tool ${nestedName}`);
    } catch (error) {
      this.completeRequest(requestId, record.identity, nestedName, "error");
      throw error;
    }
  }
}

export type RunningHub = {
  url: string;
  state: HubState;
  server: http.Server;
  close: () => Promise<void>;
};

export async function startHub(): Promise<RunningHub> {
  const state = new HubState();
  const server = http.createServer((request, response) => {
    response.on("close", () => {
      state.disconnected += 1;
      state.logs.push({ event: "http_connection_closed" });
    });
    void handleMcpStreamableHttpRequest(
      request,
      response,
      {
        serverName: "eco_mcp_probe",
        instructions: "Probe Hub. Only search_tools and call_tool are exposed.",
        listTools: async ({ authToken }) => state.listTools(authToken),
        callTool: async ({ name, arguments: args, authToken, signal }) =>
          state.callTool({ name, arguments: args, authToken, signal }),
      },
    ).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Hub did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    state,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function waitWithAbort(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("MCP request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export type RpcReply = { status: number; headers: Headers; body: Record<string, any> };

export async function rpc(
  url: string,
  token: string | undefined,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
  options: { signal?: AbortSignal; sessionId?: string } = {},
): Promise<RpcReply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    signal: options.signal,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, any>;
  return { status: response.status, headers: response.headers, body };
}

export function nestedParams(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "call_tool", arguments: { name, arguments: args } };
}

async function initialize(url: string, token: string): Promise<{ sessionId: string; reply: RpcReply }> {
  const reply = await rpc(url, token, 0, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "eco_mcp_probe", version: "0.1.0" },
  });
  if (reply.status !== 200 || !reply.body.result) throw new Error(`initialize failed: ${JSON.stringify(reply.body)}`);
  const sessionId = reply.headers.get("mcp-session-id") ?? "";
  if (!sessionId) throw new Error("initialize did not return mcp-session-id");
  return { sessionId, reply };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

async function runHubExperiments(hub: RunningHub, a: SessionRecord, b: SessionRecord) {
  const state = hub.state;
  const child = state.issue("A-child", ["echo_context", "restricted_probe_x"], "A");
  state.approval.set("A", "reject");
  state.approval.set("B", "allow");

  const initializedA = await initialize(hub.url, a.token);
  const initializedB = await initialize(hub.url, b.token);
  const listA = await rpc(hub.url, a.token, 1, "tools/list", {}, { sessionId: initializedA.sessionId });
  assert(
    JSON.stringify(listA.body.result?.tools?.map((tool: McpToolDefinition) => tool.name)) ===
      JSON.stringify(["search_tools", "call_tool"]),
    "tools/list leaked a virtual upstream tool",
  );

  const searchA = await rpc(hub.url, a.token, 2, "tools/call", nestedParams("search_tools", { query: "echo" }));
  const searchToolsA = searchA.body.result?.structuredContent?.tools ?? [];
  assert(searchToolsA.some((tool: McpToolDefinition) => tool.name === "echo_context"), `search did not return echo_context: ${JSON.stringify(searchA.body)}`);
  assert(!listA.body.result.tools.some((tool: McpToolDefinition) => tool.name === "echo_context"), "echo_context was pre-injected");
  assert(searchToolsA[0]?.inputSchema, "search result did not include inputSchema");

  const echoA = await rpc(
    hub.url,
    a.token,
    3,
    "tools/call",
    nestedParams("echo_context", { clientSessionId: "B-fake-model-field", marker: "A" }),
  );
  assert(echoA.body.result?.structuredContent?.identity === "A", "echo_context trusted model-supplied identity");

  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      rpc(
        hub.url,
        index % 2 === 0 ? a.token : b.token,
        100 + index,
        "tools/call",
        nestedParams("echo_context", { clientSessionId: index % 2 === 0 ? "B" : "A", marker: String(index) }),
      ),
    ),
  );
  for (let index = 0; index < concurrent.length; index += 1) {
    const expected = index % 2 === 0 ? "A" : "B";
    assert(concurrent[index]?.body.result?.structuredContent?.identity === expected, `concurrent identity mismatch at ${index}`);
  }

  const searchB = await rpc(hub.url, b.token, 4, "tools/call", nestedParams("search_tools", { query: "restricted" }));
  assert(JSON.stringify(searchB.body.result?.structuredContent?.tools?.map((tool: McpToolDefinition) => tool.name)) === JSON.stringify(["restricted_probe_y"]), "B saw A's restricted tool");
  const searchChildBefore = await rpc(hub.url, child.token, 5, "tools/call", nestedParams("search_tools", { query: "restricted" }));
  assert(searchChildBefore.body.result?.structuredContent?.tools?.some((tool: McpToolDefinition) => tool.name === "restricted_probe_x"), "child did not inherit X before revoke");
  state.revoke("A", "restricted_probe_x");
  const oldId = await rpc(hub.url, a.token, 6, "tools/call", nestedParams("restricted_probe_x", { marker: "old-id" }));
  assert(oldId.body.error && !oldId.body.result, "revoked old tool id was accepted");
  const searchChildAfter = await rpc(hub.url, child.token, 7, "tools/call", nestedParams("search_tools", { query: "restricted" }));
  assert((searchChildAfter.body.result?.structuredContent?.tools ?? []).length === 0, "child retained revoked parent permission");

  const deniedWrite = await rpc(hub.url, a.token, 8, "tools/call", nestedParams("mock_write", { value: "deny" }));
  assert(deniedWrite.body.result?.isError === true, "denied mock_write was not isError");
  assert(state.mockWriteCount === 0, "denied mock_write executed upstream");
  assert(state.approvalEvents.at(-1)?.tool === "mock_write", "approval did not contain real nested tool");
  assert((state.approvalEvents.at(-1)?.args as Record<string, unknown>)?.value === "deny", "approval lost nested args");
  state.approval.set("A", "allow");
  await rpc(hub.url, a.token, 9, "tools/call", nestedParams("mock_write", { value: "allow" }));
  const approvedWriteCount: number = state.mockWriteCount;
  assert(approvedWriteCount === 1, "approved mock_write did not execute exactly once");

  const result = await rpc(hub.url, b.token, 10, "tools/call", nestedParams("result_probe"));
  const blocks = result.body.result?.content ?? [];
  assert(blocks.some((block: Record<string, unknown>) => block.type === "text"), "text result missing");
  assert(blocks.some((block: Record<string, unknown>) => block.type === "image"), "image result missing");
  assert(result.body.result?.structuredContent?.ok === true, "structuredContent missing");
  assert(result.body.result?.isError === false, "successful result marked as error");

  const slowController = new AbortController();
  const slowPromise = rpc(hub.url, b.token, 11, "tools/call", nestedParams("slow_probe", { delayMs: 300 }), {
    signal: slowController.signal,
  });
  setTimeout(() => slowController.abort(new Error("probe timeout")), 40);
  let aborted = false;
  try {
    await slowPromise;
  } catch {
    aborted = true;
  }
  assert(aborted, "client timeout did not abort the slow request");
  await waitFor(() => state.slowCompleted === 1, 2_000, "slow upstream completion after disconnect");
  assert(state.slowStarted === 1 && state.slowCancelled === 0, "disconnect was incorrectly treated as MCP cancellation");

  const explicitRequestId = 14;
  const explicitSlow = rpc(
    hub.url,
    b.token,
    explicitRequestId,
    "tools/call",
    nestedParams("slow_probe", { delayMs: 500 }),
    { sessionId: initializedB.sessionId },
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  await rpc(
    hub.url,
    b.token,
    15,
    "notifications/cancelled",
    { requestId: explicitRequestId },
    { sessionId: initializedB.sessionId },
  );
  const explicitReply = await explicitSlow;
  assert(explicitReply.status === 202 || (explicitReply.body.error && !explicitReply.body.result), "explicit cancellation did not settle the request");
  await waitFor(() => state.slowCancelled === 1, 2_000, "explicit slow upstream cancellation");
  assert(state.slowStarted === 2 && state.slowCompleted === 1, "explicit cancellation did not stop the second slow call");

  const restored = await initialize(hub.url, a.token);
  const restoredEcho = await rpc(hub.url, a.token, 12, "tools/call", nestedParams("echo_context", { marker: "restored" }), {
    sessionId: restored.sessionId,
  });
  assert(restoredEcho.body.result?.structuredContent?.identity === "A", "restored session lost its bound identity");

  const noToken = await rpc(hub.url, undefined, 13, "tools/list");
  assert(noToken.body.error && !noToken.body.result, "shared unauthenticated connection was accepted");

  // Existing Codex/browser fallback is explicitly order based. This is a
  // negative control for the target requirement, not a Hub identity proof.
  const claims = new BrowserMcpToolClaimRouter();
  claims.noteUpcoming("A", "call_tool", "a");
  claims.noteUpcoming("B", "call_tool", "b");
  const claim1 = claims.claimDetails("call_tool");
  const claim2 = claims.claimDetails("call_tool");
  assert(claim1?.threadId === "A" && claim2?.threadId === "B", "claim router control changed unexpectedly");

  return {
    status: "pass",
    sharedEndpoint: hub.url,
    virtualToolsHiddenFromList: true,
    dynamicSearchReturnedSchema: true,
    concurrentCalls: concurrent.length,
    oldIdRejected: true,
    approval: {
      deniedUpstreamCount: 0,
      approvedUpstreamCount: state.mockWriteCount,
      realTool: state.approvalEvents.at(-1)?.tool,
    },
    resultTypes: ["text", "image", "structuredContent", "isError"],
    slowProbe: {
      clientAborted: true,
      upstreamStarted: state.slowStarted,
      upstreamCompleted: state.slowCompleted,
      upstreamCancelled: state.slowCancelled,
      cancellationDelivered: true,
    },
    restoredIdentity: restoredEcho.body.result.structuredContent.identity,
    noTokenRejected: true,
    orderBasedClaimNegativeControl: true,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runClaudeProbe(hub: RunningHub, token: string) {
  const raw = buildMcpSdkConfig([
    {
      id: "eco_mcp",
      name: "eco_mcp",
      transport: "http",
      enabled: true,
      url: hub.url,
      headersJson: JSON.stringify({ Authorization: `Bearer ${token}` }),
      argsJson: "[]",
      envJson: "{}",
      allowedTools: "",
      createdAt: "",
      updatedAt: "",
    },
  ]);
  const prepared = prepareMcpSdkConfigForRuntime(raw);
  const resolved = resolveSdkSessionOptions({ mcpServers: prepared.mcpServers, settingSources: [] });
  let captured: Record<string, unknown> | undefined;
  let simulatedCall = false;
  let resumeSeen = false;
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "probe-key",
    baseUrl: "http://127.0.0.1:9",
    loadSdk: async () => ({
      query: ({ options }: { options: Record<string, unknown> }) => {
        captured = options;
        if (options.resume === "claude-probe-session") resumeSeen = true;
        return {
          async *[Symbol.asyncIterator]() {
            const entry = (options.mcpServers as Record<string, any>)?.eco_mcp;
            const auth = entry?.headers?.Authorization as string;
            const listed = await rpc(hub.url, auth?.replace(/^Bearer\s+/i, ""), 200, "tools/list");
            const names = listed.body.result?.tools?.map((tool: McpToolDefinition) => tool.name) ?? [];
            assert(JSON.stringify(names) === JSON.stringify(["search_tools", "call_tool"]), "Claude probe saw unexpected Hub tools");
            const searched = await rpc(
              hub.url,
              auth?.replace(/^Bearer\s+/i, ""),
              201,
              "tools/call",
              nestedParams("search_tools", { query: "echo" }),
            );
            assert(searched.body.result?.structuredContent?.tools?.[0]?.inputSchema, "Claude dynamic schema missing");
            await rpc(hub.url, auth?.replace(/^Bearer\s+/i, ""), 202, "tools/call", nestedParams("echo_context", { marker: "claude" }));
            simulatedCall = true;
            yield { type: "system", subtype: "init", session_id: "claude-probe-session", uuid: "claude-init" };
            yield { type: "result", subtype: "success", session_id: "claude-probe-session", uuid: "claude-result" };
          },
          close: () => {},
        };
      },
    }),
  });
  const input: AgentRuntimeRunInput = {
      threadId: "claude-probe",
      prompt: "probe",
      workspacePath: process.cwd(),
      worktreePath: process.cwd(),
      routes: [
        {
          role: "main",
          primary: {
            id: "probe",
            provider: "anthropic",
            displayName: "probe",
            baseUrl: "http://127.0.0.1:9",
            modelId: "probe",
            capabilities: ["messages_api"],
            enabled: true,
          },
          fallbacks: [],
        },
      ],
      sdkSession: resolved,
      signal: new AbortController().signal,
    };
  await drain(driver.runAsk(input));
  await drain(
    driver.runContinuation(
      { ...input, prompt: "resume", resume: { resumeSessionId: "claude-probe-session" } },
      "ask",
    ),
  );
  assert(captured?.mcpServers, "Claude query did not receive mcpServers");
  assert(simulatedCall, "Claude fake SDK did not execute the Hub call");
  assert(resumeSeen, "Claude resume did not forward resumeSessionId");
  return {
    status: "pass",
    wire: "mcpServers passed per query with HTTP Authorization",
    dynamicSearchAndCall: "pass (loadSdk seam; no external Claude model)",
    resumeBinding: "pass (resumeSessionId forwarded; fake SDK)",
  };
}

async function runPiProbe(hub: RunningHub, token: string, identity: string) {
  const agentDir = await mkdtemp(path.join(tmpdir(), `eco-pi-mcp-probe-${identity}-`));
  await mkdir(path.join(agentDir, "skills"), { recursive: true });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const factory = await createPiMcpExtensionFactory(
      {
        eco_mcp: {
          type: "http",
          url: hub.url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
      { agentDir },
    );
    if (!factory) throw new Error("PI MCP factory was not created");
    const pi = await import("@earendil-works/pi-coding-agent");
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = pi;
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [{ name: "eco-pi-mcp-probe", factory: factory as never }],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "probe",
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const sessionManager = SessionManager.inMemory(agentDir);
    const { session } = await createAgentSession({
      cwd: agentDir,
      agentDir,
      modelRuntime,
      resourceLoader: resourceLoader as never,
      tools: piToolsForSessionMode("agent", { hasMcpServers: true }),
      sessionManager,
      settingsManager,
    });
    // The official PI MCP extension connects on session_start; wait for its
    // real namespaced Hub tools before invoking them.
    await session.bindExtensions({ mode: "rpc" });
    const findTool = (name: string) =>
      (session as any).agent?.state?.tools?.find((tool: any) => tool.name === name);
    const toolDeadline = Date.now() + 10_000;
    while (
      (!findTool("mcp__eco_mcp__search_tools") || !findTool("mcp__eco_mcp__call_tool")) &&
      Date.now() < toolDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const searchTool = findTool("mcp__eco_mcp__search_tools");
    const callTool = findTool("mcp__eco_mcp__call_tool");
    if (!searchTool || !callTool) throw new Error("PI MCP Hub tools were not registered");
    const search = await searchTool.execute(
      "probe-search",
      { query: "echo" },
      new AbortController().signal,
      () => {},
    );
    const searchText = search.content?.[0]?.text ?? "";
    assert(searchText.includes("echo_context") && searchText.includes("inputSchema"), `PI search returned no Hub metadata: ${JSON.stringify(search)}`);
    const call = await callTool.execute(
      "probe-call",
      { name: "echo_context", arguments: { marker: "pi" } },
      new AbortController().signal,
      () => {},
    );
    assert(call.content?.[0]?.text?.includes(identity), "PI call did not return the bound identity");
    session.dispose();
    return {
      status: "pass",
      proxy: "official PI MCP extension (mcp__eco_mcp__* tools)",
      dynamicSearchAndCall: "pass (direct tool invocation; model itself not run)",
      sessionConfigIsolated: true,
    };
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
}

async function runAcpProbe(hub: RunningHub, tokens: { a: string; b: string }) {
  const fakeAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-acp-agent.mjs");
  const workspace = await mkdtemp(path.join(tmpdir(), "eco-acp-mcp-probe-"));
  const driver = new AcpAgentDriver({
    // Keep the probe reproducible even when the checkout does not preserve the
    // executable bit on fake-acp-agent.mjs.
    spawnFn: (command, args, options) => spawn(process.execPath, [command, ...args], options),
  });
  const runOne = async (threadId: string, token: string, marker: string, resumeSessionId?: string) => {
    const mcpServers = toAcpMcpServers({
      eco_mcp: {
        type: "http",
        url: hub.url,
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    const events = await drain(
      driver.run({
        threadId,
        prompt: marker,
        workspacePath: workspace,
        acpAgentId: "cursor",
        executable: fakeAgent,
        mcpServers,
        ...(resumeSessionId ? { resumeSessionId } : {}),
      }),
    );
    const message = events.find((event: any) => event.type === "message.delta") as any;
    assert(String(message?.payload?.text ?? "").includes(marker), `ACP fake agent did not call Hub for ${threadId}`);
    const captured = events.find((event: any) => event.type === "session.captured") as any;
    return { count: events.length, sessionId: captured?.payload?.sessionId as string | undefined };
  };
  const [runA, runB] = await Promise.all([runOne("acp-A", tokens.a, "acp-A"), runOne("acp-B", tokens.b, "acp-B")]);
  assert(runA.sessionId, "ACP probe did not capture A session id");
  driver.dispose("acp-A");
  const resumedA = await runOne("acp-A", tokens.a, "acp-A-resume", runA.sessionId);
  driver.disposeAll();
  await rm(workspace, { recursive: true, force: true });
  return {
    status: "pass",
    agentImplementation: "scripts/mcp-hub-probe/fake-acp-agent.mjs (ACP protocol v1 probe, not Cursor)",
    concurrentThreads: ["acp-A", "acp-B"],
    dynamicSearchAndCall: "pass in fake agent",
    eventCounts: { A: runA.count, B: runB.count, AResume: resumedA.count },
    resumeSentMcpServers: true,
    cursorGeneralization: "未验证",
  };
}

async function runCodexProbe(hub: RunningHub, tokenA: string, tokenB: string) {
  const server: McpServerConfigView = {
    id: "eco_mcp",
    name: "eco_mcp",
    transport: "http",
    enabled: true,
    url: hub.url,
    headersJson: JSON.stringify({ Authorization: `Bearer ${tokenA}` }),
    argsJson: "[]",
    envJson: "{}",
    allowedTools: "",
    createdAt: "",
    updatedAt: "",
  };
  const configured = buildCodexMcpServersForConfigSync([server], ["eco_mcp"]);
  const prepared = prepareCodexMcpServersForRuntime(configured);
  assert(prepared[0]?.httpHeaders?.Authorization === `Bearer ${tokenA}`, "Codex config did not retain configured HTTP header");
  const handshake = await probeCodexStyleHttpMcpHandshake({
    name: "eco_mcp",
    url: hub.url,
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const bUsingGlobalDescriptor = await rpc(hub.url, tokenA, 301, "tools/call", nestedParams("echo_context", { clientSessionId: "B" }));
  assert(bUsingGlobalDescriptor.body.result?.structuredContent?.identity === "A", "Codex static global credential test changed unexpectedly");
  const bWithOwnHeader = await rpc(hub.url, tokenB, 302, "tools/call", nestedParams("echo_context", { clientSessionId: "B" }));
  assert(bWithOwnHeader.body.result?.structuredContent?.identity === "B", "Hub rejected an independent Codex connection");
  return {
    status: "fail",
    reason: "当前 Codex MCP 是进程级 global pool；config.toml 的 HTTP header 是静态的，thread config 只裁剪工具可见性，不能把 A 的连接绑定为 B。",
    handshakeTools: handshake.toolCount,
    configuredHeaderFingerprint: fingerprint(tokenA),
    bUsingAStaticHeaderResolvedAs: bUsingGlobalDescriptor.body.result.structuredContent.identity,
    independentHeaderWouldResolveAs: bWithOwnHeader.body.result.structuredContent.identity,
    dynamicAgentExecution: "未验证（未启动真实 Codex 模型回合）",
  };
}

async function spawnWorker(identity: Identity): Promise<{ child: ReturnType<typeof spawn>; url: string; startupMs: number }> {
  const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "hub-worker.mjs");
  const started = Date.now();
  const child = spawn(process.execPath, [worker, "--identity", identity], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let buffer = "";
  const line = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker ${identity} startup timeout`)), 5_000);
    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      const index = buffer.indexOf("\n");
      if (index >= 0) {
        clearTimeout(timer);
        resolve(buffer.slice(0, index).trim());
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const url = line.replace(/^READY\s+/, "");
  if (!url.startsWith("http://")) throw new Error(`bad worker line: ${line}`);
  return { child, url, startupMs: Date.now() - started };
}

async function runIndependentConnectionProbe() {
  const [a, b] = await Promise.all([spawnWorker("A"), spawnWorker("B")]);
  try {
    const resultA = await rpc(a.url, undefined, 1, "tools/call", nestedParams("echo_context"));
    const resultB = await rpc(b.url, undefined, 2, "tools/call", nestedParams("echo_context"));
    assert(resultA.body.result?.structuredContent?.identity === "A", "independent A worker lost identity");
    assert(resultB.body.result?.structuredContent?.identity === "B", "independent B worker lost identity");
    return {
      status: "pass",
      processCount: 2,
      pids: [a.child.pid, b.child.pid],
      startupMs: { A: a.startupMs, B: b.startupMs },
      sessionRecovery: "进程重启会丢失内存中的审批/计数/绑定；需持久化或重新绑定",
    };
  } finally {
    for (const worker of [a, b]) worker.child.kill("SIGTERM");
  }
}

async function main() {
  const hub = await startHub();
  const aa = hub.state.issue("A", ["echo_context", "restricted_probe_x", "mock_write", "slow_probe", "result_probe"]);
  const bb = hub.state.issue("B", ["echo_context", "restricted_probe_y", "mock_write", "slow_probe", "result_probe"]);
  try {
    const hubResult = await runHubExperiments(hub, aa, bb);
    const claude = await runClaudeProbe(hub, aa.token);
    const pi = await runPiProbe(hub, bb.token, "B");
    const acp = await runAcpProbe(hub, { a: aa.token, b: bb.token });
    const codex = await runCodexProbe(hub, aa.token, bb.token);
    const independent = await runIndependentConnectionProbe();
    const report = {
      generatedAt: new Date().toISOString(),
      versions: {
        node: process.version,
        bun: process.versions.bun ?? "unknown",
        ecoDesktop: JSON.parse(readFileSync(path.join(repoRoot, "apps/desktop/package.json"), "utf8")).version,
        claudeAgentSdk: JSON.parse(readFileSync(path.join(repoRoot, "packages/runtime/node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version,
        codexDependency: readCodexDependencyPins(
          JSON.parse(readFileSync(path.join(repoRoot, "apps/desktop/package.json"), "utf8")),
        ).version,
        codexCliHarness: readCodexCliVersion(codexHarnessExecutable) ?? "not installed",
        piCodingAgent: JSON.parse(readFileSync(path.join(repoRoot, "packages/runtime/node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version,
        piMcpExtension: "official MCP extension (createMcpExtension)",
        acpAgent: "fake-acp-agent probe v0.1.0 (Cursor ACP 未验证)",
      },
      hub: hubResult,
      runtimes: { Codex: codex, Claude: claude, Pi: pi, ACP: acp },
      independentConnection: independent,
      keyLogs: hub.state.logs.slice(-120),
      approvalEvents: hub.state.approvalEvents,
      note: "所有 token 仅在进程内使用；输出只保留 fingerprint，不记录真实凭证。",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await hub.close();
  }
}

if (import.meta.main) {
  await main();
}
