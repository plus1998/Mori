import { expect, test } from "bun:test";
import { AgentLifecycleService, type AgentLifecycleStore } from "../src/main/agent-lifecycle-service";
import type { AgentInstanceRecord, RunAttemptRecord } from "../src/main/usage-ledger";

class FakeLifecycleStore implements AgentLifecycleStore {
  readonly attempts = new Map<string, RunAttemptRecord>();
  readonly agents = new Map<string, AgentInstanceRecord>();

  upsertRunAttempt(record: RunAttemptRecord): void {
    this.attempts.set(`${record.threadId}:${record.attemptId}`, record);
  }

  upsertAgentInstance(record: AgentInstanceRecord): void {
    this.agents.set(`${record.threadId}:${record.agentId}`, record);
  }

  listAgentInstances(threadId: string): AgentInstanceRecord[] {
    return [...this.agents.values()].filter((agent) => agent.threadId === threadId);
  }

  getAttempt(threadId: string, attemptId: string): RunAttemptRecord | undefined {
    return this.attempts.get(`${threadId}:${attemptId}`);
  }

  getAgent(threadId: string, agentId: string): AgentInstanceRecord | undefined {
    return this.agents.get(`${threadId}:${agentId}`);
  }
}

function createService(store: FakeLifecycleStore): AgentLifecycleService {
  let tick = 0;
  return new AgentLifecycleService(store, {
    now: () => `2026-01-01T00:00:0${tick++}.000Z`,
    attemptId: ({ phase, retryIndex }) => `attempt_${phase}_${retryIndex}`,
  });
}

test("AgentLifecycleService rehydrates in-flight attempt after history prune wipe", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);

  const attempt = service.startRunAttempt({
    threadId: "thr_rehydrate",
    phase: "execution",
    retryIndex: 0,
  });
  const originalStartedAt = store.getAttempt("thr_rehydrate", attempt.attemptId)?.startedAt;
  expect(originalStartedAt).toBe("2026-01-01T00:00:00.000Z");

  // Simulate rewind prune deleting the DB row while lifecycle still holds it.
  store.attempts.delete(`thr_rehydrate:${attempt.attemptId}`);
  store.agents.delete(`thr_rehydrate:main:${attempt.attemptId}`);
  expect(store.getAttempt("thr_rehydrate", attempt.attemptId)).toBeUndefined();

  expect(service.rehydrateCurrentRunAttempt("thr_rehydrate")).toBe(true);
  expect(store.getAttempt("thr_rehydrate", attempt.attemptId)?.startedAt).toBe("2026-01-01T00:00:01.000Z");
  expect(store.getAgent("thr_rehydrate", `main:${attempt.attemptId}`)?.status).toBe("active");

  expect(service.rehydrateCurrentRunAttempt("thr_rehydrate", "2026-01-01T00:00:05.000Z")).toBe(true);
  expect(store.getAttempt("thr_rehydrate", attempt.attemptId)?.startedAt).toBe("2026-01-01T00:00:05.000Z");
});

test("AgentLifecycleService records run attempts and planner agent lifecycle", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);

  const attempt = service.startRunAttempt({
    threadId: "thr_lifecycle",
    phase: "execution",
    retryIndex: 0,
  });
  expect(attempt.attemptId).toBe("attempt_execution_0");
  expect(service.currentRunAttemptId("thr_lifecycle")).toBe("attempt_execution_0");
  expect(service.currentPlannerAgentId("thr_lifecycle")).toBe("main:attempt_execution_0");

  service.finishRunAttempt("thr_lifecycle", "completed");

  expect(store.getAttempt("thr_lifecycle", "attempt_execution_0")?.status).toBe("completed");
  expect(store.getAgent("thr_lifecycle", "main:attempt_execution_0")?.status).toBe("stopped");
  expect(service.currentRunAttemptId("thr_lifecycle")).toBeUndefined();
  expect(service.usageRunAttemptId("thr_lifecycle")).toBe("attempt_execution_0");
  expect(service.usagePlannerAgentId("thr_lifecycle")).toBe("main:attempt_execution_0");
});

test("AgentLifecycleService persists a caller-planned command attempt identity", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  const commandDispatch = {
    principalId: "principal_1",
    clientCommandId: "command_1",
    dispatchId: "dispatch_1",
  };

  const attempt = service.startRunAttempt({
    threadId: "thr_command",
    phase: "continuation",
    retryIndex: 0,
    attemptId: "attempt_planned",
    metadata: { commandDispatch },
    commandDispatch,
  });

  expect(attempt).toMatchObject({
    attemptId: "attempt_planned",
    metadata: { commandDispatch },
  });
  expect(store.getAttempt("thr_command", "attempt_planned")).toMatchObject({
    status: "running",
    metadata: { commandDispatch },
  });
});

