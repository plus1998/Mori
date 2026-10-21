/** Real Claude Agent SDK/CLI A-B isolation + resume probe. */

import { startHub, type RunningHub } from "./run";
import { claudeExecutable, drain, startFakeAnthropic } from "./claude-real-harness";
import { ClaudeAgentSdkDriver } from "../../packages/runtime/src/claude-agent-sdk";
import type { AgentRuntimeRunInput } from "../../packages/runtime/src/index";

function input(
  threadId: string,
  hub: RunningHub,
  token: string,
  apiUrl: string,
): AgentRuntimeRunInput {
  return {
    threadId,
    prompt: "Use search_tools, then call echo_context.",
    workspacePath: process.cwd(),
    worktreePath: process.cwd(),
    routes: [{
      role: "main",
      primary: {
        id: "local-probe",
        provider: "anthropic",
        displayName: "local-probe",
        baseUrl: apiUrl,
        modelId: "eco-local-probe",
        capabilities: ["messages_api"],
        enabled: true,
      },
      fallbacks: [],
    }],
    signal: new AbortController().signal,
    sdkSession: {
      settingSources: [],
      mcpServers: { eco_mcp: { type: "http", url: hub.url, headers: { Authorization: `Bearer ${token}` } } },
      mcpAllowedTools: ["mcp__eco_mcp__*"],
    },
  };
}

export async function runClaudeIsolationProbe(): Promise<Record<string, unknown>> {
  const hub = await startHub();
  const a = hub.state.issue("A", ["echo_context"]);
  const b = hub.state.issue("B", ["echo_context"]);
  const apiA = await startFakeAnthropic(hub, "dynamic", () => {});
  const apiB = await startFakeAnthropic(hub, "dynamic", () => {});
  const executable = await claudeExecutable();
  const driverA = new ClaudeAgentSdkDriver({
    apiKey: "local-probe-key",
    baseUrl: apiA.url,
    pathToClaudeCodeExecutable: executable,
    permissionPrompts: "host",
  });
  const driverB = new ClaudeAgentSdkDriver({
    apiKey: "local-probe-key",
    baseUrl: apiB.url,
    pathToClaudeCodeExecutable: executable,
    permissionPrompts: "host",
  });
  const inputA = input("claude-real-A", hub, a.token, apiA.url);
  const inputB = input("claude-real-B", hub, b.token, apiB.url);
  try {
    const [eventsA, eventsB] = await Promise.all([drain(driverA.runAsk(inputA)), drain(driverB.runAsk(inputB))]);
    const capturedA = eventsA.find((event: any) => event.type === "session.captured") as any;
    const sessionIdA = capturedA?.payload?.sessionId as string | undefined;
    if (!sessionIdA) throw new Error(`Claude A did not emit session.captured: ${JSON.stringify(eventsA.slice(0, 4))}`);
    const resumed = await drain(driverA.runContinuation({
      ...inputA,
      prompt: "Repeat echo_context after resume.",
      resume: { resumeSessionId: sessionIdA },
    }, "ask"));
    const upstream = hub.state.logs.filter((entry) => entry.event === "upstream_call" && entry.phase === "started");
    const identities = upstream.map((entry) => entry.identity);
    const pass = identities.includes("A") && identities.includes("B") && identities.filter((identity) => identity === "A").length >= 2 && apiA.requests.length >= 7 && apiB.requests.length >= 4;
    return {
      status: pass ? "pass" : "fail",
      actualClaudeCli: executable,
      concurrentProcesses: 2,
      eventCounts: { A: eventsA.length, B: eventsB.length, AResume: resumed.length },
      capturedSessionId: sessionIdA,
      apiRequests: { A: apiA.requests.length, B: apiB.requests.length },
      hubIdentities: identities,
      hubLogs: hub.state.logs,
      note: "两个真实 Claude CLI 进程使用各自的 mcpServers Authorization；本地 API 只提供确定性 tool_use，不代表模型质量。",
    };
  } finally {
    await Promise.all([apiA.close(), apiB.close(), hub.close()]);
  }
}

if (import.meta.main) console.log(JSON.stringify(await runClaudeIsolationProbe(), null, 2));
