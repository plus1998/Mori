/**
 * End-to-end PI Core probe with a deterministic local Anthropic-compatible API.
 *
 * The PI process/session, the official PI MCP extension, the codemode sandbox,
 * MCP transport, and Hub are real. The local API only scripts the model's Hub
 * tool calls (search, direct call, then both batched inside one codemode script),
 * so this is a protocol probe rather than a model-quality claim.
 */

import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRuntimeRunInput } from "../../packages/runtime/src/index";
import { PI_CODEMODE_TOOL_NAME } from "../../packages/runtime/src/pi-codemode";
import {
  type PiBridgeModelResolution,
  PiCodingAgentDriver,
  PiSessionRegistry,
} from "../../packages/runtime/src/pi-coding-agent-driver";
import { PI_MCP_HUB_TOOL_NAMES } from "../../packages/runtime/src/pi-mcp";
import { type RunningHub, startHub } from "./run";

const [PI_MCP_HUB_SEARCH_TOOL_NAME, PI_MCP_HUB_CALL_TOOL_NAME] = PI_MCP_HUB_TOOL_NAMES;

type Request = { body: Record<string, any>; toolNames: string[]; messageTypes: string[] };
type Api = { url: string; requests: Request[]; close: () => Promise<void> };

function lastToolResult(body: Record<string, any>): { id: string; text: string } | undefined {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || !Array.isArray(message.content)) continue;
    const block = message.content.find((item: any) => item?.type === "tool_result");
    if (!block) continue;
    const content = Array.isArray(block.content)
      ? block.content.map((item: any) => item?.text ?? JSON.stringify(item)).join(" ")
      : String(block.content ?? "");
    return { id: String(block.tool_use_id ?? ""), text: content };
  }
  return undefined;
}

function sse(
  res: http.ServerResponse,
  payload: { text?: string; tool?: string; input?: Record<string, unknown>; id?: string },
): void {
  const isText = payload.text !== undefined;
  const block = isText
    ? { type: "text", text: payload.text }
    : {
        type: "tool_use",
        id: payload.id ?? "pi_probe",
        // Real wire name: the official PI MCP extension namespaces Hub tools as
        // `mcp__eco_mcp__<tool>`. The pre-1.0.3 `mcp` proxy tool no longer exists.
        name: payload.tool ?? PI_MCP_HUB_SEARCH_TOOL_NAME,
        input: payload.input ?? {},
      };
  const events: Array<[string, Record<string, unknown>]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_pi_${Date.now()}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "eco-local-probe",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
    ],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: block }],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: isText
          ? { type: "text_delta", text: payload.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(payload.input ?? {}) },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: isText ? "end_turn" : "tool_use", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

