import { expect, test } from "bun:test";
import {
  applyLogicalRequestTerminal,
  handleBridgeMessagesRequest,
  resolvePiUsageLogicalRequestId,
} from "../src/main/thread-live-request-coordinator";
import { ThreadLiveRequestRegistry } from "../src/main/thread-live-request-registry";

test("handleBridgeMessagesRequest records emitTimelineActivity on registry entry", () => {
  const registry = new ThreadLiveRequestRegistry();
  const silent = handleBridgeMessagesRequest(registry, {
    threadId: "thr_1",
    role: "coder",
    emitTimelineActivity: false,
  });
  expect(silent.emitTimelineActivity).toBe(false);
  expect(registry.listActive("thr_1")[0]?.emitTimelineActivity).toBe(false);

  const visible = handleBridgeMessagesRequest(registry, {
    threadId: "thr_1",
    role: "main",
    emitTimelineActivity: true,
  });
  expect(visible.emitTimelineActivity).toBe(true);
  expect(registry.listActive("thr_1")[1]?.emitTimelineActivity).toBe(true);
});

test("handleBridgeMessagesRequest snapshot always corresponds to a registry entry", () => {
  const registry = new ThreadLiveRequestRegistry();
  const snapshot = handleBridgeMessagesRequest(registry, {
    threadId: "thr_create",
    role: "coder",
    agentId: "agent_a",
    emitTimelineActivity: true,
  });

  const entry = registry.findEntryByLogicalId("thr_create", snapshot.logicalRequestId);
  expect(entry).toBeDefined();
  expect(entry?.logicalRequestId).toBe(snapshot.logicalRequestId);
  expect(entry?.role).toBe(snapshot.role);
  expect(entry?.agentId).toBe(snapshot.agentId);
  expect(entry?.emitTimelineActivity).toBe(snapshot.emitTimelineActivity);
});

test("applyLogicalRequestTerminal suppresses UI but clears registry for silent entries", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_silent";
  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: false,
  });

  const uiEvents: string[] = [];
  applyLogicalRequestTerminal(
    registry,
    { threadId, eventRole: "coder", logicalRequestId, stage: "completed" },
    ({ displayRequestId }) => {
      uiEvents.push(displayRequestId);
    },
  );

  expect(uiEvents).toEqual([]);
  expect(registry.listActive(threadId)).toHaveLength(0);
});

test("applyLogicalRequestTerminal emits logical correlation id then always clears registry", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_visible";
  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  registry.recordProviderRequestIdByLogicalId(threadId, logicalRequestId, "provider_1");

  const uiEvents: string[] = [];
  applyLogicalRequestTerminal(
    registry,
    { threadId, eventRole: "coder", logicalRequestId, stage: "failed", detail: "HTTP 502" },
    ({ displayRequestId, providerRequestId, stage, detail }) => {
      uiEvents.push(`${displayRequestId}:${providerRequestId ?? ""}:${stage}:${detail ?? ""}`);
    },
  );

  expect(uiEvents).toEqual([`${logicalRequestId}:provider_1:failed:HTTP 502`]);
  expect(registry.listActive(threadId)).toHaveLength(0);
});

test("resolvePiUsageLogicalRequestId prefers the strict agent-scoped match", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_pi_strict";
  handleBridgeMessagesRequest(registry, { threadId, role: "main", agentId: "session_a" });

  expect(
    resolvePiUsageLogicalRequestId(registry, threadId, { role: "main", agentId: "session_a" }),
  ).toBe(registry.listActive(threadId)[0]?.logicalRequestId);
});

test("resolvePiUsageLogicalRequestId falls back to an unstamped active entry when the event carries an agentId", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_pi_unstamped";
  const begun = handleBridgeMessagesRequest(registry, { threadId, role: "main" });

  expect(
    resolvePiUsageLogicalRequestId(registry, threadId, {
      role: "main",
      agentId: "main:attempt_execution_0_1",
    }),
  ).toBe(begun.logicalRequestId);
});

test("resolvePiUsageLogicalRequestId falls back to the newest unstamped finalized tombstone", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_pi_finalized";
  const begun = handleBridgeMessagesRequest(registry, { threadId, role: "main" });
  registry.moveToFinalized(threadId, begun.logicalRequestId);

  expect(
    resolvePiUsageLogicalRequestId(registry, threadId, {
      role: "main",
      agentId: "main:attempt_execution_0_1",
    }),
  ).toBe(begun.logicalRequestId);
});

test("resolvePiUsageLogicalRequestId fails closed when only a foreign-agent tombstone exists", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_pi_foreign";
  const begun = handleBridgeMessagesRequest(registry, { threadId, role: "main", agentId: "session_b" });
  registry.moveToFinalized(threadId, begun.logicalRequestId);

  expect(
    resolvePiUsageLogicalRequestId(registry, threadId, {
      role: "main",
      agentId: "session_a",
    }),
  ).toBeUndefined();
});

test("resolvePiUsageLogicalRequestId never crosses roles", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_pi_role";
  const begun = handleBridgeMessagesRequest(registry, { threadId, role: "coder" });

  expect(
    resolvePiUsageLogicalRequestId(registry, threadId, { role: "main", agentId: "session_a" }),
  ).toBeUndefined();
  expect(
    resolvePiUsageLogicalRequestId(registry, threadId, { role: "coder" }),
  ).toBe(begun.logicalRequestId);
});