test("AgentLifecycleService requires explicit parent tool use for interleaved subagents", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_lifecycle", phase: "execution", retryIndex: 0 });

  service.noteTaskToolUse("thr_lifecycle", "toolu_explore", "explore");
  service.noteTaskToolUse("thr_lifecycle", "toolu_coder", "coder");
  service.startSubagent({
    threadId: "thr_lifecycle",
    agentId: "agent_coder",
    role: "coder",
    parentToolUseId: "toolu_coder",
    missionKey: "implement",
    todoId: "todo-1",
  });
  service.startSubagent({
    threadId: "thr_lifecycle",
    agentId: "agent_explore",
    role: "explore",
    parentToolUseId: "toolu_explore",
  });

  const coder = store.getAgent("thr_lifecycle", "agent_coder");
  const explore = store.getAgent("thr_lifecycle", "agent_explore");
  expect(coder?.parentToolUseId).toBe("toolu_coder");
  expect(coder?.runAttemptId).toBe("attempt_execution_0");
  expect(coder?.parentAgentId).toBe("main:attempt_execution_0");
  expect(coder?.todoId).toBe("todo-1");
  expect(explore?.parentToolUseId).toBe("toolu_explore");
});

test("AgentLifecycleService prefers explicit parentToolUseId over role FIFO", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_explicit_parent", phase: "execution", retryIndex: 0 });

  service.noteTaskToolUse("thr_explicit_parent", "toolu_a", "coder");
  service.noteTaskToolUse("thr_explicit_parent", "toolu_b", "coder");
  service.startSubagent({
    threadId: "thr_explicit_parent",
    agentId: "agent_coder_b",
    role: "coder",
    parentToolUseId: "toolu_b",
  });
  service.startSubagent({
    threadId: "thr_explicit_parent",
    agentId: "agent_coder_a",
    role: "coder",
    parentToolUseId: "toolu_a",
  });

  expect(store.getAgent("thr_explicit_parent", "agent_coder_a")?.parentToolUseId).toBe("toolu_a");
  expect(store.getAgent("thr_explicit_parent", "agent_coder_b")?.parentToolUseId).toBe("toolu_b");
});

test("AgentLifecycleService links parent tool use after stream-delayed delegation", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_stream_link", phase: "execution", retryIndex: 0 });
  service.startSubagent({
    threadId: "thr_stream_link",
    agentId: "agent_explore",
    role: "explore",
  });

  const linked = service.linkSubagentParentToolUse({
    threadId: "thr_stream_link",
    agentId: "agent_explore",
    parentToolUseId: "call_00_delegate",
  });

  expect(linked?.parentToolUseId).toBe("call_00_delegate");
  expect(store.getAgent("thr_stream_link", "agent_explore")?.parentToolUseId).toBe("call_00_delegate");
});

test("AgentLifecycleService records dynamic subagents by runtime role", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_dynamic_lifecycle", phase: "execution", retryIndex: 0 });

  service.noteTaskToolUse("thr_dynamic_lifecycle", "toolu_research", "researcher");
  service.startSubagent({
    threadId: "thr_dynamic_lifecycle",
    agentId: "agent_researcher",
    role: "researcher",
    parentToolUseId: "toolu_research",
    missionKey: "market research",
  });

  const researcher = store.getAgent("thr_dynamic_lifecycle", "agent_researcher");
  expect(researcher).toMatchObject({
    role: "researcher",
    kind: "subagent",
    status: "active",
    parentToolUseId: "toolu_research",
    missionKey: "market research",
  });
});

test("AgentLifecycleService finalizes active subagents as abandoned on failed run", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_lifecycle", phase: "execution", retryIndex: 0 });
  service.noteTaskToolUse("thr_lifecycle", "toolu_coder", "coder");
  service.startSubagent({
    threadId: "thr_lifecycle",
    agentId: "agent_coder",
    role: "coder",
  });

  service.finishRunAttempt("thr_lifecycle", "failed");

  expect(store.getAttempt("thr_lifecycle", "attempt_execution_0")?.status).toBe("failed");
  expect(store.getAgent("thr_lifecycle", "agent_coder")?.status).toBe("abandoned");
  expect(store.getAgent("thr_lifecycle", "main:attempt_execution_0")?.status).toBe("abandoned");
});

