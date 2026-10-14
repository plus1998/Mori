import {
  type AgentEvent,
  formatContextLimit,
  normalizeSdkSubagentType,
  type RuntimeAgentRole,
  SDK_GENERAL_PURPOSE_AGENT_KEY,
  SDK_PLAN_AGENT_KEY,
} from "@eco/runtime";
import { repairActivityText } from "../shared/activity-text";
import type { AgentRole } from "../shared/ipc";
import type { ThreadRunEventInput } from "../shared/thread-run-events";
import { resolveActivityAgentId, shouldOmitAcpRootActivityAgentId } from "./activity-agent-id";
import type { AgentLifecycleService } from "./agent-lifecycle-service";
import type { ContextLifecycleService } from "./context-lifecycle-service";
import type { ConversationStore } from "./conversation-store";
import { hasStructuredThreadEventExtras, resolveEmitThreadEventMessage } from "./emit-thread-event-message";
import { reconcileSdkAgentTerminalEvent } from "./sdk-agent-terminal-reconciliation";
import { isSdkToolInputPlaceholder, SdkStreamActivityBridge } from "./sdk-stream-activity";
import { getThreadSubagentLaunchRegistry } from "./subagent-launch-registry-store";
import type { SubagentMetricsRegistry } from "./subagent-metrics-registry";
import {
  applyExactLogicalRequestLateBind,
  resolveLiveRequestIdForEvent,
  resolveSdkLateBindAttribution,
} from "./thread-live-request-coordinator";
import type { ThreadLiveRequestRegistry } from "./thread-live-request-registry";
import {
  createThreadRunEventLivePersister,
  type ThreadRunEventLivePersistExtras,
} from "./thread-run-event-live-persist";
import {
  buildSubagentLifecycleRunEvent,
  buildSubagentMissionAttributedRunEvent,
} from "./thread-run-event-normalizer";
import type { UsageLedgerCoordinator } from "./usage-ledger-coordinator";

type AgentEventLike = Pick<AgentEvent, "id" | "type" | "payload" | "role" | "agentId" | "timestamp">;

export type SubagentDelegationLinker = (input: {
  agentId: string;
  agentType: string;
  parentToolUseId: string;
  prompt?: string;
  todoId?: string;
}) => void;

export interface SdkStreamActivityIngestionDeps {
  store: ConversationStore;
  lifecycle: AgentLifecycleService;
  metricsRegistry: SubagentMetricsRegistry;
  usageLedger: Pick<UsageLedgerCoordinator, "settleProxyPendingForSubagentStart">;
  contextLifecycle: Pick<ContextLifecycleService, "handleSdkContextEvent">;
  liveRequestRegistry: ThreadLiveRequestRegistry;
  bridge?: SdkStreamActivityBridge;
  logDiagnostic?: (topic: string, fields: Record<string, unknown>) => void;
  emitRequestTerminalEvent: ThreadRunEventLivePersistDeps["emitRequestTerminalEvent"];
  onProjectionUpdated: (threadId: string, options?: { streaming?: boolean }) => void;
  onSubagentTimingUpdated?: (threadId: string) => void;
  onContextCompactionStatus?: (
    threadId: string,
    input: {
      stage: "started" | "completed" | "failed";
      trigger: "auto";
      preTokens?: number;
      postTokens?: number;
      detail?: string;
    },
  ) => void;
  onBrowserToolStarted?: (input: { threadId: string; payload: Record<string, unknown> }) => void;
  buildBashApprovalMetadata?: ThreadRunEventLivePersistDeps["buildBashApprovalMetadata"];
  createEventId?: ThreadRunEventLivePersistDeps["createEventId"];
  now?: () => string;
  /** Live main process: full emitThreadEvent (persist + renderer IPC). Replay omits this and uses persistThreadEvent only. */
  emitBridgeThreadEvent?: (
    threadId: string,
    type: string,
    message: string,
    role: RuntimeAgentRole | "system" | "thinking" | "tool" | "user",
    stream: boolean,
    extras?: ThreadRunEventLivePersistExtras,
  ) => void;
}

function appendRuntimeEvent(store: ConversationStore, event: ThreadRunEventInput): void {
  store.appendConversationRuntimeEvent(event);
}

