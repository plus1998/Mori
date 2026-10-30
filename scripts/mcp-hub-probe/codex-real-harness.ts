/**
 * Codex CLI end-to-end probe using a local Responses API model.
 * The model is deterministic; the real Codex process still performs MCP
 * initialize/list/call and sends the tool results back to the model endpoint.
 */

import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startHub, type RunningHub } from "./run";

type Scenario = "dynamic" | "revoked" | "write" | "write-allow";
type CodexApi = { url: string; requests: Record<string, any>[]; close: () => Promise<void> };

function functionCallResponse(responseId: string, callId: string, name: string, args: Record<string, unknown>, namespace?: string): string {
  const output = [{
    id: `fc_${callId}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name,
    ...(namespace ? { namespace } : {}),
    arguments: JSON.stringify(args),
  }];
  const response = {
    id: responseId,
    object: "response",
    status: "completed",
    model: "eco-local-probe",
    output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: output[0] })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  ].join("");
}

function textResponse(responseId: string, text: string): string {
  const output = [{
    id: `msg_${responseId}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  }];
  const response = { id: responseId, object: "response", status: "completed", model: "eco-local-probe", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { ...response, status: "in_progress", output: [] } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: output[0] })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
  ].join("");
}

async function startCodexApi(hub: RunningHub, identity: "A" | "B", scenario: Scenario): Promise<CodexApi> {
  const requests: Record<string, any>[] = [];
  let step = 0;
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += String(chunk); });
    request.on("end", () => {
      if (!request.url?.startsWith("/v1/responses")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, any>;
      requests.push(body);
      const mcpNamespace = (body.tools ?? []).find((tool: any) => tool?.name === "mcp__eco_mcp" && tool?.type === "namespace");
      const searchName = mcpNamespace ? "mcp__eco_mcp__search_tools" : undefined;
      const callName = mcpNamespace ? "mcp__eco_mcp__call_tool" : undefined;
      const input = Array.isArray(body.input) ? body.input : [];
      const outputs = input.filter((item: any) => item?.type === "function_call_output");
      response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
      if (searchName && callName && outputs.length === 0) {
        step += 1;
        const query = scenario === "revoked" ? "restricted_probe_x" : scenario === "write" || scenario === "write-allow" ? "mock_write" : "echo";
        if (scenario === "revoked") hub.state.revoke(identity, "restricted_probe_x");
        response.end(functionCallResponse(`resp_${step}`, `search_${step}`, "search_tools", { query }, "mcp__eco_mcp"));
        return;
      }
      if (searchName && callName && outputs.length === 1) {
        step += 1;
        const nested = scenario === "revoked"
          ? { name: "restricted_probe_x", arguments: { marker: "old-id" } }
          : scenario === "write" || scenario === "write-allow"
            ? { name: "mock_write", arguments: { value: `codex-${identity}-write`, clientSessionId: "codex-model-forged" } }
            : { name: "echo_context", arguments: { clientSessionId: "codex-model-forged", marker: `codex-${identity}` } };
        response.end(functionCallResponse(`resp_${step}`, `call_${step}`, "call_tool", nested, "mcp__eco_mcp"));
        return;
      }
      step += 1;
      response.end(textResponse(`resp_${step}`, JSON.stringify({ identity, outputs: outputs.length })));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Codex fake model did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function codexExecutable(): string {
  return process.env.CODEX_EXECUTABLE?.trim() || "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
}

async function runCodex(input: { home: string; prompt: string }): Promise<{ code: number | null; pid: number | undefined; elapsedMs: number; stdout: string; stderr: string }> {
  const started = Date.now();
  const child = spawn(codexExecutable(), ["exec", "--model", "eco-local-probe", "--skip-git-repo-check", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", input.prompt], {
    env: { ...process.env, CODEX_HOME: input.home, ECO_CODEX_DISABLE_PLUGIN_WARM: "1", ECO_PROBE_KEY: "local-probe-key", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  return { code, pid: child.pid, elapsedMs: Date.now() - started, stdout, stderr };
}

export async function runCodexRealProbe(scenario: Scenario = "dynamic"): Promise<Record<string, unknown>> {
  const hub = await startHub();
  const allowed = scenario === "revoked" ? ["restricted_probe_x"] : scenario === "write" || scenario === "write-allow" ? ["mock_write"] : ["echo_context"];
  const a = hub.state.issue("A", allowed);
  const b = hub.state.issue("B", allowed);
  if (scenario === "write-allow") {
    hub.state.approval.set("A", "allow");
    hub.state.approval.set("B", "allow");
  }
  const apiA = await startCodexApi(hub, "A", scenario);
  const apiB = await startCodexApi(hub, "B", scenario);
  const homeA = await mkdtemp(path.join(tmpdir(), "eco-codex-real-a-"));
  const homeB = await mkdtemp(path.join(tmpdir(), "eco-codex-real-b-"));
  const writeConfig = async (home: string, api: CodexApi, token: string) => {
    await writeFile(path.join(home, "config.toml"), [
      'model = "eco-local-probe"',
      'model_provider = "eco_probe"',
      "",
      "[model_providers.eco_probe]",
      'name = "Mori local deterministic probe"',
      `base_url = "${api.url}"`,
      'wire_api = "responses"',
      "request_max_retries = 0",
      'env_key = "ECO_PROBE_KEY"',
      "",
      "[mcp_servers.eco_mcp]",
      `url = "${hub.url}"`,
      `[mcp_servers.eco_mcp.http_headers]`,
      `Authorization = "Bearer ${token}"`,
      "",
    ].join("\n"));
  };
  await Promise.all([writeConfig(homeA, apiA, a.token), writeConfig(homeB, apiB, b.token)]);
  try {
    const [runA, runB] = await Promise.all([
      runCodex({ home: homeA, prompt: "Use search_tools, then call echo_context." }),
      runCodex({ home: homeB, prompt: "Use search_tools, then call echo_context." }),
    ]);
    const started = hub.state.logs.filter((entry) => entry.event === "upstream_call" && entry.phase === "started");
    const identities = started.map((entry) => entry.identity);
    const rejected = hub.state.logs.filter((entry) => entry.event === "upstream_call" && entry.phase === "rejected");
    const writeApprovals = hub.state.approvalEvents.filter((entry) => entry.tool === "mock_write");
    const status = scenario === "dynamic"
      ? runA.code === 0 && runB.code === 0 && identities.includes("A") && identities.includes("B")
      : scenario === "revoked"
        ? runA.code === 0 && runB.code === 0 && rejected.filter((entry) => entry.tool === "restricted_probe_x").length >= 2 && started.length === 0
        : scenario === "write"
          ? runA.code === 0 && runB.code === 0 && hub.state.mockWriteCount === 0 && writeApprovals.length >= 2 && writeApprovals.every((entry) => entry.decision === "reject")
          : runA.code === 0 && runB.code === 0 && hub.state.mockWriteCount === 2 && writeApprovals.length >= 2 && writeApprovals.every((entry) => entry.decision === "allow");
    return {
      status: status ? "pass" : "fail",
      scenario,
      codexExecutable: codexExecutable(),
      concurrentProcesses: 2,
      runCodes: { A: runA.code, B: runB.code },
      processIds: { A: runA.pid, B: runB.pid },
      processElapsedMs: { A: runA.elapsedMs, B: runB.elapsedMs },
      modelRequests: {
        A: apiA.requests.length,
        B: apiB.requests.length,
        toolNames: {
          A: apiA.requests.flatMap((body) => (body.tools ?? []).map((tool: any) => ({ name: tool?.name, type: tool?.type, tools: tool?.tools?.map((nested: any) => nested?.name) }))),
          B: apiB.requests.flatMap((body) => (body.tools ?? []).map((tool: any) => ({ name: tool?.name, type: tool?.type, tools: tool?.tools?.map((nested: any) => nested?.name) }))),
        },
      },
      hubIdentities: identities,
      rejectedTools: rejected.map((entry) => ({ identity: entry.identity, tool: entry.tool })),
      write: { approvalEvents: writeApprovals, mockWriteCount: hub.state.mockWriteCount },
      hubLogs: hub.state.logs,
      stdout: { A: runA.stdout.slice(-1_000), B: runB.stdout.slice(-1_000) },
      stderr: { A: runA.stderr.slice(-2_000), B: runB.stderr.slice(-2_000) },
      staticHeaderObservation: "每个 Codex 进程使用自己的 config.toml；本实验不证明同一 Codex app-server global pool 可隔离。",
    };
  } finally {
    await Promise.all([apiA.close(), apiB.close(), hub.close()]);
    await Promise.all([rm(homeA, { recursive: true, force: true }), rm(homeB, { recursive: true, force: true })]);
  }
}

if (import.meta.main) console.log(JSON.stringify(await runCodexRealProbe((process.argv[2] ?? "dynamic") as Scenario), null, 2));
