import { expect, test } from "bun:test";
import {
  applyLogicalRequestTerminal,
  finalizeDisplayRequestTerminal,
  finalizeLiveRequest,
  GATEWAY_ATTEMPT_CONNECTION_ERROR_ORIGIN,
  handleBridgeMessagesRequest,
  markBridgeRequestStartedPersisted,
  recordProviderRequestIdForLogical,
  resolveConnectionErrorLogicalRequestId,
  shouldEmitSdkShadowRequestTerminal,
  shouldEmitUpstreamConnectionErrorActivity,
  shouldEmitUpstreamConnectionErrorFromLifecycle,
} from "../src/main/thread-live-request-coordinator";
import { ThreadLiveRequestRegistry } from "../src/main/thread-live-request-registry";
import {
  clearRequestStartedPersisted,
  markRequestStartedPersisted,
} from "../src/main/thread-request-lifecycle";

test("finalizeDisplayRequestTerminal clears started set by logical id after provider metadata recorded", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_display_terminal";
  clearRequestStartedPersisted(threadId);

  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  markBridgeRequestStartedPersisted(threadId, logicalRequestId);
  recordProviderRequestIdForLogical(registry, threadId, logicalRequestId, "provider_terminal");

  const clearedLogical = finalizeDisplayRequestTerminal(registry, threadId, logicalRequestId);
  expect(clearedLogical).toBe(logicalRequestId);
  expect(registry.listActive(threadId)).toHaveLength(0);
  expect(markBridgeRequestStartedPersisted(threadId, logicalRequestId)).toBe(true);
});

test("applyLogicalRequestTerminal always finalizes after visible UI callback", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_visible_terminal";
  clearRequestStartedPersisted(threadId);
  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });
  markBridgeRequestStartedPersisted(threadId, logicalRequestId);
  recordProviderRequestIdForLogical(registry, threadId, logicalRequestId, "provider_visible");

  const uiEvents: string[] = [];
  applyLogicalRequestTerminal(
    registry,
    { threadId, eventRole: "coder", logicalRequestId, stage: "failed", detail: "HTTP 502" },
    ({ displayRequestId, providerRequestId, stage, detail }) => {
      uiEvents.push(`${displayRequestId}:${providerRequestId ?? ""}:${stage}:${detail ?? ""}`);
    },
  );

  expect(uiEvents).toEqual([`${logicalRequestId}:provider_visible:failed:HTTP 502`]);
  expect(registry.listActive(threadId)).toHaveLength(0);
  expect(markBridgeRequestStartedPersisted(threadId, logicalRequestId)).toBe(true);
});

test("applyLogicalRequestTerminal finalizes when emitUi throws", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_ui_throw";
  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });

  expect(() =>
    applyLogicalRequestTerminal(
      registry,
      { threadId, eventRole: "coder", logicalRequestId, stage: "completed" },
      () => {
        throw new Error("ui failed");
      },
    ),
  ).toThrow("ui failed");
  expect(registry.listActive(threadId)).toHaveLength(0);
});

test("concurrent logical requests with same provider request id keep distinct registry identity", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_shared_provider";
  const sharedProviderId = "provider_shared";

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

  recordProviderRequestIdForLogical(registry, threadId, first.logicalRequestId, sharedProviderId);
  recordProviderRequestIdForLogical(registry, threadId, second.logicalRequestId, sharedProviderId);

  expect(first.logicalRequestId).not.toBe(second.logicalRequestId);
  expect(registry.listActive(threadId)).toHaveLength(2);
  expect(registry.findEntryByLogicalId(threadId, first.logicalRequestId)?.providerRequestId).toBe(
    sharedProviderId,
  );
  expect(registry.findEntryByLogicalId(threadId, second.logicalRequestId)?.providerRequestId).toBe(
    sharedProviderId,
  );

  applyLogicalRequestTerminal(registry, {
    threadId,
    eventRole: "coder",
    logicalRequestId: first.logicalRequestId,
    stage: "completed",
  });
  expect(registry.listActive(threadId)).toHaveLength(1);
  expect(registry.listActive(threadId)[0]?.logicalRequestId).toBe(second.logicalRequestId);

  applyLogicalRequestTerminal(registry, {
    threadId,
    eventRole: "coder",
    logicalRequestId: second.logicalRequestId,
    stage: "failed",
    detail: "HTTP 503",
  });
  expect(registry.listActive(threadId)).toHaveLength(0);
});

