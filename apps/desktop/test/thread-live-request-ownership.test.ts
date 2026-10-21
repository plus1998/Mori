import { expect, test } from "bun:test";
import {
  finalizeLiveRequest,
  handleBridgeMessagesRequest,
  markBridgeRequestStartedPersisted,
  recordProviderRequestIdForLogical,
  resolveLiveRequestIdForEvent,
  shouldEmitRetryScheduledCancellation,
  shouldEmitSdkShadowRequestTerminal,
  shouldPersistRequestStartedShadowEvent,
} from "../src/main/thread-live-request-coordinator";
import { ThreadLiveRequestRegistry } from "../src/main/thread-live-request-registry";
import {
  clearRequestStartedPersisted,
  markRequestStartedPersisted,
} from "../src/main/thread-request-lifecycle";

test("resolveLiveRequestIdForEvent never resolves SDK request.started via registry", () => {
  const registry = new ThreadLiveRequestRegistry();
  registry.beginRequest("thr_1", { role: "coder" });
  const resolved = resolveLiveRequestIdForEvent(registry, "thr_1", {
    type: "request.started",
    role: "coder",
    stream: false,
  });
  expect(resolved).toBeUndefined();
});

test("thinking.final does not end the live request; message.final can still resolve it", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_thinking_then_text";
  clearRequestStartedPersisted(threadId);

  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "main",
    emitTimelineActivity: true,
  });
  markBridgeRequestStartedPersisted(threadId, logicalRequestId);

  expect(
    shouldEmitSdkShadowRequestTerminal({
      eventType: "thinking.final",
    }),
  ).toBe(false);

  const thinkingResolved = resolveLiveRequestIdForEvent(registry, threadId, {
    type: "thinking.final",
    role: "thinking",
    stream: false,
  });
  expect(thinkingResolved).toBe(logicalRequestId);
  expect(registry.listActive(threadId)).toHaveLength(1);

  const messageDeltaResolved = resolveLiveRequestIdForEvent(registry, threadId, {
    type: "message.delta",
    role: "main",
    stream: true,
  });
  expect(messageDeltaResolved).toBe(logicalRequestId);

  const messageFinalResolved = resolveLiveRequestIdForEvent(registry, threadId, {
    type: "message.final",
    role: "main",
    stream: false,
  });
  expect(messageFinalResolved).toBe(logicalRequestId);
  expect(
    shouldEmitSdkShadowRequestTerminal({
      eventType: "message.final",
    }),
  ).toBe(true);
});

test("shouldPersistRequestStartedShadowEvent rejects SDK request.started without bridge logical id", () => {
  expect(
    shouldPersistRequestStartedShadowEvent({
      eventType: "request.started",
      bridgeLogicalRequestId: undefined,
    }),
  ).toBe(false);
  expect(
    shouldPersistRequestStartedShadowEvent({
      eventType: "request.started",
      bridgeLogicalRequestId: "req_bridge",
    }),
  ).toBe(true);
});

test("Bridge started then provider rekey then delayed SDK request.started keeps single started bookkeeping", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_race";
  clearRequestStartedPersisted(threadId);

  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  expect(markBridgeRequestStartedPersisted(threadId, logicalRequestId)).toBe(true);

  recordProviderRequestIdForLogical(registry, threadId, logicalRequestId, "provider_req_1");
  expect(registry.findEntryByLogicalId(threadId, logicalRequestId)?.providerRequestId).toBe("provider_req_1");
  expect(registry.findEntryByLogicalId(threadId, logicalRequestId)?.logicalRequestId).toBe(logicalRequestId);

  const sdkResolved = resolveLiveRequestIdForEvent(registry, threadId, {
    type: "request.started",
    role: "coder",
    stream: false,
  });
  expect(sdkResolved).toBeUndefined();
  expect(
    shouldPersistRequestStartedShadowEvent({
      eventType: "request.started",
      bridgeLogicalRequestId: undefined,
    }),
  ).toBe(false);

  expect(markBridgeRequestStartedPersisted(threadId, logicalRequestId)).toBe(false);
  expect(registry.listActive(threadId)).toHaveLength(1);

  finalizeLiveRequest(registry, threadId, logicalRequestId);
  expect(registry.listActive(threadId)).toHaveLength(0);
  expect(markBridgeRequestStartedPersisted(threadId, logicalRequestId)).toBe(true);
});

test("SDK request.started before Bridge registration does not create orphan entry", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_sdk_first";

  const sdkFirst = resolveLiveRequestIdForEvent(registry, threadId, {
    type: "request.started",
    role: "main",
    stream: false,
  });
  expect(sdkFirst).toBeUndefined();
  expect(registry.listActive(threadId)).toHaveLength(0);

  const bridgeEntry = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "main",
    emitTimelineActivity: true,
  });
  expect(registry.listActive(threadId)).toHaveLength(1);
  expect(registry.listActive(threadId)[0]?.logicalRequestId).toBe(bridgeEntry.logicalRequestId);
});

test("agentId resolve is fail closed when two concurrent requests share agentId", () => {
  const registry = new ThreadLiveRequestRegistry();
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });
  registry.beginRequest("thr_1", { role: "coder", agentId: "agent_a" });

  expect(registry.resolve("thr_1", { agentId: "agent_a" })).toBeUndefined();
  expect(
    resolveLiveRequestIdForEvent(registry, "thr_1", {
      type: "message.delta",
      role: "coder",
      stream: true,
      agentId: "agent_a",
    }),
  ).toBeUndefined();
});

test("shouldEmitRetryScheduledCancellation fail closed when same role has concurrent active requests", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_retry";
  registry.beginRequest(threadId, { role: "coder" });
  registry.beginRequest(threadId, { role: "coder" });

  const resolved = resolveLiveRequestIdForEvent(registry, threadId, {
    type: "request.retry_scheduled",
    role: "coder",
    stream: false,
  });
  expect(resolved).toBeUndefined();
  expect(shouldEmitRetryScheduledCancellation(registry, threadId, undefined)).toBe(false);
  expect(shouldEmitRetryScheduledCancellation(registry, threadId, "unknown")).toBe(false);
});

test("shouldEmitRetryScheduledCancellation allows explicit active request id only", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_retry_explicit";
  const first = registry.beginRequest(threadId, { role: "coder" });
  registry.beginRequest(threadId, { role: "coder" });

  expect(shouldEmitRetryScheduledCancellation(registry, threadId, first.logicalRequestId)).toBe(true);
  expect(shouldEmitRetryScheduledCancellation(registry, threadId, "unknown")).toBe(false);

  registry.endRequest(threadId, first.logicalRequestId);
  expect(shouldEmitRetryScheduledCancellation(registry, threadId, first.logicalRequestId)).toBe(false);
});

test("markRequestStartedPersisted dedupes Bridge request.started by logical id", () => {
  const threadId = "thr_dedupe";
  clearRequestStartedPersisted(threadId);
  expect(markRequestStartedPersisted(threadId, "req_bridge")).toBe(true);
  expect(markRequestStartedPersisted(threadId, "req_bridge")).toBe(false);
});

test("finalizeLiveRequest clears started bookkeeping by logical id after provider rekey", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_rekey_terminal";
  clearRequestStartedPersisted(threadId);

  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  markBridgeRequestStartedPersisted(threadId, logicalRequestId);
  recordProviderRequestIdForLogical(registry, threadId, logicalRequestId, "provider_terminal");

  finalizeLiveRequest(registry, threadId, logicalRequestId);
  expect(registry.listActive(threadId)).toHaveLength(0);
  expect(markBridgeRequestStartedPersisted(threadId, logicalRequestId)).toBe(true);
});