test("AgentLifecycleService stops subagents explicitly before run finalizer", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_lifecycle", phase: "execution", retryIndex: 0 });
  service.startSubagent({
    threadId: "thr_lifecycle",
    agentId: "agent_coder",
    role: "coder",
  });

  service.stopSubagent({
    threadId: "thr_lifecycle",
    agentId: "agent_coder",
    role: "coder",
  });
  service.finishRunAttempt("thr_lifecycle", "completed");

  expect(store.getAgent("thr_lifecycle", "agent_coder")?.status).toBe("stopped");
});

test("AgentLifecycleService abandons a persisted subagent missing from activeAgents", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_stale_active", phase: "execution", retryIndex: 0 });
  store.upsertAgentInstance({
    threadId: "thr_stale_active",
    agentId: "agent_explore",
    role: "explore",
    kind: "subagent",
    status: "active",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  service.abandonSubagent({
    threadId: "thr_stale_active",
    agentId: "agent_explore",
    role: "explore",
  });

  expect(store.getAgent("thr_stale_active", "agent_explore")?.status).toBe("abandoned");
});

test("AgentLifecycleService does not mint a phantom card when abandon has no instance", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_no_instance", phase: "execution", retryIndex: 0 });

  service.abandonSubagent({
    threadId: "thr_no_instance",
    agentId: "agent_explore",
    role: "explore",
  });

  expect(store.getAgent("thr_no_instance", "agent_explore")).toBeUndefined();
});

test("AgentLifecycleService overlays abandoned onto a stopped subagent", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_overlay_abandon", phase: "execution", retryIndex: 0 });
  service.startSubagent({
    threadId: "thr_overlay_abandon",
    agentId: "agent_explore",
    role: "explore",
  });
  service.stopSubagent({
    threadId: "thr_overlay_abandon",
    agentId: "agent_explore",
    role: "explore",
  });
  expect(store.getAgent("thr_overlay_abandon", "agent_explore")?.status).toBe("stopped");

  service.abandonSubagent({
    threadId: "thr_overlay_abandon",
    agentId: "agent_explore",
    role: "explore",
  });

  expect(store.getAgent("thr_overlay_abandon", "agent_explore")?.status).toBe("abandoned");
});

test("AgentLifecycleService abandons a failed subagent before run finalizer", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  service.startRunAttempt({ threadId: "thr_lifecycle", phase: "execution", retryIndex: 0 });
  service.startSubagent({
    threadId: "thr_lifecycle",
    agentId: "agent_tester",
    role: "tester",
  });

  service.abandonSubagent({
    threadId: "thr_lifecycle",
    agentId: "agent_tester",
    role: "tester",
  });
  service.finishRunAttempt("thr_lifecycle", "completed");

  expect(store.getAgent("thr_lifecycle", "agent_tester")?.status).toBe("abandoned");
});

test("AgentLifecycleService settles recovered running attempts and active agents", () => {
  const store = new FakeLifecycleStore();
  const service = createService(store);
  const attempt: RunAttemptRecord = {
    threadId: "thr_recovered",
    attemptId: "attempt_execution_0",
    phase: "execution",
    retryIndex: 0,
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  const completedAttempt: RunAttemptRecord = {
    ...attempt,
    attemptId: "attempt_execution_done",
    status: "completed",
    endedAt: "2026-01-01T00:00:02.000Z",
  };
  const activeAgent: AgentInstanceRecord = {
    threadId: "thr_recovered",
    agentId: "agent_coder",
    role: "coder",
    kind: "subagent",
    status: "active",
    runAttemptId: attempt.attemptId,
    startedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
  };
  const stoppedAgent: AgentInstanceRecord = {
    ...activeAgent,
    agentId: "agent_done",
    status: "stopped",
    endedAt: "2026-01-01T00:00:02.000Z",
  };

  const result = service.settleRecoveredThread({
    threadId: "thr_recovered",
    attempts: [attempt, completedAttempt],
    agents: [activeAgent, stoppedAgent],
    runStatus: "failed",
  });

  expect(result).toEqual({
    runAttemptsSettled: 1,
    agentInstancesSettled: 1,
    settledRunAttemptIds: ["attempt_execution_0"],
  });
  expect(store.getAttempt("thr_recovered", "attempt_execution_0")?.status).toBe("failed");
  expect(store.getAttempt("thr_recovered", "attempt_execution_done")).toBeUndefined();
  expect(store.getAgent("thr_recovered", "agent_coder")?.status).toBe("abandoned");
  expect(store.getAgent("thr_recovered", "agent_done")).toBeUndefined();
});
