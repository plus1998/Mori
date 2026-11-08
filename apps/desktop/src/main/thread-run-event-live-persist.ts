import type {
  ThreadActivityLine,
  ThreadApiErrorInfo,
  ThreadRunBashApprovalMetadata,
  ThreadRunToolMetadata,
} from "../shared/ipc";
import type { ThreadRunEvent } from "../shared/thread-run-events";
import { activityStreamKey } from "./activity-agent-id";
import type { AgentLifecycleService } from "./agent-lifecycle-service";
import type { ConversationStore } from "./conversation-store";
import type { SubagentMetricsRegistry } from "./subagent-metrics-registry";
import {
  markBridgeRequestStartedPersisted,
  resolveLiveRequestIdForEvent,
  shouldEmitRetryScheduledCancellation,
  shouldEmitSdkShadowRequestTerminal,
  shouldPersistRequestStartedShadowEvent,
} from "./thread-live-request-coordinator";
import type { ThreadLiveRequestRegistry } from "./thread-live-request-registry";
import {
  buildThreadRunEventFromLiveEvent,
  isMetricsOnlyThreadLiveEvent,
  isThreadStatusLiveTypeOmittedFromFeed,
} from "./thread-run-event-normalizer";

export interface ThreadRunEventLivePersistExtras {
  agentId?: string;
  bashApproval?: {
    agentId?: string;
    toolUseId: string;
    command: string;
    filesystemPath?: string;
    filesystemTool?: string;
    description?: string;
  };
  apiError?: ThreadApiErrorInfo;
  tool?: ThreadRunToolMetadata;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

export interface ThreadRunEventLivePersistInput {
  threadId: string;
  type: string;
  displayMessage: string;
  role: string;
  stream: boolean;
  observedAt?: string;
  extras?: ThreadRunEventLivePersistExtras;
  persistedActivityLine?: ThreadActivityLine;
}

export interface ThreadRunEventLivePersistDeps {
  store: ConversationStore;
  lifecycle: AgentLifecycleService;
  metricsRegistry: SubagentMetricsRegistry;
  liveRequestRegistry: ThreadLiveRequestRegistry;
  resolveCurrentRunAttemptId(threadId: string): string | undefined;
  resolveAgentIdByParentToolUseId(threadId: string, parentToolUseId: string): string | undefined;
  buildBashApprovalMetadata?(
    liveType: string,
    request: NonNullable<ThreadRunEventLivePersistExtras["bashApproval"]>,
  ): ThreadRunBashApprovalMetadata | undefined;
  emitRequestTerminalEvent(
    threadId: string,
    input: {
      requestId: string;
      role: string;
      agentId?: string;
      stage: "completed" | "failed" | "cancelled";
      detail?: string;
    },
  ): void;
  onProjectionUpdated(threadId: string, options?: { streaming?: boolean }): void;
  onFileChange?(threadId: string): void;
  persistConversationEvent?(event: ThreadRunEvent): void;
  createEventId?(input: { persistedActivityLine?: ThreadActivityLine }): string;
  now?(): string;
}

export function createThreadRunEventLivePersister(deps: ThreadRunEventLivePersistDeps) {
  const now = deps.now ?? (() => new Date().toISOString());

  const createEventId = (input: { persistedActivityLine?: ThreadActivityLine }): string => {
    if (deps.createEventId) {
      return deps.createEventId(input);
    }
    const liveEventId = `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return input.persistedActivityLine ? `${input.persistedActivityLine.id}:${liveEventId}` : liveEventId;
  };

  function persistFromLiveEvent(input: ThreadRunEventLivePersistInput): void {
    if (isMetricsOnlyThreadLiveEvent(input.type)) {
      return;
    }
    if (
      input.type === "request.started" &&
      !shouldPersistRequestStartedShadowEvent({
        eventType: input.type,
        ...(input.extras?.requestId?.trim() ? { bridgeLogicalRequestId: input.extras.requestId.trim() } : {}),
      })
    ) {
      return;
    }

    // Existence is all this path needs. Avoid loading/decoding the complete
    // thread summary for every streamed delta, and skip SQL for omitted events.
    if (!deps.store.hasThread(input.threadId)) {
      return;
    }

    const eventId = createEventId({
      ...(input.persistedActivityLine && { persistedActivityLine: input.persistedActivityLine }),
    });
    const runAttemptId = deps.resolveCurrentRunAttemptId(input.threadId);
    const bashApproval =
      input.extras?.bashApproval && deps.buildBashApprovalMetadata
        ? deps.buildBashApprovalMetadata(input.type, input.extras.bashApproval)
        : undefined;
    const parentToolUseId = readLiveEventParentToolUseId(input.extras);
    let agentId = input.extras?.agentId?.trim() || input.extras?.bashApproval?.agentId?.trim();
    if (!agentId && parentToolUseId) {
      agentId = deps.resolveAgentIdByParentToolUseId(input.threadId, parentToolUseId);
    }
    const requestId =
      input.extras?.requestId?.trim() ||
      resolveLiveRequestIdForEvent(deps.liveRequestRegistry, input.threadId, {
        type: input.type,
        role: input.role,
        stream: input.stream,
        ...(agentId && { agentId }),
      });
    const streamKey = resolveLiveEventStreamKey({
      threadId: input.threadId,
      type: input.type,
      role: input.role,
      stream: input.stream,
      ...(agentId && { agentId }),
      ...(parentToolUseId && { parentToolUseId }),
      ...(runAttemptId && { runAttemptId }),
      ...(input.persistedActivityLine && { persistedActivityLine: input.persistedActivityLine }),
      ...(input.extras && { extras: input.extras }),
    });
    const event = buildThreadRunEventFromLiveEvent({
      threadId: input.threadId,
      eventId,
      liveType: input.type,
      message: input.displayMessage,
      role: input.role,
      stream: input.stream,
      observedAt: input.observedAt ?? now(),
      ...(runAttemptId && { runAttemptId }),
      ...(agentId && { agentId }),
      ...(parentToolUseId && { parentToolUseId }),
      ...(requestId && { requestId }),
      ...(streamKey && { streamKey }),
      ...(input.extras?.apiError && { apiError: input.extras.apiError }),
      ...(input.extras?.tool && { tool: input.extras.tool }),
      ...(input.extras?.metadata && { metadata: input.extras.metadata }),
      ...(bashApproval && { bashApproval }),
    });
    if (!event) {
      // thread.completed/started are omitted from the run timeline on purpose, but
      // finishRunAttempt may have just marked attempts terminal with no run.attempt.*
      // event — still push a hydrated feed projection so Mobile leaves "Processing".
      if (isThreadStatusLiveTypeOmittedFromFeed(input.type)) {
        deps.onProjectionUpdated(input.threadId, { streaming: false });
      }
      return;
    }
    if (event.eventType === "request.started") {
      const bridgeLogicalRequestId = input.extras?.requestId?.trim();
      if (!bridgeLogicalRequestId) {
        return;
      }
      if (!markBridgeRequestStartedPersisted(input.threadId, bridgeLogicalRequestId)) {
        return;
      }
    }
    if (event.eventType === "request.retry_scheduled") {
      const retryRequestId = event.requestId?.trim();
      if (!retryRequestId) {
        return;
      }
      if (!shouldEmitRetryScheduledCancellation(deps.liveRequestRegistry, input.threadId, retryRequestId)) {
        return;
      }
      deps.emitRequestTerminalEvent(input.threadId, {
        requestId: retryRequestId,
        role: input.role,
        ...(agentId && { agentId }),
        stage: "cancelled",
      });
    }

    const persisted = deps.store.appendConversationRuntimeEvent(event);
    deps.persistConversationEvent?.(persisted);
    if (
      shouldEmitSdkShadowRequestTerminal({
        eventType: event.eventType,
        ...(typeof input.extras?.metadata?.activityOrigin === "string"
          ? { activityOrigin: input.extras.metadata.activityOrigin }
          : {}),
      }) &&
      event.requestId
    ) {
      const detail = event.eventType === "api.error" ? event.message.trim() : undefined;
      deps.emitRequestTerminalEvent(input.threadId, {
        requestId: event.requestId,
        role: input.role,
        ...(agentId && { agentId }),
        stage: event.eventType === "api.error" ? "failed" : "completed",
        ...(detail && { detail }),
      });
    }
    const projectionStreaming = input.stream ? true : input.type === "message.delta" ? false : undefined;
    deps.onProjectionUpdated(
      input.threadId,
      ...(projectionStreaming !== undefined ? [{ streaming: projectionStreaming }] : []),
    );
    if (input.extras?.tool?.fileChange) {
      deps.onFileChange?.(input.threadId);
    }
  }

  return { persistFromLiveEvent };
}

function readLiveEventParentToolUseId(extras?: ThreadRunEventLivePersistExtras): string | undefined {
  const fromMetadata = extras?.metadata?.parent_tool_use_id ?? extras?.metadata?.parentToolUseId;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) {
    return fromMetadata.trim();
  }
  return undefined;
}

function readLiveEventSdkStreamBlockKey(extras?: ThreadRunEventLivePersistExtras): string | undefined {
  const fromMetadata = extras?.metadata?.sdkStreamBlockKey ?? extras?.metadata?.stream_block_key;
  if (typeof fromMetadata === "string" && fromMetadata.trim()) {
    return fromMetadata.trim();
  }
  return undefined;
}

function resolveLiveEventStreamKey(input: {
  threadId: string;
  type: string;
  role: string;
  stream: boolean;
  agentId?: string;
  parentToolUseId?: string;
  runAttemptId?: string;
  persistedActivityLine?: ThreadActivityLine;
  extras?: ThreadRunEventLivePersistExtras;
}): string | undefined {
  if (input.persistedActivityLine) {
    return input.persistedActivityLine.id;
  }
  if (input.type === "thread.user_prompt") {
    const rewindTarget = input.extras?.metadata?.rewindTarget;
    if (rewindTarget && typeof rewindTarget === "object" && !Array.isArray(rewindTarget)) {
      const activityLineId = (rewindTarget as { activityLineId?: unknown }).activityLineId;
      if (typeof activityLineId === "string" && activityLineId.trim()) {
        return activityLineId.trim();
      }
    }
  }
  const toolUseId = input.extras?.tool?.toolUseId?.trim();
  if (toolUseId) {
    return `tool:${toolUseId}`;
  }
  if (input.stream || input.type === "message.delta" || input.type === "thinking.delta") {
    return activityStreamKey(
      input.threadId,
      input.agentId,
      input.role,
      input.parentToolUseId,
      readLiveEventSdkStreamBlockKey(input.extras),
      input.runAttemptId,
    );
  }
  return undefined;
}