async function startApi(identity: "A" | "B"): Promise<Api> {
  const requests: Request[] = [];
  let turnStep = 0;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
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
      requests.push({
        body,
        toolNames: (body.tools ?? []).map((tool: any) => tool?.name).filter(Boolean),
        messageTypes: (body.messages ?? []).flatMap((message: any) =>
          Array.isArray(message.content) ? message.content.map((block: any) => block?.type) : [],
        ),
      });
      // The scripted model repeats a search/call/codemode/text cycle for every
      // prompt, including a prompt loaded from a persisted PI session file.
      turnStep = (turnStep % 4) + 1;
      const result = lastToolResult(body);
      if (turnStep === 1) {
        sse(response, { tool: PI_MCP_HUB_SEARCH_TOOL_NAME, input: { query: "echo" }, id: "pi_search" });
        return;
      }
      if (turnStep === 2) {
        sse(response, {
          tool: PI_MCP_HUB_CALL_TOOL_NAME,
          input: {
            name: "echo_context",
            arguments: { clientSessionId: "pi-model-forged", marker: `pi-${identity}` },
          },
          id: "pi_call",
        });
        return;
      }
      if (turnStep === 3) {
        // Both Hub tools batched inside one codemode script: proves the sandbox
        // reaches this session's MCP tools (direct exposure) and that parallel
        // nested calls both land on the thread's Hub credential.
        sse(response, {
          tool: PI_CODEMODE_TOOL_NAME,
          input: {
            code: [
              "const [found, echoed] = await Promise.all([",
              `  tools["${PI_MCP_HUB_SEARCH_TOOL_NAME}"]({ query: "echo" }),`,
              `  tools["${PI_MCP_HUB_CALL_TOOL_NAME}"]({ name: "echo_context", arguments: ${JSON.stringify({ clientSessionId: "pi-model-forged", marker: `pi-codemode-${identity}` })} }),`,
              "]);",
              "return { found, echoed };",
            ].join("\n"),
          },
          id: "pi_codemode",
        });
        return;
      }
      sse(response, { text: JSON.stringify({ identity, toolResult: result.text.slice(0, 600) }) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PI fake API did not bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function drain<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

function route(): AgentRuntimeRunInput["routes"] {
  return [
    {
      role: "main" as const,
      primary: {
        id: "local-probe",
        provider: "anthropic",
        displayName: "local-probe",
        baseUrl: "http://127.0.0.1",
        modelId: "eco-local-probe",
        capabilities: ["messages_api"],
        enabled: true,
      },
      fallbacks: [],
    },
  ];
}

export async function runPiRealProbe(): Promise<Record<string, unknown>> {
  const hub = await startHub();
  const a = hub.state.issue("A", ["echo_context"]);
  const b = hub.state.issue("B", ["echo_context"]);
  const apiA = await startApi("A");
  const apiB = await startApi("B");
  const dirs = {
    A: await mkdtemp(path.join(tmpdir(), "eco-pi-real-a-")),
    B: await mkdtemp(path.join(tmpdir(), "eco-pi-real-b-")),
  };
  const resolveBridgeModel = async ({ threadId }: { threadId: string }): Promise<PiBridgeModelResolution> => {
    const identity = threadId.endsWith("-B") ? "B" : "A";
    const api = identity === "A" ? apiA : apiB;
    return {
      bridgeBaseUrl: api.url,
      bridgeModelId: "eco-local-probe",
      apiKey: "local-probe-key",
      agentDir: dirs[identity],
      apiCompat: "anthropic",
      bindingId: `pi-probe-${identity}`,
      providerId: "eco-local-probe",
    };
  };
  const registry = new PiSessionRegistry();
  const driver = new PiCodingAgentDriver({ resolveBridgeModel }, registry);
  let resumedRegistry: PiSessionRegistry | undefined;
  const input = (identity: "A" | "B"): AgentRuntimeRunInput => ({
    threadId: `pi-real-${identity}`,
    prompt: `Use MCP search and then echo_context for ${identity}.`,
    workspacePath: process.cwd(),
    worktreePath: process.cwd(),
    routes: route(),
    signal: new AbortController().signal,
    piSession: {
      sessionMode: "agent",
      mcpServers: {
        eco_mcp: {
          type: "http",
          url: hub.url,
          headers: { Authorization: `Bearer ${(identity === "A" ? a : b).token}` },
        },
      },
    },
  });
  try {
    const [eventsA, eventsB] = await Promise.all([
      drain(driver.run(input("A"))),
      drain(driver.run(input("B"))),
    ]);
    // Reuse A's live PI session once, then dispose it and restore the same
    // conversation JSONL in a fresh driver. Both turns must still use A's Hub
    // credential.
    const repeatA = await drain(driver.run(input("A")));
    const capturedA = eventsA.find((event: any) => event.type === "session.captured") as any;
    const sessionFileA = capturedA?.payload?.sessionFile as string | undefined;
    await registry.deleteThread("pi-real-A");
    resumedRegistry = new PiSessionRegistry();
    const resumedDriver = new PiCodingAgentDriver({ resolveBridgeModel }, resumedRegistry);
    const resumedA = await drain(
      resumedDriver.run({
        ...input("A"),
        piSession: { ...input("A").piSession, sessionFile: sessionFileA },
      }),
    );
    const upstream = hub.state.logs.filter(
      (entry) => entry.event === "upstream_call" && entry.phase === "started",
    );
    const identities = upstream.map((entry) => entry.identity);
    const codemodeMarkers = upstream
      .map((entry) => (entry as { args?: { marker?: string } }).args?.marker)
      .filter((marker): marker is string => typeof marker === "string" && marker.startsWith("pi-codemode-"));
    const success =
      identities.includes("A") &&
      identities.includes("B") &&
      identities.filter((identity) => identity === "A").length >= 3 &&
      Boolean(sessionFileA) &&
      apiA.requests.some((request) => request.toolNames.includes(PI_MCP_HUB_SEARCH_TOOL_NAME)) &&
      apiB.requests.some((request) => request.toolNames.includes(PI_MCP_HUB_SEARCH_TOOL_NAME)) &&
      apiA.requests.some((request) => request.toolNames.includes(PI_CODEMODE_TOOL_NAME)) &&
      // The sandbox's nested calls must reach the Hub for both threads.
      codemodeMarkers.includes("pi-codemode-A") &&
      codemodeMarkers.includes("pi-codemode-B");
    return {
      status: success ? "pass" : "fail",
      piVersion: "来自当前 workspace 的 @earendil-works/pi-coding-agent",
      concurrentThreads: 2,
      eventCounts: {
        A: eventsA.length,
        B: eventsB.length,
        ARepeat: repeatA.length,
        AResume: resumedA.length,
      },
      apiRequests: { A: apiA.requests.length, B: apiB.requests.length },
      modelToolNames: {
        A: [...new Set(apiA.requests.flatMap((request) => request.toolNames))],
        B: [...new Set(apiB.requests.flatMap((request) => request.toolNames))],
      },
      codemodeNestedHubCalls: codemodeMarkers,
      hubIdentities: identities,
      restoredSessionIdentity:
        identities.filter((identity) => identity === "A").length >= 3 ? "A" : "missing",
      restoredSessionFile: Boolean(sessionFileA),
      forgedClientSessionIdsIgnored: upstream.every(
        (entry) => entry.identity === "A" || entry.identity === "B",
      ),
      hubLogs: hub.state.logs,
      note: "本实验使用真实 PI AgentSession + 官方 PI MCP 扩展，模型响应来自本地确定性 Anthropic API；不代表真实模型的工具选择质量。",
    };
  } finally {
    await registry.deleteThread("pi-real-A");
    await registry.deleteThread("pi-real-B");
    await resumedRegistry?.deleteThread("pi-real-A");
    await resumedRegistry?.deleteThread("pi-real-B");
    await Promise.all([apiA.close(), apiB.close(), hub.close()]);
    await Promise.all(Object.values(dirs).map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

if (import.meta.main) console.log(JSON.stringify(await runPiRealProbe(), null, 2));
