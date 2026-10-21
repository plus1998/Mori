import { expect, test } from "bun:test";
import type { AgentLifecycleService } from "../src/main/agent-lifecycle-service";
import type { ConversationStore } from "../src/main/conversation-store";
import { createSdkStreamActivityIngestion } from "../src/main/sdk-stream-activity-ingestion";
import { ThreadLiveRequestRegistry } from "../src/main/thread-live-request-registry";
import type { AgentInstanceRecord } from "../src/main/usage-ledger";
import type { ThreadRunEventInput } from "../src/shared/ipc";

function createIngestionHarness(agents: AgentInstanceRecord[] = []) {
  const appended: ThreadRunEventInput[] = [];
  const abandoned: string[] = [];
  const stoppedSessions: string[] = [];
  const store = {
    listAgentInstances: () => agents,
    appendConversationRuntimeEvent: (event: ThreadRunEventInput) => {
      appended.push(event);
      return { ...event, sequence: appended.length };
    },
    markSubagentSessionStopped: (_threadId: string, agentId: string) => {
      stoppedSessions.push(agentId);
    },
    getSdkSession: () => undefined,
    getThreadCoreSession: () => undefined,
    getThread: (threadId: string) => ({ id: threadId, status: "running" }),
  } as unknown as ConversationStore;

  const lifecycle = {
    abandonSubagent: (input: { agentId: string }) => {
      abandoned.push(input.agentId);
    },
    stopSubagent: () => {},
    usageRunAttemptId: () => "attempt_1",
    currentPlannerAgentId: () => "main:attempt_1",
    currentRunAttemptId: () => "attempt_1",
    linkSubagentParentToolUse: () => undefined,
    noteTaskToolUse: () => {},
  } as unknown as AgentLifecycleService;

  const metricsRegistry = {
    roleForAgentId: () => undefined,
    resolveAgentIdByParentToolUse: () => undefined,
    onSubagentStop: () => {},
    linkToolUseToAgent: () => {},
    noteTaskToolUse: () => {},
  } as never;

  const ingestion = createSdkStreamActivityIngestion({
    store,
    lifecycle,
    metricsRegistry,
    usageLedger: { settleProxyPendingForSubagentStart: () => 0 },
    contextLifecycle: { handleSdkContextEvent: () => false },
    liveRequestRegistry: new ThreadLiveRequestRegistry(),
    emitRequestTerminalEvent: () => {},
    onProjectionUpdated: () => {},
  });

  return { ingestion, appended, abandoned, stoppedSessions };
}

test("SDK notices before init and after result never become assistant answers or root agent cards", () => {
  const { ingestion, appended } = createIngestionHarness();
  for (const payload of [
    { type: "system", subtype: "session_state_changed", state: "running" },
    { type: "system", subtype: "informational", content: "Provider notice", level: "warning" },
    { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
    { type: "conversation_reset", new_conversation_id: "next-session" },
    { type: "system", subtype: "commands_changed", commands: [{ name: "probe" }] },
    { type: "system", subtype: "session_state_changed", state: "idle" },
  ]) {
    ingestion.ingest("thr_notice", {
      type: "agent.started",
      role: "main",
      agentId: "root-session-before-init",
      payload,
    });
  }
  expect(appended).toHaveLength(6);
  expect(appended.every((event) => event.eventType === "diagnostic" && event.role === "system")).toBe(true);
  expect(appended.every((event) => !event.agentId && event.scope === "main")).toBe(true);
});

test("failed agent_output still writes agent.abandoned when the store has no instance", () => {
  const { ingestion, appended, abandoned, stoppedSessions } = createIngestionHarness();

  ingestion.ingest("thr_fail", {
    type: "agent.completed",
    role: "explore",
    agentId: "agent_explore_failed",
    payload: {
      type: "agent_output",
      status: "failed",
      failed: true,
      agentId: "agent_explore_failed",
      agentType: "explore",
      tool_use_id: "call_explore_failed",
      error: "Agent terminated early due to an API error: 400",
    },
  });

  expect(abandoned).toEqual(["agent_explore_failed"]);
  expect(stoppedSessions).toEqual(["agent_explore_failed"]);
  expect(appended).toEqual([
    expect.objectContaining({
      eventType: "agent.abandoned",
      agentId: "agent_explore_failed",
      role: "explore",
      parentToolUseId: "call_explore_failed",
    }),
  ]);
});

test("failed agent_output settles the store instance linked by parent_tool_use_id", () => {
  const { ingestion, appended, abandoned } = createIngestionHarness([
    {
      threadId: "thr_fail",
      agentId: "agent_explore",
      role: "explore",
      kind: "subagent",
      status: "active",
      parentToolUseId: "call_explore_failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  ingestion.ingest("thr_fail", {
    type: "agent.completed",
    role: "explore",
    agentId: "agent_output_id",
    payload: {
      type: "agent_output",
      status: "failed",
      failed: true,
      agentId: "agent_output_id",
      agentType: "explore",
      tool_use_id: "call_explore_failed",
      error: "API Error: 400 No provider route configured",
    },
  });

  expect(abandoned).toEqual(["agent_explore"]);
  expect(appended[0]).toMatchObject({
    eventType: "agent.abandoned",
    agentId: "agent_explore",
    parentToolUseId: "call_explore_failed",
  });
});

test("already abandoned agent_output does not write a second lifecycle event", () => {
  const { ingestion, appended, abandoned } = createIngestionHarness([
    {
      threadId: "thr_fail",
      agentId: "agent_explore_failed",
      role: "explore",
      kind: "subagent",
      status: "abandoned",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    },
  ]);

  ingestion.ingest("thr_fail", {
    type: "agent.completed",
    role: "explore",
    agentId: "agent_explore_failed",
    payload: {
      type: "agent_output",
      status: "failed",
      failed: true,
      agentId: "agent_explore_failed",
    },
  });

  expect(abandoned).toEqual([]);
  expect(appended).toEqual([]);
});
