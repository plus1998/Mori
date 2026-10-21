/**
 * End-to-end Claude Agent SDK probe with a deterministic local Anthropic API.
 *
 * The API is local and returns scripted tool_use blocks. This exercises the
 * actual Claude CLI/SDK process, MCP transport, Eco driver, and Hub. It does
 * not claim model quality; the deterministic model is only a transport probe.
 */

import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { startHub, rpc, nestedParams, type RunningHub } from "./run";
import { ClaudeAgentSdkDriver } from "../../packages/runtime/src/claude-agent-sdk";
import type { AgentRuntimeRunInput } from "../../packages/runtime/src/index";

type Mode = "dynamic" | "revoked" | "write" | "write-allow" | "write-runtime-deny" | "slow";

type ApiRequest = {
  body: Record<string, any>;
  toolNames: string[];
  messageCount: number;
};

type FakeApi = {
  url: string;
  requests: ApiRequest[];
  close: () => Promise<void>;
};

function lastToolResult(body: Record<string, any>): { id: string; text: string } | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const message = messages.at(-1);
  if (message?.role !== "user" || !Array.isArray(message.content)) return undefined;
  const block = message.content.find((item: any) => item?.type === "tool_result");
  if (!block) return undefined;
  const content = Array.isArray(block.content)
    ? block.content.map((item: any) => item?.text ?? JSON.stringify(item)).join(" ")
    : String(block.content ?? "");
  return { id: String(block.tool_use_id ?? ""), text: content };
}