type ThreadRunEventLivePersistDeps = Parameters<typeof createThreadRunEventLivePersister>[0];

export interface SdkStreamActivityIngestion {
  ingest(threadId: string, event: AgentEventLike, options?: { observedAt?: string }): void;
  flush(threadId: string, options?: { observedAt?: string }): void;
  registerDelegationLinker(threadId: string, linker: SubagentDelegationLinker): void;
  clearDelegationLinker(threadId: string): void;
  persistThreadEvent(
    threadId: string,
    type: string,
    message: string,
    role: RuntimeAgentRole | "system" | "thinking" | "tool" | "user",
    stream: boolean,
    extras?: ThreadRunEventLivePersistExtras,
    options?: { observedAt?: string },
  ): void;
}

export function createSdkStreamActivityIngestion(
  deps: SdkStreamActivityIngestionDeps,
): SdkStreamActivityIngestion {
  const bridge = deps.bridge ?? new SdkStreamActivityBridge();
  const logDiagnostic = deps.logDiagnostic ?? (() => {});
  const delegationLinkers = new Map<string, SubagentDelegationLinker>();
  const now = deps.now ?? (() => new Date().toISOString());

  const persister = createThreadRunEventLivePersister({
    store: deps.store,
    lifecycle: deps.lifecycle,
    metricsRegistry: deps.metricsRegistry,
    liveRequestRegistry: deps.liveRequestRegistry,
    resolveCurrentRunAttemptId: (threadId) => {
      try {
        return deps.lifecycle.currentRunAttemptId(threadId) ?? deps.lifecycle.usageRunAttemptId(threadId);
      } catch {
        return undefined;
      }
    },
    resolveAgentIdByParentToolUseId: (threadId, parentToolUseId) => {
      const linked = deps.metricsRegistry.resolveAgentIdByParentToolUse(threadId, parentToolUseId);
      if (linked) {
        return linked;
      }
      const agent = deps.store
        .listAgentInstances(threadId)
        .find((row) => row.parentToolUseId?.trim() === parentToolUseId.trim());
      return agent?.agentId;
    },
    emitRequestTerminalEvent: deps.emitRequestTerminalEvent,
    onProjectionUpdated: deps.onProjectionUpdated,
    ...(deps.buildBashApprovalMetadata && { buildBashApprovalMetadata: deps.buildBashApprovalMetadata }),
    ...(deps.createEventId && { createEventId: deps.createEventId }),
    now,
  });

  const persistThreadEvent: SdkStreamActivityIngestion["persistThreadEvent"] = (
    threadId,
    type,
    message,
    role,
    stream,
    extras,
    options,
  ) => {
    const { text: normalizedMessage } = repairActivityText(message);
    const trimmed = normalizedMessage.trim();
    // The same rule the live `emitThreadEvent` uses, so a replayed run records the rows the live
    // run would have: the target of a Codex write reaches the Feed through an event that has
    // nothing but metadata to say.
    const messageDecision = resolveEmitThreadEventMessage({
      type,
      message: trimmed,
      stream,
      hasStructuredExtras: hasStructuredThreadEventExtras(extras),
      hasPlan: Boolean(extras?.metadata?.plan),
    });
    if (messageDecision.drop) {
      return;
    }
    const displayMessage = messageDecision.persistedMessage;
    persister.persistFromLiveEvent({
      threadId,
      type,
      displayMessage,
      role: String(role),
      stream,
      ...(options?.observedAt && { observedAt: options.observedAt }),
      ...(extras && { extras }),
    });
  };

  function tryResolveStreamSubagentDelegation(threadId: string, parentToolUseId: string): void {
    const linked =
      getThreadSubagentLaunchRegistry(threadId).resolveFromStreamParentToolUseId(parentToolUseId);
    if (!linked) {
      return;
    }
    delegationLinkers.get(threadId)?.({
      agentId: linked.agentId,
      agentType: linked.launch.role,
      parentToolUseId: linked.launch.parentToolUseId,
      prompt: linked.launch.prompt,
      ...(linked.launch.todoIdHint && { todoId: linked.launch.todoIdHint }),
    });
  }

  function maybeHandleAcpNestedSubagentLifecycle(
    threadId: string,
    event: AgentEventLike,
    observedAt: string,
  ): boolean {
    if (event.type !== "agent.started" && event.type !== "agent.completed") {
      return false;
    }
    if (!isRecord(event.payload) || event.payload.source !== "acp") {
      return false;
    }
    const agentId = event.agentId?.trim();
    const parentToolUseId =
      typeof event.payload.parentToolUseId === "string"
        ? event.payload.parentToolUseId.trim()
        : typeof event.payload.parent_tool_use_id === "string"
          ? event.payload.parent_tool_use_id.trim()
          : "";
    if (!agentId || !parentToolUseId) {
      return false;
    }
    const rawRole =
      typeof event.payload.subagent_type === "string"
        ? event.payload.subagent_type
        : typeof event.role === "string"
          ? event.role
          : "";
    const role =
      normalizeSdkSubagentType(rawRole) ??
      (rawRole === SDK_GENERAL_PURPOSE_AGENT_KEY || rawRole === SDK_PLAN_AGENT_KEY
        ? rawRole
        : SDK_GENERAL_PURPOSE_AGENT_KEY);
    const prompt =
      typeof event.payload.prompt === "string"
        ? event.payload.prompt.trim()
        : typeof event.payload.task === "string"
          ? event.payload.task.trim()
          : "";
    const runAttemptId = deps.lifecycle.usageRunAttemptId(threadId);
    const parentAgentId = deps.lifecycle.currentPlannerAgentId(threadId);

    if (event.type === "agent.started") {
      const existing = deps.store.listAgentInstances(threadId).find((row) => row.agentId === agentId);
      if (existing) {
        return true;
      }
      const lifecycleRecord = deps.lifecycle.startSubagent({
        threadId,
        agentId,
        role,
        parentToolUseId,
        ...(prompt && { missionKey: prompt.slice(0, 120) }),
      });
      deps.store.upsertSubagentSessionActive({
        threadId,
        role,
        agentId,
        phase: "execution",
        ...(prompt && { missionKey: prompt.slice(0, 120) }),
      });
      deps.metricsRegistry.onSubagentStart(threadId, {
        agentId,
        role,
        parentToolUseId,
      });
      appendRuntimeEvent(
        deps.store,
        buildSubagentLifecycleRunEvent({
          threadId,
          agentId,
          role,
          lifecycle: "started",
          observedAt,
          parentToolUseId,
          ...(runAttemptId && { runAttemptId }),
          ...(parentAgentId && { parentAgentId }),
          ...(lifecycleRecord?.runAttemptId && { runAttemptId: lifecycleRecord.runAttemptId }),
          ...(prompt && { delegationPrompt: prompt }),
        }),
      );
      if (prompt) {
        appendRuntimeEvent(
          deps.store,
          buildSubagentMissionAttributedRunEvent({
            threadId,
            agentId,
            role,
            prompt,
            observedAt,
            parentToolUseId,
            ...(runAttemptId && { runAttemptId }),
          }),
        );
      }
      deps.onProjectionUpdated(threadId, { streaming: true });
      deps.onSubagentTimingUpdated?.(threadId);
      return true;
    }

    const failed =
      event.payload.failed === true || event.payload.status === "failed" || event.payload.status === "error";
    if (failed) {
      deps.lifecycle.abandonSubagent({ threadId, agentId, role });
    } else {
      deps.lifecycle.stopSubagent({ threadId, agentId, role });
    }
    deps.metricsRegistry.onSubagentStop(threadId, { agentId, role });
    deps.store.markSubagentSessionStopped(threadId, agentId);
    appendRuntimeEvent(
      deps.store,
      buildSubagentLifecycleRunEvent({
        threadId,
        agentId,
        role,
        lifecycle: failed ? "abandoned" : "stopped",
        observedAt,
        parentToolUseId,
        ...(runAttemptId && { runAttemptId }),
        ...(parentAgentId && { parentAgentId }),
        ...(prompt && { delegationPrompt: prompt }),
      }),
    );
    deps.onProjectionUpdated(threadId, { streaming: false });
    deps.onSubagentTimingUpdated?.(threadId);
    return true;
  }

  function resolveSubagentInstanceByParentToolUseId(threadId: string, parentToolUseId: string) {
    const agentId =
      deps.metricsRegistry.resolveAgentIdByParentToolUse(threadId, parentToolUseId) ??
      deps.store
        .listAgentInstances(threadId)
        .find((row) => row.parentToolUseId?.trim() === parentToolUseId.trim())?.agentId;
    if (!agentId) {
      return undefined;
    }
    return deps.store.listAgentInstances(threadId).find((row) => row.agentId === agentId);
  }

  function settleSdkSubagentLifecycle(
    threadId: string,
    input: {
      agentId: string;
      role: RuntimeAgentRole;
      failed: boolean;
      observedAt: string;
      parentToolUseId?: string;
    },
  ): boolean {
    const existing = deps.store.listAgentInstances(threadId).find((row) => row.agentId === input.agentId);
    const role = ((existing?.role as RuntimeAgentRole) || input.role) as RuntimeAgentRole;
    const parentToolUseId = input.parentToolUseId ?? existing?.parentToolUseId;
    const runAttemptId = deps.lifecycle.usageRunAttemptId(threadId);
    const parentAgentId = deps.lifecycle.currentPlannerAgentId(threadId);
    const alreadyAbandoned = existing?.status === "abandoned";
    if (alreadyAbandoned) {
      return false;
    }
    if (input.failed) {
      deps.lifecycle.abandonSubagent({ threadId, agentId: input.agentId, role });
    } else if (existing) {
      deps.lifecycle.stopSubagent({ threadId, agentId: input.agentId, role });
    } else {
      return false;
    }
    deps.metricsRegistry.onSubagentStop(threadId, { agentId: input.agentId, role });
    deps.store.markSubagentSessionStopped(threadId, input.agentId);
    appendRuntimeEvent(
      deps.store,
      buildSubagentLifecycleRunEvent({
        threadId,
        agentId: input.agentId,
        role,
        lifecycle: input.failed ? "abandoned" : "stopped",
        observedAt: input.observedAt,
        ...(parentToolUseId && { parentToolUseId }),
        ...(runAttemptId && { runAttemptId }),
        ...(parentAgentId && { parentAgentId }),
      }),
    );
    deps.onProjectionUpdated(threadId, { streaming: false });
    deps.onSubagentTimingUpdated?.(threadId);
    return true;
  }

  function maybeHandleSdkAgentOutputLifecycle(
    threadId: string,
    event: AgentEventLike,
    observedAt: string,
  ): boolean {
    if (
      event.type !== "agent.completed" ||
      !isRecord(event.payload) ||
      event.payload.type !== "agent_output"
    ) {
      return false;
    }
    const failed =
      event.payload.failed === true || event.payload.status === "failed" || event.payload.status === "error";
    if (!failed) {
      return false;
    }
    const parentToolUseId =
      typeof event.payload.tool_use_id === "string" ? event.payload.tool_use_id.trim() : undefined;
    const outputAgentId =
      (typeof event.payload.agentId === "string" && event.payload.agentId.trim()) ||
      event.agentId?.trim() ||
      "";
    const linked = parentToolUseId
      ? resolveSubagentInstanceByParentToolUseId(threadId, parentToolUseId)
      : undefined;
    const existing =
      (outputAgentId
        ? deps.store.listAgentInstances(threadId).find((row) => row.agentId === outputAgentId)
        : undefined) ?? linked;
    const agentId = existing?.agentId || outputAgentId;
    if (!agentId) {
      return false;
    }
    const rawRole =
      typeof event.payload.agentType === "string"
        ? event.payload.agentType
        : typeof event.payload.subagent_type === "string"
          ? event.payload.subagent_type
          : typeof event.role === "string"
            ? event.role
            : (existing?.role ?? "");
    const role =
      normalizeSdkSubagentType(rawRole) ??
      (rawRole === SDK_GENERAL_PURPOSE_AGENT_KEY || rawRole === SDK_PLAN_AGENT_KEY
        ? rawRole
        : SDK_GENERAL_PURPOSE_AGENT_KEY);
    return settleSdkSubagentLifecycle(threadId, {
      agentId,
      role,
      failed: true,
      observedAt,
      ...(parentToolUseId && { parentToolUseId }),
    });
  }

  function maybeAbandonSdkSubagentFromFailedAgentTool(
    threadId: string,
    event: AgentEventLike,
    observedAt: string,
    toolUseId: string,
  ): boolean {
    const existing = resolveSubagentInstanceByParentToolUseId(threadId, toolUseId);
    if (!existing) {
      return false;
    }
    const message =
      isRecord(event.payload) && typeof event.payload.message === "string" ? event.payload.message : "";
    const looksFatal = /terminated early due to an API error|API Error:\s*\d{3}/i.test(message);
    if (!looksFatal) {
      return false;
    }
    return settleSdkSubagentLifecycle(threadId, {
      agentId: existing.agentId,
      role: existing.role as RuntimeAgentRole,
      failed: true,
      observedAt,
      parentToolUseId: toolUseId,
    });
  }

  function ingest(threadId: string, event: AgentEventLike, options?: { observedAt?: string }): void {
    const observedAt = options?.observedAt ?? readEventObservedAt(event, now());

    reconcileSdkAgentTerminalEvent(threadId, event, {
      resolveParentToolUseAgentId: (parentToolUseId) => {
        const linked = deps.metricsRegistry.resolveAgentIdByParentToolUse(threadId, parentToolUseId);
        if (linked) {
          return linked;
        }
        return deps.store
          .listAgentInstances(threadId)
          .find((row) => row.parentToolUseId?.trim() === parentToolUseId.trim())?.agentId;
      },
      linkParentToolUse: (parentToolUseId, agentId) => {
        deps.metricsRegistry.linkToolUseToAgent(threadId, parentToolUseId, agentId);
        deps.lifecycle.linkSubagentParentToolUse({ threadId, agentId, parentToolUseId });
      },
      settlePendingByParent: ({ agentId, role, parentToolUseId }) =>
        deps.usageLedger.settleProxyPendingForSubagentStart(threadId, {
          agentId,
          role,
          parentToolUseId,
        }),
      logDiagnostic,
    });

    if (
      (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") &&
      isRecord(event.payload) &&
      // A call whose arguments are still being written is announced by the bridge as
      // `tool.writing`; it is not a call yet, so nothing may register it as one.
      !(event.type === "tool.started" && isSdkToolInputPlaceholder(event.payload))
    ) {
      if (event.type === "tool.started") {
        deps.onBrowserToolStarted?.({ threadId, payload: event.payload });
      }
      const toolName = typeof event.payload.tool_name === "string" ? event.payload.tool_name.trim() : "";
      const toolUseId = typeof event.payload.tool_use_id === "string" ? event.payload.tool_use_id : undefined;
      if (toolUseId && (toolName === "Task" || toolName === "Agent")) {
        if (event.type === "tool.started") {
          const rawRole =
            typeof event.payload.subagent_type === "string"
              ? event.payload.subagent_type
              : typeof event.payload.agent_type === "string"
                ? event.payload.agent_type
                : "";
          const role =
            normalizeSdkSubagentType(rawRole) ??
            (rawRole === SDK_GENERAL_PURPOSE_AGENT_KEY || rawRole === SDK_PLAN_AGENT_KEY
              ? rawRole
              : SDK_GENERAL_PURPOSE_AGENT_KEY);
          deps.metricsRegistry.noteTaskToolUse(threadId, toolUseId, role);
          deps.lifecycle.noteTaskToolUse(threadId, toolUseId, role);
        }
        tryResolveStreamSubagentDelegation(threadId, toolUseId);
        if (event.type === "tool.failed") {
          maybeAbandonSdkSubagentFromFailedAgentTool(threadId, event, observedAt, toolUseId);
        }
      }
    }

    maybeHandleAcpNestedSubagentLifecycle(threadId, event, observedAt);
    maybeHandleSdkAgentOutputLifecycle(threadId, event, observedAt);
    deps.contextLifecycle.handleSdkContextEvent({
      threadId,
      eventId: event.id ?? `sdk_event:${event.type}`,
      payload: event.payload,
    });

    if (isPiCompactionEvent(event)) {
      deps.onContextCompactionStatus?.(threadId, piCompactionStatusInput(event));
      return;
    }
    if (isSdkCompactionStatusEvent(event)) {
      deps.onContextCompactionStatus?.(threadId, { stage: "started", trigger: "auto" });
      return;
    }
    if (isSdkCompactionBoundaryEvent(event)) {
      return;
    }

    const sdkParentToolUseId = readSdkEventParentToolUseId(event);
    if (sdkParentToolUseId) {
      tryResolveStreamSubagentDelegation(threadId, sdkParentToolUseId);
    }

    const plannerSessionId =
      deps.store.getSdkSession(threadId)?.sessionId?.trim() ||
      deps.store.getThreadCoreSession(threadId)?.externalSessionId?.trim();
    const coreKind = deps.store.getThread(threadId)?.coreKind;
    const streamAttributedAgentId = readStreamAttributedAgentId(event.agentId, plannerSessionId);
    const resolvedActivityAgentId =
      resolveActivityAgentId(threadId, event, {
        ...(plannerSessionId && { plannerSessionId }),
        metricsRegistry: deps.metricsRegistry,
        ...(coreKind && { coreKind }),
      }) ?? streamAttributedAgentId;
    // ACP root turns stamp a per-run UUID that never becomes an Eco agent Card —
    // drop it so thread-run events stay `scope: main` and the Feed skeleton tracks them.
    // (`resolveActivityAgentId` already omits, but `?? streamAttributedAgentId` would reintroduce it.)
    const activityAgentId = shouldOmitAcpRootActivityAgentId({
      coreKind: coreKind ?? null,
      eventAgentId: event.agentId ?? null,
      parentToolUseId: sdkParentToolUseId ?? null,
    })
      ? undefined
      : resolvedActivityAgentId;

    const logicalRequestId = readSdkEventLogicalRequestId(event);
    if (logicalRequestId) {
      const attribution = resolveSdkLateBindAttribution(
        threadId,
        {
          type: event.type,
          role: String(event.role),
          ...(event.agentId ? { agentId: event.agentId } : {}),
          payload: event.payload,
        },
        {
          ...(plannerSessionId ? { plannerSessionId } : {}),
          metricsRegistry: deps.metricsRegistry,
        },
      );
      if (attribution) {
        const lateBind = applyExactLogicalRequestLateBind(deps.liveRequestRegistry, deps.store, {
          threadId,
          logicalRequestId,
          agentId: attribution.agentId,
          role: attribution.role,
        });
        if (lateBind.ok && lateBind.emitTimelineActivity && lateBind.updated > 0) {
          deps.onProjectionUpdated(threadId);
        }
      }
    }

    const runAttemptId =
      deps.lifecycle.currentRunAttemptId(threadId) ?? deps.lifecycle.usageRunAttemptId(threadId);

    bridge.handleEvent(
      threadId,
      event,
      (id, type, message, role, stream, agentId, extras) => {
        const mergedMetadata = {
          ...(extras?.metadata ?? {}),
          ...(sdkParentToolUseId && { parent_tool_use_id: sdkParentToolUseId }),
        };
        const hasMetadata = Object.keys(mergedMetadata).length > 0;
        const liveRequestId = resolveLiveRequestIdForEvent(deps.liveRequestRegistry, id, {
          type,
          role: String(role),
          stream,
          ...(agentId && { agentId }),
        });
        const bridgeExtras =
          agentId || extras || sdkParentToolUseId || liveRequestId
            ? {
                ...(agentId && { agentId }),
                ...(extras?.tool && { tool: extras.tool }),
                ...(hasMetadata && { metadata: mergedMetadata }),
                ...(liveRequestId && { requestId: liveRequestId }),
              }
            : undefined;
        if (deps.emitBridgeThreadEvent) {
          deps.emitBridgeThreadEvent(
            id,
            type,
            message,
            role as AgentRole | "system" | "thinking" | "tool" | "user",
            stream,
            bridgeExtras,
          );
          return;
        }
        persistThreadEvent(
          id,
          type,
          message,
          role as AgentRole | "system" | "thinking" | "tool" | "user",
          stream,
          bridgeExtras,
          { observedAt },
        );
      },
      undefined,
      {
        ...(activityAgentId && { activityAgentId }),
        ...(sdkParentToolUseId && { parentToolUseId: sdkParentToolUseId }),
        ...(runAttemptId && { runAttemptId }),
      },
    );
  }

  function flush(threadId: string, options?: { observedAt?: string }): void {
    const observedAt = options?.observedAt ?? now();
    bridge.flushPendingAndReset(threadId, (id, type, message, role, stream, agentId, extras) => {
      if (deps.emitBridgeThreadEvent) {
        deps.emitBridgeThreadEvent(
          id,
          type,
          message,
          role as AgentRole | "system" | "thinking" | "tool" | "user",
          stream,
          extras,
        );
        return;
      }
      persistThreadEvent(
        id,
        type,
        message,
        role as AgentRole | "system" | "thinking" | "tool" | "user",
        stream,
        extras,
        { observedAt },
      );
    });
  }

  return {
    ingest,
    flush,
    registerDelegationLinker: (threadId, linker) => {
      delegationLinkers.set(threadId, linker);
    },
    clearDelegationLinker: (threadId) => {
      delegationLinkers.delete(threadId);
    },
    persistThreadEvent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSdkEventParentToolUseId(event: AgentEventLike): string | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }
  const parentToolUseId = event.payload.parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.trim() ? parentToolUseId.trim() : undefined;
}

function readSdkEventLogicalRequestId(event: AgentEventLike): string | undefined {
  if (!isRecord(event.payload)) {
    return undefined;
  }
  const fromPayload = event.payload.request_id ?? event.payload.logicalRequestId;
  return typeof fromPayload === "string" && fromPayload.trim() ? fromPayload.trim() : undefined;
}

function readStreamAttributedAgentId(
  agentId: string | undefined,
  plannerSessionId: string | undefined,
): string | undefined {
  const trimmed = agentId?.trim();
  if (!trimmed || trimmed === "unknown-session" || trimmed === plannerSessionId) {
    return undefined;
  }
  return trimmed;
}

/** PI native compaction lifecycle events (emitted by pi-event-adapter). */
export function isPiCompactionEvent(event: AgentEventLike): boolean {
  return (
    event.type === "context.compaction.started" ||
    event.type === "context.compaction.completed" ||
    event.type === "context.compaction.failed"
  );
}

export function piCompactionStatusInput(event: AgentEventLike): {
  stage: "started" | "completed" | "failed";
  trigger: "auto";
  preTokens?: number;
  postTokens?: number;
  detail?: string;
} {
  const payload = isRecord(event.payload) ? event.payload : {};
  const stage =
    event.type === "context.compaction.started"
      ? "started"
      : event.type === "context.compaction.completed"
        ? "completed"
        : "failed";
  const tokensBefore = typeof payload.tokensBefore === "number" ? payload.tokensBefore : undefined;
  const tokensAfter =
    typeof payload.estimatedTokensAfter === "number" ? payload.estimatedTokensAfter : undefined;
  const failedDetail = typeof payload.message === "string" && payload.message ? payload.message : undefined;
  const delta =
    stage === "completed" && tokensBefore !== undefined && tokensAfter !== undefined
      ? `${formatContextLimit(tokensBefore)} → ${formatContextLimit(tokensAfter)}`
      : undefined;
  const detail = stage === "failed" ? failedDetail : delta;
  return {
    stage,
    trigger: "auto",
    ...(tokensBefore !== undefined && { preTokens: tokensBefore }),
    ...(tokensAfter !== undefined && { postTokens: tokensAfter }),
    ...(detail && { detail }),
  };
}

function isSdkCompactionStatusEvent(event: AgentEventLike): boolean {
  return (
    isRecord(event.payload) &&
    event.payload.type === "system" &&
    event.payload.subtype === "status" &&
    event.payload.status === "compacting"
  );
}

function isSdkCompactionBoundaryEvent(event: AgentEventLike): boolean {
  return isRecord(event.payload) && event.payload.subtype === "compact_boundary";
}

function readEventObservedAt(event: AgentEventLike, fallback: string): string {
  if (typeof event.timestamp === "string" && event.timestamp.trim()) {
    return event.timestamp;
  }
  return fallback;
}
