import { expect, test } from "bun:test";
import type { SubagentMetricsPersistenceStore } from "../src/main/subagent-metrics-persistence";
import { SubagentMetricsRegistry } from "../src/main/subagent-metrics-registry";
import {
  applyLogicalRequestTerminal,
  bindLogicalRequestAgentId,
  handleBridgeMessagesRequest,
  resolveSdkLateBindAttribution,
} from "../src/main/thread-live-request-coordinator";
import {
  THREAD_LIVE_REQUEST_MAX_FINALIZED_PER_THREAD,
  ThreadLiveRequestRegistry,
} from "../src/main/thread-live-request-registry";

const metricsStoreStub: SubagentMetricsPersistenceStore = {
  listSubagentMetrics: () => [],
  upsertSubagentMetrics: () => {},
  clearSubagentMetrics: () => {},
};

test("concurrent same-role subagents late-bind exact agentIds without cross-talk", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_concurrent_sub";
  const a = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  const b = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });

  expect(
    bindLogicalRequestAgentId(registry, {
      threadId,
      logicalRequestId: a.logicalRequestId,
      agentId: "agent_a",
      role: "coder",
    }),
  ).toMatchObject({ ok: true, bound: true, agentId: "agent_a" });
  expect(
    bindLogicalRequestAgentId(registry, {
      threadId,
      logicalRequestId: b.logicalRequestId,
      agentId: "agent_b",
      role: "coder",
    }),
  ).toMatchObject({ ok: true, bound: true, agentId: "agent_b" });

  expect(registry.findEntryByLogicalId(threadId, a.logicalRequestId)?.agentId).toBe("agent_a");
  expect(registry.findEntryByLogicalId(threadId, b.logicalRequestId)?.agentId).toBe("agent_b");
});

test("terminal before SDK late bind keeps finalized tombstone and accepts agentId upgrade", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_terminal_first";
  const snapshot = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });

  const ui: Array<{ agentId?: string }> = [];
  applyLogicalRequestTerminal(
    registry,
    {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      stage: "completed",
      eventRole: "coder",
      runAttemptId: "attempt_1",
    },
    ({ agentId }) => {
      ui.push(agentId ? { agentId } : {});
    },
  );

  expect(ui).toEqual([{}]);
  expect(registry.listActive(threadId)).toHaveLength(0);
  expect(registry.findFinalizedByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBeUndefined();

  const bind = bindLogicalRequestAgentId(registry, {
    threadId,
    logicalRequestId: snapshot.logicalRequestId,
    agentId: "agent_a",
    role: "coder",
  });
  expect(bind).toMatchObject({
    ok: true,
    bound: true,
    source: "finalized",
    agentId: "agent_a",
  });
  expect(registry.findFinalizedByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBe("agent_a");
});

test("SDK late bind before terminal emits terminal with frozen agentId", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_bind_first";
  const snapshot = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });

  expect(
    bindLogicalRequestAgentId(registry, {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      agentId: "agent_a",
      role: "coder",
    }).ok,
  ).toBe(true);

  const ui: Array<{ agentId?: string }> = [];
  applyLogicalRequestTerminal(
    registry,
    {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      stage: "completed",
      eventRole: "coder",
    },
    ({ agentId }) => {
      ui.push(agentId ? { agentId } : {});
    },
  );
  expect(ui).toEqual([{ agentId: "agent_a" }]);
  expect(registry.findFinalizedByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBe("agent_a");
});

test("duplicate/conflicting agentId or role fail closed", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_conflict";
  const snapshot = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });

  expect(
    bindLogicalRequestAgentId(registry, {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      agentId: "agent_a",
      role: "coder",
    }),
  ).toMatchObject({ ok: true, bound: true });

  expect(
    bindLogicalRequestAgentId(registry, {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      agentId: "agent_b",
      role: "coder",
    }),
  ).toEqual({ ok: false, reason: "agent_conflict" });

  expect(
    bindLogicalRequestAgentId(registry, {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      agentId: "agent_a",
      role: "main",
    }),
  ).toEqual({ ok: false, reason: "role_conflict" });

  expect(registry.findEntryByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBe("agent_a");
});

