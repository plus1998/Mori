import { expect, test } from "bun:test";
import {
  applyLogicalRequestTerminal,
  bindLogicalRequestAgentId,
  handleBridgeMessagesRequest,
  resolveFrozenLiveRequestAttribution,
  resolveUpstreamConnectionErrorAttribution,
} from "../src/main/thread-live-request-coordinator";
import { ThreadLiveRequestRegistry } from "../src/main/thread-live-request-registry";

function createFrozenAgentA(registry: ThreadLiveRequestRegistry, threadId: string) {
  return handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    agentId: "agent_a",
    emitTimelineActivity: true,
  });
}

function simulateLaterStampAgentB(registry: ThreadLiveRequestRegistry, threadId: string) {
  return handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    agentId: "agent_b",
    emitTimelineActivity: true,
  });
}

test("Bridge snapshot stays role-only; late bind supplies agentId after explicit SDK evidence", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_attr_late_bind";
  const snapshot = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  expect(snapshot.agentId).toBeUndefined();

  bindLogicalRequestAgentId(registry, {
    threadId,
    logicalRequestId: snapshot.logicalRequestId,
    agentId: "agent_a",
    role: "coder",
  });

  const frozen = resolveFrozenLiveRequestAttribution(registry, threadId, snapshot.logicalRequestId);
  expect(frozen?.agentId).toBe("agent_a");
});

test("Bridge snapshot and frozen lookup keep agent_a after later same-role stamp becomes agent_b", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_attr_stamp";
  const snapshot = createFrozenAgentA(registry, threadId);
  expect(snapshot.role).toBe("coder");
  expect(snapshot.agentId).toBe("agent_a");

  simulateLaterStampAgentB(registry, threadId);

  const frozen = resolveFrozenLiveRequestAttribution(registry, threadId, snapshot.logicalRequestId);
  expect(frozen).toEqual({
    logicalRequestId: snapshot.logicalRequestId,
    role: "coder",
    agentId: "agent_a",
    emitTimelineActivity: true,
  });
  expect(snapshot.agentId).toBe("agent_a");
  expect(snapshot.role).toBe("coder");
});

test("terminal UI uses frozen entry agent_a even after later stamp/input is agent_b", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_attr_terminal";
  const snapshot = createFrozenAgentA(registry, threadId);
  simulateLaterStampAgentB(registry, threadId);

  const ui: Array<{ role: string; agentId?: string; displayRequestId: string }> = [];
  const result = applyLogicalRequestTerminal(
    registry,
    {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      stage: "completed",
      eventRole: "coder",
    },
    ({ role, agentId, displayRequestId }) => {
      ui.push({ role, ...(agentId ? { agentId } : {}), displayRequestId });
    },
  );

  expect(result).toEqual({ ok: true });
  expect(ui).toEqual([
    {
      role: "coder",
      agentId: "agent_a",
      displayRequestId: snapshot.logicalRequestId,
    },
  ]);
  expect(registry.findEntryByLogicalId(threadId, snapshot.logicalRequestId)).toBeUndefined();
});

test("connection diagnostic uses frozen entry agent_a even after later stamp is agent_b", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_attr_conn";
  const snapshot = createFrozenAgentA(registry, threadId);
  simulateLaterStampAgentB(registry, threadId);

  const attribution = resolveUpstreamConnectionErrorAttribution(registry, {
    threadId,
    logicalRequestId: snapshot.logicalRequestId,
    eventRole: "coder",
    statusCode: 503,
  });

  expect(attribution).toEqual({
    logicalRequestId: snapshot.logicalRequestId,
    role: "coder",
    agentId: "agent_a",
    emitTimelineActivity: true,
  });
  expect(registry.findEntryByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBe("agent_a");
});

test("started extras come from frozen snapshot agent_a after later stamp is agent_b", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_attr_started";
  const snapshot = createFrozenAgentA(registry, threadId);
  simulateLaterStampAgentB(registry, threadId);

  const started = resolveFrozenLiveRequestAttribution(registry, threadId, snapshot.logicalRequestId);
  expect(started?.agentId).toBe("agent_a");
  expect(started?.role).toBe("coder");
  expect(started?.logicalRequestId).toBe(snapshot.logicalRequestId);
  expect(snapshot.agentId).toBe("agent_a");
});

test("terminal eventRole conflict fail closed and keeps entry active", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_attr_role_conflict";
  const snapshot = createFrozenAgentA(registry, threadId);

  const ui: string[] = [];
  const result = applyLogicalRequestTerminal(
    registry,
    {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      stage: "failed",
      eventRole: "main",
    },
    ({ displayRequestId }) => {
      ui.push(displayRequestId);
    },
  );

  expect(result).toEqual({ ok: false, reason: "role_conflict" });
  expect(ui).toEqual([]);
  expect(registry.findEntryByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBe("agent_a");
  expect(registry.listActive(threadId)).toHaveLength(1);
});

test("connection diagnostic eventRole conflict fail closed and keeps entry active", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_attr_conn_conflict";
  const snapshot = createFrozenAgentA(registry, threadId);

  expect(
    resolveUpstreamConnectionErrorAttribution(registry, {
      threadId,
      logicalRequestId: snapshot.logicalRequestId,
      eventRole: "main",
    }),
  ).toBeUndefined();
  expect(registry.findEntryByLogicalId(threadId, snapshot.logicalRequestId)?.agentId).toBe("agent_a");
  expect(registry.listActive(threadId)).toHaveLength(1);
});