function writeSse(res: http.ServerResponse, payload: { kind: "text" | "tool"; text?: string; name?: string; input?: unknown; id?: string }): void {
  const content: Array<Record<string, any>> = payload.kind === "text"
    ? [{ type: "text", text: payload.text ?? "done" }]
    : [{ type: "tool_use", id: payload.id ?? "tool_probe", name: payload.name, input: payload.input ?? {} }];
  const stopReason = payload.kind === "tool" ? "tool_use" : "end_turn";
  const events: Array<[string, Record<string, unknown>]> = [
    ["message_start", {
      type: "message_start",
      message: {
        id: `msg_probe_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: "eco-local-probe",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
  ];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index]!;
    events.push(["content_block_start", { type: "content_block_start", index, content_block: block }]);
    if (block.type === "text") {
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  }
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

export async function startFakeAnthropic(hub: RunningHub, mode: Mode, revokeAfterSearch: () => void): Promise<FakeApi> {
  const requests: ApiRequest[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      if (request.method === "HEAD") {
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.url?.startsWith("/api/hello")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (!request.url?.startsWith("/v1/messages")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, any>;
      const toolNames = (body.tools ?? []).map((tool: any) => tool?.name).filter((name: unknown): name is string => typeof name === "string");
      requests.push({ body, toolNames, messageCount: Array.isArray(body.messages) ? body.messages.length : 0 });
      const result = lastToolResult(body);
      if (process.env.ECO_PROBE_DEBUG === "1") {
        console.error("[claude-fake-api]", mode, requests.length, JSON.stringify({
          latestRole: body.messages?.at(-1)?.role,
          latestTypes: Array.isArray(body.messages?.at(-1)?.content) ? body.messages.at(-1).content.map((block: any) => block?.type) : [],
          tools: toolNames.filter((name) => name.startsWith("mcp__")),
          resultId: result?.id,
        }));
      }
      const searchName = (body.tools ?? []).find((tool: any) => typeof tool?.name === "string" && tool.name.endsWith("search_tools"))?.name as string | undefined;
      const callName = (body.tools ?? []).find((tool: any) => typeof tool?.name === "string" && tool.name.endsWith("call_tool"))?.name as string | undefined;
      if (!searchName || !callName) {
        writeSse(response, { kind: "text", text: "local probe warmup" });
        return;
      }
      if (!result) {
        writeSse(response, { kind: "tool", name: searchName, id: `tool_search_${requests.length}`, input: { query: mode === "revoked" ? "restricted_probe_x" : "echo" } });
        if (mode === "revoked") revokeAfterSearch();
        return;
      }
      if (result.id.startsWith("tool_search")) {
      const nested = mode === "dynamic"
          ? { name: "echo_context", arguments: { clientSessionId: "model-forged", marker: "claude-real" } }
          : mode === "revoked"
            ? { name: "restricted_probe_x", arguments: { marker: "old-id" } }
            : mode === "write" || mode === "write-allow" || mode === "write-runtime-deny"
              ? { name: "mock_write", arguments: { value: "claude-real-write" } }
              : { name: "slow_probe", arguments: { delayMs: 300 } };
        writeSse(response, { kind: "tool", name: callName, id: `tool_call_${requests.length}`, input: nested });
        return;
      }
      if (mode === "slow" && result.id.startsWith("tool_call")) {
        // The caller aborts while this response is waiting. Keep the socket open
        // long enough to observe whether the Hub/upstream call is still running.
        setTimeout(() => writeSse(response, { kind: "text", text: "slow complete" }), 500);
        return;
      }
      writeSse(response, { kind: "text", text: JSON.stringify({ mode, toolResult: result.text.slice(0, 600) }) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Anthropic server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function claudeExecutable(): Promise<string> {
  const require = createRequire(import.meta.url);
  const sdkPackage = require.resolve("@anthropic-ai/claude-agent-sdk/package.json", {
    paths: [path.join(process.cwd(), "packages/runtime")],
  }) as string;
  const sdkVersion = JSON.parse(await readFile(sdkPackage, "utf8")).version as string;
  const nativePackage = require.resolve("@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json", {
    paths: [path.join(process.cwd(), "apps/desktop")],
  }) as string;
  const nativeVersion = JSON.parse(await readFile(nativePackage, "utf8")).version as string;
  if (nativeVersion !== sdkVersion) throw new Error(`Claude SDK/native version mismatch: ${sdkVersion}/${nativeVersion}`);
  return path.join(path.dirname(nativePackage), "claude");
}

export async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

export async function runClaudeRealProbe(mode: Mode): Promise<Record<string, unknown>> {
  const hub = await startHub();
  const session = hub.state.issue("A", ["echo_context", "restricted_probe_x", "mock_write", "slow_probe"]);
  if (mode === "write-allow") hub.state.approval.set("A", "allow");
  const fakeApi = await startFakeAnthropic(hub, mode, () => hub.state.revoke("A", "restricted_probe_x"));
  const executable = await claudeExecutable();
  const permissionCalls: Array<{ toolName: string; input: Record<string, unknown> }> = [];
  const controller = new AbortController();
  const driver = new ClaudeAgentSdkDriver({
    apiKey: "local-probe-key",
    baseUrl: fakeApi.url,
    pathToClaudeCodeExecutable: executable,
    permissionPrompts: "host",
    toolPermissionHandler: async ({ toolName, input }) => {
      permissionCalls.push({ toolName, input });
      if (mode === "write-runtime-deny" && toolName.endsWith("call_tool")) {
        return { behavior: "deny", message: "runtime probe denial" };
      }
      return { behavior: "allow" };
    },
  });
  const input: AgentRuntimeRunInput = {
    threadId: `claude-real-${mode}`,
    prompt: `deterministic ${mode} probe`,
    workspacePath: process.cwd(),
    worktreePath: process.cwd(),
    routes: [{ role: "main", primary: {
      id: "local-probe",
      provider: "anthropic",
      displayName: "local-probe",
      baseUrl: fakeApi.url,
      modelId: "eco-local-probe",
      capabilities: ["messages_api"],
      enabled: true,
    }, fallbacks: [] }],
    signal: controller.signal,
    sdkSession: {
      settingSources: [],
      mcpServers: { eco_mcp: { type: "http", url: hub.url, headers: { Authorization: `Bearer ${session.token}` } } },
      ...(mode === "write" || mode === "write-runtime-deny" ? {} : { mcpAllowedTools: ["mcp__eco_mcp__*"] }),
    },
  };
  let events: unknown[] = [];
  try {
    if (mode === "slow") {
      const run = drain(driver.runAsk(input));
      const monitor = setInterval(() => {
        if (hub.state.slowStarted > 0) controller.abort(new Error("probe timeout"));
      }, 10);
      const timeout = setTimeout(() => controller.abort(new Error("probe timeout before slow call")), 10_000);
      try {
        events = await run;
      } finally {
        clearInterval(monitor);
        clearTimeout(timeout);
      }
    } else {
      events = await drain(mode === "write" || mode === "write-runtime-deny" ? driver.run(input) : driver.runAsk(input));
    }
  } finally {
    await fakeApi.close();
    await hub.close();
  }
  const started = hub.state.logs.filter((entry) => entry.event === "upstream_call" && entry.phase === "started");
  const rejected = hub.state.logs.filter((entry) => entry.event === "upstream_call" && entry.phase === "rejected");
  const callPermission = permissionCalls.find((entry) => entry.toolName.endsWith("call_tool"));
  const status = mode === "dynamic"
    ? started.some((entry) => entry.identity === "A" && entry.tool === "echo_context")
    : mode === "revoked"
      ? rejected.some((entry) => entry.identity === "A" && entry.tool === "restricted_probe_x") && started.length === 0
      : mode === "write"
        ? hub.state.mockWriteCount === 0 && hub.state.approvalEvents.at(-1)?.decision === "reject" && started.length === 0
        : mode === "write-allow"
          ? hub.state.mockWriteCount === 1 && hub.state.approvalEvents.at(-1)?.decision === "allow" && started.some((entry) => entry.tool === "mock_write")
          : mode === "write-runtime-deny"
            ? Boolean(callPermission) && hub.state.approvalEvents.length === 0 && started.length === 0
            : hub.state.slowStarted === 1 && hub.state.slowCompleted === 1;
  return {
    mode,
    status: status ? "pass" : "fail",
    actualClaudeCli: executable,
    apiRequests: fakeApi.requests.length,
    toolNamesSeen: [...new Set(fakeApi.requests.flatMap((request) => request.toolNames))],
    requestSummary: fakeApi.requests.map((request) => ({
      tools: request.toolNames.filter((name) => name.startsWith("mcp__")),
      messages: request.body.messages?.map((message: any) => ({
        role: message.role,
        types: Array.isArray(message.content) ? message.content.map((block: any) => block?.type) : [],
        toolNames: Array.isArray(message.content) ? message.content.map((block: any) => block?.name).filter(Boolean) : [],
        toolResults: Array.isArray(message.content)
          ? message.content.filter((block: any) => block?.type === "tool_result").map((block: any) => ({
              id: block.tool_use_id,
              content: typeof block.content === "string" ? block.content.slice(0, 500) : block.content,
              isError: block.is_error,
            }))
          : [],
      })),
    })),
    permissionCalls,
    ecoEvents: events.length,
    hubSlow: mode === "slow" ? {
      started: hub.state.slowStarted,
      completed: hub.state.slowCompleted,
      disconnected: hub.state.disconnected,
    } : undefined,
    hubApproval: hub.state.approvalEvents,
    hubLogs: hub.state.logs,
  };
}

if (import.meta.main) {
  const mode = (process.argv[2] ?? "dynamic") as Mode;
  console.log(JSON.stringify(await runClaudeRealProbe(mode), null, 2));
}