test("provider request-id duplicates do not merge logical identities", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_provider_dup";
  const first = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  const second = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  registry.recordProviderRequestIdByLogicalId(threadId, first.logicalRequestId, "provider_shared");
  registry.recordProviderRequestIdByLogicalId(threadId, second.logicalRequestId, "provider_shared");

  bindLogicalRequestAgentId(registry, {
    threadId,
    logicalRequestId: first.logicalRequestId,
    agentId: "agent_a",
    role: "coder",
  });
  bindLogicalRequestAgentId(registry, {
    threadId,
    logicalRequestId: second.logicalRequestId,
    agentId: "agent_b",
    role: "coder",
  });

  expect(first.logicalRequestId).not.toBe(second.logicalRequestId);
  expect(registry.findEntryByLogicalId(threadId, first.logicalRequestId)?.agentId).toBe("agent_a");
  expect(registry.findEntryByLogicalId(threadId, second.logicalRequestId)?.agentId).toBe("agent_b");
});

test("main agent and subagent late-bind stay independent via resolveSdkLateBindAttribution", () => {
  const metrics = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_main_sub_prod";
  metrics.noteTaskToolUse(threadId, "toolu_sub", "coder");
  metrics.onSubagentStart(threadId, {
    agentId: "agent_sub",
    role: "coder",
    parentToolUseId: "toolu_sub",
  });

  const main = resolveSdkLateBindAttribution(
    threadId,
    {
      type: "usage.recorded",
      role: "main",
      agentId: "session_main",
      payload: { request_id: "req_main" },
    },
    { plannerSessionId: "session_main" },
  );
  const sub = resolveSdkLateBindAttribution(
    threadId,
    {
      type: "usage.recorded",
      role: "coder",
      agentId: "session_main",
      payload: { request_id: "req_sub", parent_tool_use_id: "toolu_sub" },
    },
    { plannerSessionId: "session_main", metricsRegistry: metrics },
  );

  expect(main).toEqual({ agentId: "session_main", role: "main" });
  expect(sub).toEqual({ agentId: "agent_sub", role: "coder" });
});

test("main agent and subagent late-bind stay independent", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_main_sub";
  const main = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "main",
    emitTimelineActivity: true,
  });
  const sub = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });

  bindLogicalRequestAgentId(registry, {
    threadId,
    logicalRequestId: main.logicalRequestId,
    agentId: "session_main",
    role: "main",
  });
  bindLogicalRequestAgentId(registry, {
    threadId,
    logicalRequestId: sub.logicalRequestId,
    agentId: "agent_sub",
    role: "coder",
  });

  expect(registry.findEntryByLogicalId(threadId, main.logicalRequestId)?.agentId).toBe("session_main");
  expect(registry.findEntryByLogicalId(threadId, sub.logicalRequestId)?.agentId).toBe("agent_sub");
});

test("silent proxy late-bind updates internal state without timeline emission flag", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_silent_bind";
  const snapshot = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: false,
  });

  const bind = bindLogicalRequestAgentId(registry, {
    threadId,
    logicalRequestId: snapshot.logicalRequestId,
    agentId: "agent_silent",
    role: "coder",
  });
  expect(bind).toMatchObject({
    ok: true,
    bound: true,
    emitTimelineActivity: false,
  });

  const ui: string[] = [];
  applyLogicalRequestTerminal(
    registry,
    {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      stage: "completed",
      eventRole: "coder",
    },
    ({ displayRequestId }) => {
      ui.push(displayRequestId);
    },
  );
  expect(ui).toEqual([]);
  expect(registry.findFinalizedByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBe(
    "agent_silent",
  );
});

test("finalized tombstones are bounded and cleared by thread/attempt", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_tombstone_bound";

  for (let i = 0; i < THREAD_LIVE_REQUEST_MAX_FINALIZED_PER_THREAD + 5; i += 1) {
    const snapshot = handleBridgeMessagesRequest(registry, {
      threadId,
      role: "coder",
      emitTimelineActivity: true,
    });
    applyLogicalRequestTerminal(registry, {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      stage: "completed",
      eventRole: "coder",
      runAttemptId: i < 3 ? "attempt_old" : "attempt_new",
    });
  }

  expect(registry.listFinalized(threadId).length).toBe(THREAD_LIVE_REQUEST_MAX_FINALIZED_PER_THREAD);

  registry.clearFinalizedForAttempt(threadId, "attempt_new");
  expect(registry.listFinalized(threadId).every((entry) => entry.runAttemptId !== "attempt_new")).toBe(true);

  registry.clearThread(threadId);
  expect(registry.listActive(threadId)).toHaveLength(0);
  expect(registry.listFinalized(threadId)).toHaveLength(0);
});

test("missing logical id late-bind fail closed", () => {
  const registry = new ThreadLiveRequestRegistry();
  expect(
    bindLogicalRequestAgentId(registry, {
      threadId: "thr_missing",
      logicalRequestId: "req_unknown",
      agentId: "agent_a",
      role: "coder",
    }),
  ).toEqual({ ok: false, reason: "missing" });
});