test("gateway attempt connection diagnostic skips SDK shadow terminal side effects", () => {
  expect(
    shouldEmitSdkShadowRequestTerminal({
      eventType: "api.error",
      activityOrigin: GATEWAY_ATTEMPT_CONNECTION_ERROR_ORIGIN,
    }),
  ).toBe(false);
  expect(
    shouldEmitSdkShadowRequestTerminal({
      eventType: "api.error",
      activityOrigin: "sdk.error",
    }),
  ).toBe(true);
  expect(
    shouldEmitSdkShadowRequestTerminal({
      eventType: "message.final",
    }),
  ).toBe(true);
  expect(
    shouldEmitSdkShadowRequestTerminal({
      eventType: "thinking.final",
    }),
  ).toBe(false);
});

test("upstream.failed diagnostic leaves registry active until logical terminal helper runs", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_upstream_diag";
  clearRequestStartedPersisted(threadId);

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
  markBridgeRequestStartedPersisted(threadId, first.logicalRequestId);
  markBridgeRequestStartedPersisted(threadId, second.logicalRequestId);

  expect(
    shouldEmitSdkShadowRequestTerminal({
      eventType: "api.error",
      activityOrigin: GATEWAY_ATTEMPT_CONNECTION_ERROR_ORIGIN,
    }),
  ).toBe(false);

  expect(registry.listActive(threadId)).toHaveLength(2);

  applyLogicalRequestTerminal(registry, {
    threadId,
    eventRole: "coder",
    logicalRequestId: first.logicalRequestId,
    stage: "failed",
    detail: "HTTP 503",
  });

  expect(registry.listActive(threadId)).toHaveLength(1);
  expect(registry.listActive(threadId)[0]?.logicalRequestId).toBe(second.logicalRequestId);
  expect(markRequestStartedPersisted(threadId, first.logicalRequestId)).toBe(true);
  expect(markRequestStartedPersisted(threadId, second.logicalRequestId)).toBe(false);

  finalizeLiveRequest(registry, threadId, second.logicalRequestId);
  expect(registry.listActive(threadId)).toHaveLength(0);
});

test("shouldEmitUpstreamConnectionErrorActivity fail closed for unknown or silent logical entries", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_silent_diag";
  const silent = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: false,
  });
  const visible = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "main",
    emitTimelineActivity: true,
  });

  expect(shouldEmitUpstreamConnectionErrorActivity(registry, threadId, silent.logicalRequestId)).toBe(false);
  expect(shouldEmitUpstreamConnectionErrorActivity(registry, threadId, visible.logicalRequestId)).toBe(true);
  expect(shouldEmitUpstreamConnectionErrorActivity(registry, threadId, "req_unknown_stale")).toBe(false);
});

test("lifecycle connection error uses logicalRequestId not statusCode", () => {
  const registry = new ThreadLiveRequestRegistry();
  const threadId = "thr_conn_args";
  const { logicalRequestId } = handleBridgeMessagesRequest(registry, {
    threadId,
    role: "coder",
    emitTimelineActivity: true,
  });

  const handlerInput = {
    threadId,
    eventRole: "coder",
    error: "upstream unavailable",
    statusCode: 503,
    logicalRequestId,
  };

  expect(resolveConnectionErrorLogicalRequestId(handlerInput)).toBe(logicalRequestId);
  expect(resolveConnectionErrorLogicalRequestId(handlerInput)).not.toBe("503");
  expect(shouldEmitUpstreamConnectionErrorFromLifecycle(registry, handlerInput)).toBe(true);
  expect(
    shouldEmitUpstreamConnectionErrorFromLifecycle(registry, {
      threadId,
      logicalRequestId: String(handlerInput.statusCode),
      statusCode: handlerInput.statusCode,
    }),
  ).toBe(false);
});
