import {
  type ConversationEventInput,
  type ConversationEventType,
  type ConversationMessage,
  stableHash,
} from "@eco/shared";
import { SUBAGENT_ROLES } from "../shared/ipc";
import type { ThreadRunEvent, ThreadRunEventInput } from "../shared/thread-run-events";
import { isContextCompactionEventType, parseThreadRunCodemodeMetadata } from "../shared/thread-run-events";
import {
  legacyMessageId,
  legacyNoticeMessageId,
  legacyProviderRole,
  legacyToolCallId,
  legacyToolMetadata,
} from "./conversation-v2-legacy-identity";
import type { ConversationAppendResult, ConversationV2Store } from "./conversation-v2-store";
import { isSdkNoticeLiveType } from "./thread-run-event-normalizer";

export interface ProviderConversationAdapterOptions {
  mode?: "migration" | "runtime";
  sourcePrefix?: string;
  /** Use when V1 and V2 must participate in one caller-owned SQLite transaction. */
  inCurrentTransaction?: boolean;
  onAppendResult?(result: ConversationAppendResult): void;
}

/** Normalizes provider envelopes into V2 facts without reading or writing V1 tables.
 * Migration retains legacy inferred identities; live runtime requires explicit run ownership
 * and writes append deltas for cumulative snapshots to keep storage growth linear.
 */
export function appendProviderEventToConversationV2(
  store: ConversationV2Store,
  event: ThreadRunEvent,
  options: ProviderConversationAdapterOptions = {},
): number {
  let emitted = 0;
  const runtime = options.mode === "runtime";
  let runId = event.runAttemptId?.trim() || undefined;
  // Agent lifecycle envelopes can span several provider turns (for example a
  // Codex child thread emits `agent.started` from the spawn turn and
  // `agent.stopped` from its own completion turn). Inferring ownership from
  // each envelope's `turnId` would attach one stable agent instance to two
  // different runs and make the second lifecycle event look like an identity
  // change. Runtime messages/tools still recover their run from the persisted
  // request correlation; agent lifecycle keeps only an explicit runAttemptId.
  if (runtime && !runId && !event.eventType.startsWith("agent.")) {
    const requestId =
      event.requestId?.trim() ||
      (typeof event.metadata?.turnId === "string" ? event.metadata.turnId.trim() : "");
    const recoveredRunId = requestId
      ? store.resolveRuntimeRunAttemptId(event.threadId, requestId)
      : undefined;
    if (recoveredRunId) {
      event = { ...event, runAttemptId: recoveredRunId };
      runId = recoveredRunId;
    }
  }
  // Legacy rows can be upgraded in place (for example a generic tool.started
  // later receives its tool detail). Include the row revision in the V2 source
  // key so the immutable log records that richer version instead of replaying
  // the old V2 event with a conflicting payload.
  const sourceBase = `${options.sourcePrefix ?? "legacy"}:${event.threadId}:${event.id}:${runtime ? 0 : event.sequence}:${stableHash(
    stripGeneratedConversationV2MessageIdentity(stripLegacyCompatibilityMarker(event)),
  )}`;
  if (runtime && runId && !store.getRun(event.threadId, runId)) {
    throw new Error(`Runtime event ${event.id} refers to a run that has not been started: ${runId}.`);
  }
  if (
    runtime &&
    !runId &&
    event.role !== "user" &&
    (event.eventType.startsWith("message.") || event.eventType.startsWith("thinking."))
  ) {
    throw new Error(`Runtime message ${event.id} requires an explicit runAttemptId.`);
  }
  let ownerResolved = false;
  let ownerAgentInstanceId: string | undefined;
  const agentInstanceId = (): string | undefined => {
    if (!ownerResolved) {
      ownerAgentInstanceId = resolveLegacyOwnerAgentId(event, store);
      ownerResolved = true;
    }
    return ownerAgentInstanceId;
  };
  const owner = agentInstanceId();
  const turnId = runId || event.requestId?.trim() || `turn_legacy_${stableHash(event.threadId)}`;
  // The legacy log does not always fill `agent_id` for a subagent's row: a task
  // progress notification is written with `scope = "agent"` but only names its agent
  // inside `metadata.sdkTaskId` (the agent instance the progress belongs to). Without
  // reading it here, such a row reaches V2 unowned, and an unowned agent-scoped row is
  // rendered in the main Feed — a subagent's tool ends up in the middle of the answer
  // it was working for.
  const emit = (
    type: ConversationEventType,
    suffix: string,
    payload: Record<string, unknown>,
    ids: { messageId?: string; toolCallId?: string } = {},
    emitOptions: { omitAgentOwnership?: boolean; parentToolCallId?: string } = {},
  ): void => {
    const sourceEventKey = `${sourceBase}:${suffix}`;
    // A codemode script's own calls carry their nesting link on the tool metadata, not on the
    // event: `event.parentToolUseId` is the subagent-ownership link, and PI deliberately leaves it
    // unset for these rows. V2 has one column for both, and the tool row's copy is what the Feed
    // reads to keep a script's calls inside the script's card.
    const parentToolCallId = emitOptions.parentToolCallId ?? event.parentToolUseId;
    const input: ConversationEventInput = {
      conversationId: event.threadId,
      eventId: `legacy_v2_${stableHash(sourceEventKey)}`,
      sourceEventKey,
      type,
      occurredAt: event.observedAt,
      ...(turnId ? { turnId } : {}),
      ...(runId ? { runId } : {}),
      ...(ids.messageId ? { messageId: ids.messageId } : {}),
      ...(ids.toolCallId ? { toolCallId: ids.toolCallId } : {}),
      ...(!emitOptions.omitAgentOwnership && owner ? { agentId: owner, agentInstanceId: owner } : {}),
      ...(event.parentAgentId
        ? { parentAgentId: event.parentAgentId, parentAgentInstanceId: event.parentAgentId }
        : {}),
      ...(parentToolCallId ? { parentToolCallId } : {}),
      payload,
    };
    const result = options.inCurrentTransaction
      ? store.appendInCurrentTransaction(input)
      : runtime
        ? store.appendRuntime(input)
        : store.append(input);
    options.onAppendResult?.(result);
    // A migration checkpoint can be persisted after the V2 append. If the
    // process dies in between, replaying the source row is expected to hit
    // the source-key idempotency constraint; do not report that duplicate as
    // a newly emitted event.
    emitted += result.duplicate ? 0 : 1;
  };

  const liveType = typeof event.metadata?.liveType === "string" ? event.metadata.liveType : "";
  if (isContextCompactionEventType(event.eventType)) {
    if (!runId) {
      if (runtime) throw new Error(`Runtime compaction event ${event.id} requires an explicit runAttemptId.`);
      return emitted;
    }
    emit("detail.upserted", "compaction", {
      detailType: event.eventType,
      content: JSON.stringify({
        message: event.message,
        observedAt: event.observedAt,
        scope: event.scope,
        ...(event.role ? { role: event.role } : {}),
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(event.streamKey ? { streamKey: event.streamKey } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      }),
    });
    return emitted;
  }
  // A user prompt is part of the conversation the Feed draws: the legacy chain renders
  // it as a row of the turn it opened (it is also that turn's boundary), and V2 had no row
  // for it at all. That is invisible while the conversation is still served by the legacy
  // projection and becomes lost content the moment it is migrated — a prompt the reader
  // cannot see is a hole in the record, not a styling difference.
  //
  // A prompt the runtime already recorded as a V2 message carries that message's id in
  // its metadata. Those rows are V2's own: mirroring them again would ask the same message
  // to be created twice under two different turn identities, so they are left alone.
  if (isLegacyUserPromptRow(event)) {
    const messageId = legacyMessageId(event);
    const historyTarget = providerHistoryTarget(event, runtime);
    const alreadyV2 = typeof event.metadata?.conversationV2MessageId === "string";
    const exists = store.hasConversation(event.threadId)
      ? store.getMessage(event.threadId, messageId)
      : undefined;
    if (!alreadyV2 && !exists) {
      const promptRole = legacyProviderRole(event);
      emit(
        "message.created",
        "prompt",
        {
          role: "user",
          channel: "answer",
          body: event.message,
          status: "final",
          ...(promptRole ? { providerRole: promptRole } : {}),
          ...(historyTarget ? { historyTarget } : {}),
        },
        { messageId },
      );
    }
    return emitted;
  }
  // A failed request is content the reader reads: the legacy Feed draws the row with the
  // provider's role and its notice text ("【连接失败】HTTP 503：…"), and V2 had no row for the
  // event type at all. Migrating such a conversation therefore reported the turn as failed
  // with no reason: the recorder's `api.error` row was dropped as unmapped and the text was
  // gone. It is mirrored as a notice message instead of assistant speech — `channel:
  // "system"` is what the Feed reads as "the provider reported this, the agent did not say
  // it" — so the row keeps its own position in the log and its own identity.
  if (
    event.eventType === "api.error" ||
    (event.eventType === "diagnostic" && isSdkNoticeLiveType(liveType))
  ) {
    // A notice without text says nothing; the legacy projection renders a failure row for it
    // from the request phase, not from this event.
    if (event.message.trim()) {
      const noticeRole = legacyProviderRole(event);
      emit(
        "message.created",
        "notice",
        {
          role: "system",
          // The renderer reserves the system channel for connection failures.
          // Protocol/billing notices use system-role commentary instead.
          channel: event.eventType === "api.error" ? "system" : "commentary",
          body: event.message,
          status: "final",
          ...(noticeRole ? { providerRole: noticeRole } : {}),
        },
        { messageId: legacyNoticeMessageId(event) },
      );
    }
    return emitted;
  }
  if (
    (event.eventType === "message.delta" ||
      event.eventType === "message.final" ||
      event.eventType === "thinking.delta" ||
      event.eventType === "thinking.final") &&
    !legacyInteractionType(liveType)
  ) {
    const messageId = legacyMessageId(event);
    const existing = store.hasConversation(event.threadId)
      ? store.getMessage(event.threadId, messageId)
      : undefined;
    const role = messageRole(event.role);
    // The provider's own label (`planner`, `coder`, `explore`, ...) is a fact about
    // the row, not a display preference: the Feed identifies a turn's final output by
    // `role === "planner"`. Normalizing it away here left the V2-only projection
    // unable to answer that question, so the label travels with the row.
    const providerRole = legacyProviderRole(event);
    const channel =
      event.eventType.startsWith("thinking") || event.role === "thinking" ? "thinking" : "answer";
    const body = event.message;
    const historyTarget = event.role === "user" ? providerHistoryTarget(event, runtime) : undefined;
    const isFinal = event.eventType === "message.final" || event.eventType === "thinking.final";
    // Placeholder stream rows carry no text. Creating a V2 message for them
    // leaves a permanently `streaming` row behind (the matching final row never
    // arrives), which every reader renders as output that never finishes.
    // Empty bodies therefore never create or overwrite a message; they may only
    // close an existing one.
    const hasBody = (runtime && isFinal) || body.trim().length > 0;
    if (!existing) {
      if (!hasBody) return emitted;
      emit(
        "message.created",
        "create",
        {
          role,
          channel,
          body,
          status: isFinal ? "final" : "streaming",
          ...(providerRole ? { providerRole } : {}),
          ...(historyTarget ? { historyTarget } : {}),
        },
        { messageId },
      );
    } else if (hasBody && existing.body !== body) {
      const appendOnly = runtime && body.startsWith(existing.body);
      emit(
        appendOnly ? "message.delta" : "message.replaced",
        appendOnly ? "append" : "replace",
        {
          baseContentVersion: existing.contentVersion,
          nextContentVersion: existing.contentVersion + 1,
          ...(appendOnly ? { delta: body.slice(existing.body.length) } : { body }),
        },
        { messageId },
      );
    }
    if (isFinal) {
      emit("message.finalized", "finalize", { status: "final" }, { messageId });
    }
    return emitted;
  }

  const runType = legacyRunEventType(event.eventType);
  const agentType = legacyAgentEventType(event.eventType);
  if (agentType && event.agentId) {
    const missionKey = optionalEventText(event.metadata?.missionKey);
    const delegationPrompt = optionalEventText(event.metadata?.delegationPrompt);
    const delegationSummary = optionalEventText(event.metadata?.delegationSummary);
    const taskName = optionalEventText(event.metadata?.taskName);
    emit(agentType, "agent", {
      agentInstanceId: event.agentId,
      // Role, kind, mission, task name and delegation are what an agent card is drawn
      // from. They only ever existed on the legacy row, so a V2 record that drops them
      // forces every consumer to invent them (or read the legacy table again).
      ...(event.role ? { role: event.role } : {}),
      ...(event.role ? { kind: event.role === "planner" ? "planner" : "subagent" } : {}),
      ...(missionKey ? { mission: missionKey } : {}),
      ...(delegationPrompt ? { delegationPrompt } : {}),
      ...(delegationSummary ? { delegationSummary } : {}),
      ...(taskName ? { taskName } : {}),
      ...(event.parentAgentId ? { parentAgentInstanceId: event.parentAgentId } : {}),
      ...(event.parentToolUseId ? { parentToolCallId: event.parentToolUseId } : {}),
      status: agentType === "agent.started" ? "running" : agentType.slice("agent.".length),
    });
    return emitted;
  }
  if (runType && runtime) return emitted;
  if (runType) {
    if (!runId) return 0;
    emit(runType, "run", {
      status: runType === "run.started" ? "running" : runType.slice("run.".length),
      timingQuality: "unknown",
    });
    return emitted;
  }

  const interactionType = legacyInteractionType(liveType);
  if (interactionType) {
    const tool = legacyToolMetadata(event);
    const descriptor = deriveLegacyToolDescriptor(event, tool);
    if (!runId && runtime) throw new Error(`Runtime event ${event.id} requires an explicit runAttemptId.`);
    if (!runId) {
      runId = `legacy_run_${stableHash(`${event.threadId}:${descriptor.toolCallId}`)}`;
      emit("run.started", "synthetic-run", {
        status: "running",
        timingQuality: "unknown",
      });
    }
    if (!runtime && descriptor.toolCallId) {
      descriptor.toolCallId = disambiguateLegacyToolCallId(
        store,
        event.threadId,
        runId,
        descriptor.toolCallId,
      );
    }
    const isRequested =
      interactionType === "approval.requested" || interactionType === "clarification.requested";
    // Approval is a permission boundary, not the tool's execution result. The
    // provider often reuses the same toolUseId for the approval row and the real
    // tool row; marking an approved request as completed here would make a later
    // tool.failed/tool.completed look like a conflicting terminal status. Keep the
    // call running until its actual provider tool event arrives.
    const isApproved = liveType === "bash_approval.approved" || liveType === "plan_approval.approved";
    const isRejected =
      liveType === "bash_approval.rejected" ||
      liveType === "bash_approval.denied" ||
      liveType === "plan_approval.denied";
    const toolProviderRole = legacyProviderRole(event);
    if (
      descriptor.toolCallId &&
      (liveType.startsWith("bash_approval.") || liveType.startsWith("clarification."))
    ) {
      emit(
        isRequested || isApproved ? "tool.started" : isRejected ? "tool.failed" : "tool.completed",
        "interaction-tool",
        {
          name: descriptor.name,
          status: isRequested || isApproved ? "running" : isRejected ? "failed" : "completed",
          ...(descriptor.input !== undefined ? { input: descriptor.input } : {}),
          ...(descriptor.output !== undefined ? { output: descriptor.output } : {}),
        },
        { toolCallId: descriptor.toolCallId },
        // Approval rows are recorded under the reviewer/planner that handled the
        // permission prompt, which can differ from the agent that owns the actual
        // tool call. Keep approval ownership on the interaction fact below; leave
        // the tool summary unowned until a tool.started/completed row supplies its
        // execution owner.
        { omitAgentOwnership: true },
      );
      emitMissingLegacyToolSummary(descriptor, toolProviderRole);
    }
    emit(
      interactionType,
      "interaction",
      {
        detailType: interactionType,
        content: JSON.stringify({
          liveType,
          message: event.message,
          ...(event.metadata?.bashApproval ? { bashApproval: event.metadata.bashApproval } : {}),
          ...(event.metadata?.clarification ? { clarification: event.metadata.clarification } : {}),
          ...(event.metadata?.plan ? { plan: event.metadata.plan } : {}),
          ...(event.metadata?.planApproval ? { planApproval: event.metadata.planApproval } : {}),
        }),
        ...(descriptor.toolCallId ? { toolUseId: descriptor.toolCallId } : {}),
      },
      descriptor.toolCallId ? { toolCallId: descriptor.toolCallId } : {},
    );
    return emitted;
  }

  if (
    event.eventType === "tool.started" ||
    event.eventType === "tool.completed" ||
    event.eventType === "tool.failed"
  ) {
    const tool = legacyToolMetadata(event);
    if (isLegacyTaskProgressRow(event) && typeof tool.toolUseId !== "string") {
      return emitted;
    }
    const descriptor = deriveLegacyToolDescriptor(event, tool);
    if (!descriptor.toolCallId) return 0;
    // A heartbeat (`call_<id>-heartbeat-N`, label `Tool: Bash (30.0s)`) is a progress tick
    // of a call that already has its own row. The legacy Feed shows none of them (24 such
    // rows in the dev database for `thr_1789531481908`, 0 in its projection), so keeping
    // them adds a row no reader ever had — and one without an owner lands mid-Feed.
    if (isLegacyHeartbeatToolCallId(descriptor.toolCallId)) {
      return emitted;
    }
    // A legacy event without runAttemptId used to disappear here. Preserve it
    // as a deterministic synthetic run so the V2 timeline still accounts for
    // the tool. When a later row carries the real attempt ID, that row remains
    // authoritative and is not merged by text or wall-clock proximity.
    let syntheticRun = false;
    if (!runId && runtime) throw new Error(`Runtime event ${event.id} requires an explicit runAttemptId.`);
    if (!runId) {
      syntheticRun = true;
      runId = `legacy_run_${stableHash(`${event.threadId}:${descriptor.toolCallId}`)}`;
      emit("run.started", "synthetic-run", {
        status: "running",
        timingQuality: "unknown",
      });
    }
    if (!runtime) {
      descriptor.toolCallId = disambiguateLegacyToolCallId(
        store,
        event.threadId,
        runId,
        descriptor.toolCallId,
      );
    }
    const toolProviderRole = legacyProviderRole(event);
    emit(
      event.eventType === "tool.started"
        ? "tool.started"
        : event.eventType === "tool.completed"
          ? "tool.completed"
          : "tool.failed",
      "tool",
      {
        name: descriptor.name,
        ...(toolProviderRole ? { providerRole: toolProviderRole } : {}),
        status:
          event.eventType === "tool.started"
            ? "running"
            : event.eventType === "tool.completed"
              ? "completed"
              : "failed",
        ...(descriptor.input !== undefined ? { input: descriptor.input } : {}),
        ...(descriptor.output !== undefined ? { output: descriptor.output } : {}),
      },
      { toolCallId: descriptor.toolCallId },
      descriptor.parentToolCallId ? { parentToolCallId: descriptor.parentToolCallId } : {},
    );
    emitMissingLegacyToolSummary(descriptor, toolProviderRole);
    // Only the synthetic run this tool call invented may be closed here. A tool
    // finishing says nothing about the run that owns it: closing the real
    // attempt's run on the first tool completion made V2 report a live turn as
    // finished (the Feed rendered it as "已处理 11s" while the attempt was still
    // running), and a later genuine terminal state then conflicted with it.
    if (syntheticRun && (event.eventType === "tool.completed" || event.eventType === "tool.failed")) {
      emit(event.eventType === "tool.completed" ? "run.completed" : "run.failed", "synthetic-run-final", {
        status: event.eventType === "tool.completed" ? "completed" : "failed",
        timingQuality: "unknown",
      });
    }
  }
  return emitted;

  function emitMissingLegacyToolSummary(
    summary: { name: string; toolCallId: string; input?: unknown; output?: unknown },
    providerRole?: string,
  ): void {
    // A completed migration may have been produced by an older adapter version that
    // only persisted the display label. Replaying the same immutable legacy source
    // must be able to add the structured fields without rewriting an existing event.
    // Runtime never reads V1 and never performs this repair; it is a maintenance-only
    // bridge while the legacy source is still available.
    if (options.mode !== "migration") return;
    if (summary.input === undefined && summary.output === undefined) return;
    const existing = store.getTool(event.threadId, summary.toolCallId);
    const needsInput = existing.input === undefined && summary.input !== undefined;
    const needsOutput = existing.output === undefined && summary.output !== undefined;
    if (!needsInput && !needsOutput) return;
    emit(
      "tool.updated",
      `tool-summary:${stableHash({
        toolCallId: summary.toolCallId,
        input: summary.input,
        output: summary.output,
      })}`,
      {
        name: summary.name,
        status: "running",
        ...(providerRole ? { providerRole } : {}),
        ...(needsInput && summary.input !== undefined ? { input: summary.input } : {}),
        ...(needsOutput && summary.output !== undefined ? { output: summary.output } : {}),
      },
      { toolCallId: summary.toolCallId },
    );
  }
}

function legacyInteractionType(
  liveType: string,
):
  | "approval.requested"
  | "approval.resolved"
  | "clarification.requested"
  | "clarification.resolved"
  | undefined {
  if (
    liveType === "bash_approval.requested" ||
    liveType === "plan_approval.requested" ||
    liveType === "clarification.requested"
  ) {
    return liveType === "clarification.requested" ? "clarification.requested" : "approval.requested";
  }
  if (
    liveType === "bash_approval.approved" ||
    liveType === "bash_approval.rejected" ||
    liveType === "bash_approval.denied" ||
    liveType === "plan_approval.approved" ||
    liveType === "plan_approval.denied"
  ) {
    return "approval.resolved";
  }
  if (liveType === "clarification.answered" || liveType === "clarification.resolved") {
    return "clarification.resolved";
  }
  return undefined;
}

/**
 * The agent a legacy row belongs to, resolved the way the legacy projector resolves it.
 *
 * `agent_id` is the normal answer. Rows written without it are agent-scoped rows whose
 * owner is only expressed structurally, and the legacy projection resolves them by (1)
 * the parent tool link the agent was spawned from, then (2) the single subagent of that
 * role inside the attempt's window. Reading only the column would leave those rows
 * unowned, and an unowned row is drawn in the main Feed — which is exactly the leak the
 * V2 read path is supposed to prevent.
 */
function resolveLegacyOwnerAgentId(event: ThreadRunEvent, store: ConversationV2Store): string | undefined {
  const column = event.agentId?.trim();
  if (column) return column;
  if (event.scope !== "agent" && event.scope !== "both") return undefined;
  const parentToolUseId = event.parentToolUseId?.trim() || readLegacyParentToolUseId(event);
  if (parentToolUseId) {
    // Some provider envelopes carry the parent tool link but omit `agent_id` on
    // the row. The V2 tool read model already has the owner of that exact call;
    // using it is stronger evidence than a role-only match and also covers an
    // agent whose legacy instance row did not persist its parent link.
    const parentTool = store.findTool(event.threadId, parentToolUseId);
    const parentOwner = parentTool?.agentId?.trim() || parentTool?.agentInstanceId?.trim();
    if (parentOwner) return parentOwner;
    const agents = store.agentsOf(event.threadId);
    return agents.find((agent) => agent.parentToolCallId === parentToolUseId)?.agentId;
  }
  const agents = store.agentsOf(event.threadId);
  if (agents.length === 0) return undefined;
  const role = event.role?.trim();
  if (!role || !(SUBAGENT_ROLES as readonly string[]).includes(role)) {
    return undefined;
  }
  const attemptId = event.runAttemptId?.trim();
  const pool = agents.filter(
    (agent) => agent.kind === "subagent" && agent.role === role && (!attemptId || agent.runId === attemptId),
  );
  const unique = new Map(pool.map((agent) => [agent.agentId, agent]));
  if (unique.size !== 1) return undefined;
  const agent = [...unique.values()][0];
  if (!agent) return undefined;
  // Same grace as the legacy projector: a row observed just outside the agent's window
  // is not evidence that it belongs to that agent.
  const observedMs = Date.parse(event.observedAt);
  const startedMs = agent.startedAt ? Date.parse(agent.startedAt) : Number.NaN;
  if (!Number.isFinite(observedMs) || !Number.isFinite(startedMs)) {
    return agent.agentId;
  }
  const endedMs = agent.endedAt ? Date.parse(agent.endedAt) : Number.POSITIVE_INFINITY;
  if (observedMs < startedMs - 15_000) return undefined;
  if (Number.isFinite(endedMs) && observedMs > endedMs + 15_000) return undefined;
  return agent.agentId;
}

/** Reads the parent tool link, including the snake_case key the live stream writes. */
function readLegacyParentToolUseId(event: ThreadRunEvent): string | undefined {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = metadata.parentToolUseId ?? metadata.parent_tool_use_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Heartbeat tool ids: `<call id>-heartbeat-<n>`. They exist only while a call is running
 * and are never the call itself.
 */
function isLegacyHeartbeatToolCallId(toolCallId: string): boolean {
  return /-heartbeat-\d+$/.test(toolCallId);
}

/**
 * A provider progress notification that the legacy log stored as a tool row.
 *
 * The live stream writes "Running <description>" rows for the task of an agent, keyed
 * by nothing a tool call can be joined to. The legacy Feed drops them: the tool call
 * they describe arrives as its own row. Deriving a tool call from one invents a call
 * that never happened, which then has no owner and is drawn in the main Feed.
 */
function isLegacyTaskProgressRow(event: ThreadRunEvent): boolean {
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  const kind = typeof metadata.sdkTaskKind === "string" ? metadata.sdkTaskKind : "";
  const live = typeof metadata.liveType === "string" ? metadata.liveType : "";
  return kind === "task_progress" || live === "todo.updated";
}

function deriveLegacyToolDescriptor(
  event: ThreadRunEvent,
  tool: Record<string, unknown>,
): {
  name: string;
  toolCallId: string;
  input?: unknown;
  output?: unknown;
  parentToolCallId?: string;
} {
  const message = event.message.trim();
  const nameFromMetadata = typeof tool.name === "string" ? tool.name.trim() : "";
  const nameFromMessage = message.match(/(?:Tool|工具(?:调用)?)\s*[:：]\s*([A-Za-z][\w.-]*)/i)?.[1] ?? "";
  const name = nameFromMetadata || nameFromMessage || "Tool";
  const toolCallId = legacyToolCallId(event);
  const metadataDetail = typeof tool.detail === "string" ? tool.detail.trim() : "";
  const messageDetail = message.split(/[·|]/).slice(1).join("·").trim();
  const detail = metadataDetail || messageDetail || undefined;
  // A codemode script IS the tool's input, and the legacy row carries no `detail` for it, so the
  // heuristics below would store nothing and the card could only ever show the output. `code` is
  // the key the renderer reads for the script; the rest of PI's details ride under `codemode`
  // because the tool row has no column of their own.
  const codemode = parseThreadRunCodemodeMetadata(tool.codemode);
  const codemodeInput = codemode
    ? {
        ...(codemode.script ? { code: codemode.script } : {}),
        ...(codemode.calls || codemode.fullOutputPath
          ? {
              codemode: {
                ...(codemode.calls ? { calls: codemode.calls } : {}),
                ...(codemode.fullOutputPath ? { fullOutputPath: codemode.fullOutputPath } : {}),
              },
            }
          : {}),
      }
    : undefined;
  const baseInput =
    tool.input !== undefined
      ? tool.input
      : codemodeInput !== undefined && (codemodeInput.code || codemodeInput.codemode)
        ? codemodeInput
        : detail === undefined
          ? undefined
          : isLegacyCommandTool(name)
            ? { command: detail }
            : isLegacyPathTool(name)
              ? { file_path: detail }
              : { detail };
  const input = mergeLegacyToolMetadata(baseInput, tool, event.metadata);
  const output =
    tool.output !== undefined
      ? tool.output
      : typeof tool.outputPreview === "string"
        ? tool.outputPreview
        : undefined;
  const parentToolCallId = typeof tool.parentToolCallId === "string" ? tool.parentToolCallId.trim() : "";
  return {
    name,
    toolCallId,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
  };
}

/**
 * Some legacy providers restart their tool counter for every run, so two distinct
 * calls can both be named `web_fetch_0` inside one conversation. V2 call IDs are
 * conversation-wide identities. Keep the original ID for the first run and derive
 * a deterministic replacement only when a later run collides; a resumed migration
 * then reaches the same replacement without changing either call's source facts.
 */
function disambiguateLegacyToolCallId(
  store: ConversationV2Store,
  conversationId: string,
  runId: string,
  toolCallId: string,
): string {
  const existing = store.findTool(conversationId, toolCallId);
  if (!existing || existing.runId === runId) return toolCallId;
  const disambiguated = `legacy_tool_${stableHash(`${conversationId}:${runId}:${toolCallId}`)}`;
  const sameRun = store.findTool(conversationId, disambiguated);
  if (sameRun && sameRun.runId !== runId) {
    throw new Error(`Legacy tool ID collision while migrating ${toolCallId}.`);
  }
  return disambiguated;
}

function mergeLegacyToolMetadata(
  input: unknown,
  tool: Record<string, unknown>,
  eventMetadata?: Record<string, unknown>,
): unknown {
  const metadataKeys = [
    "detail",
    "description",
    "readTarget",
    "grepTarget",
    "fileChange",
    "webSearch",
    "imageView",
    "imageDisplay",
    "htmlHost",
    "mcpDiscovery",
    "sendMessage",
    "nonExecutionKind",
    "bashApproval",
    "clarification",
    "planApproval",
  ];
  const source = { ...(eventMetadata ?? {}), ...tool };
  const metadata = Object.fromEntries(
    metadataKeys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  if (Object.keys(metadata).length === 0) return input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>), ...metadata };
  }
  return {
    ...(input === undefined ? {} : { value: input }),
    ...metadata,
  };
}

function optionalEventText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isLegacyCommandTool(name: string): boolean {
  return name === "Bash" || name === "Shell" || name === "RunCommand" || name === "Execute";
}

function isLegacyPathTool(name: string): boolean {
  return name === "Read" || name === "Glob" || name === "Find" || name === "ListFiles";
}

function legacyAgentEventType(
  eventType: ThreadRunEvent["eventType"],
):
  | "agent.started"
  | "agent.completed"
  | "agent.failed"
  | "agent.cancelled"
  | "agent.interrupted"
  | undefined {
  switch (eventType) {
    case "agent.started":
      return "agent.started";
    case "agent.stopped":
      return "agent.completed";
    case "agent.abandoned":
      return "agent.interrupted";
    default:
      return undefined;
  }
}

export function conversationV2MessageIdForLegacyEvent(event: ThreadRunEventInput): string | undefined {
  if (
    event.eventType !== "message.delta" &&
    event.eventType !== "message.final" &&
    event.eventType !== "thinking.delta" &&
    event.eventType !== "thinking.final"
  ) {
    return undefined;
  }
  return legacyMessageId(event);
}

/** Identity of a provider envelope's normalized body, including user prompts and notices. */
export function conversationV2ProviderMessageId(event: ThreadRunEventInput): string | undefined {
  if (event.eventType === "api.error" && event.message.trim()) return legacyNoticeMessageId(event);
  if (
    event.eventType === "diagnostic" &&
    isSdkNoticeLiveType(String(event.metadata?.liveType ?? "")) &&
    event.message.trim()
  ) {
    return legacyNoticeMessageId(event);
  }
  if (isLegacyUserPromptRow(event)) return legacyMessageId(event);
  const liveType = typeof event.metadata?.liveType === "string" ? event.metadata.liveType : "";
  if (legacyInteractionType(liveType)) return undefined;
  // Empty delta/placeholder rows do not create a V2 message in migration mode;
  // a receipt must not claim an identity that has no durable message effect.
  if (!event.message.trim()) return undefined;
  return conversationV2MessageIdForLegacyEvent(event);
}

export function withLegacyConversationV2MessageIdentity<T extends ThreadRunEventInput>(event: T): T {
  const messageId = conversationV2MessageIdForLegacyEvent(event);
  if (!messageId) return event;
  return {
    ...event,
    metadata: {
      ...(event.metadata ?? {}),
      conversationV2MessageId: messageId,
    },
  } as T;
}

function stripGeneratedConversationV2MessageIdentity(event: ThreadRunEvent): ThreadRunEvent {
  if (!event.metadata || !Object.hasOwn(event.metadata, "conversationV2MessageId")) {
    return event;
  }
  const metadata = { ...event.metadata };
  delete metadata.conversationV2MessageId;
  if (Object.keys(metadata).length > 0) {
    return { ...event, metadata };
  }
  const { metadata: _metadata, ...withoutMetadata } = event;
  return withoutMetadata;
}

function stripLegacyCompatibilityMarker<T extends ThreadRunEventInput>(event: T): T {
  if (event.metadata?.legacyCompat !== true) {
    return event;
  }
  const metadata = { ...event.metadata };
  delete metadata.legacyCompat;
  if (Object.keys(metadata).length > 0) {
    return { ...event, metadata } as T;
  }
  const { metadata: _metadata, ...withoutMetadata } = event;
  return withoutMetadata as T;
}

/**
 * Preserve the provider rewind identity as an immutable V2 message fact.
 *
 * The activity line is an Eco-owned source-row identity and is available even
 * when a provider has not supplied its own user-message id yet. Keeping that
 * explicit event id lets later provider binding enrich the same V2 message;
 * it never makes the prompt eligible for destructive retry by itself.
 */
function legacyHistoryTarget(
  event: ThreadRunEventInput,
): { activityLineId: string; userMessageId?: string } | undefined {
  const value = event.metadata?.rewindTarget;
  const record =
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const activityLineId =
    (typeof record.activityLineId === "string" ? record.activityLineId.trim() : "") || event.id.trim();
  if (!activityLineId) return undefined;
  const userMessageId = typeof record.userMessageId === "string" ? record.userMessageId.trim() : "";
  return {
    activityLineId,
    ...(userMessageId ? { userMessageId } : {}),
  };
}

/**
 * Runtime prompts can carry a provisional local activity id while the provider is
 * still resolving its own item id. That local id belongs in the provider source
 * envelope, not in the immutable V2 message projection: the Codex bind will append
 * the first durable history target once `item.userMessage` supplies the SDK id.
 * Migration keeps the legacy inferred target unchanged because its source is already
 * authoritative and there is no later runtime bind.
 */
function providerHistoryTarget(
  event: ThreadRunEventInput,
  runtime: boolean,
): { activityLineId: string; userMessageId?: string } | undefined {
  const target = legacyHistoryTarget(event);
  if (!runtime || target?.userMessageId) return target;
  return target?.activityLineId.startsWith("codex-pending:") ? undefined : target;
}

/**
 * Whether a legacy row is a prompt that V2 has no row for at all.
 *
 * The legacy Feed draws a main-scope row with `role = "user"` and text as a user bubble,
 * whatever liveType named it (our own recorder writes `thread.user_prompt`, another core
 * writes `message.user`), and a row without text says nothing. What needs mirroring is
 * the form that carries no message identity of its own — the recorder's
 * `thread.status` prompt row. A `message.*`/`thinking.*` row is already handled below:
 * it names a V2 message (or gets one), and taking it away from that path would leave an
 * accepted user message unable to be closed by the legacy row that reports it.
 */
function isLegacyUserPromptRow(event: ThreadRunEventInput): boolean {
  const liveType = typeof event.metadata?.liveType === "string" ? event.metadata.liveType : "";
  // Codex child-thread prompts are delivered on the agent scope with the
  // provider role (`coder`, `explore`, …), even though their envelope is
  // explicitly marked `message.user`. Preserve that user-message identity in
  // V2 so the subagent drawer can render the parent's follow-up as an outgoing
  // prompt instead of assistant narration.
  if (
    event.scope === "agent" &&
    (liveType === "message.user" || liveType === "thread.user_prompt") &&
    event.message.trim().length > 0
  ) {
    return true;
  }
  if (event.role !== "user") return false;
  if (event.scope === "agent") return false;
  if (LEGACY_MESSAGE_EVENT_TYPES.has(event.eventType)) return false;
  return event.message.trim().length > 0;
}

const LEGACY_MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message.delta",
  "message.final",
  "thinking.delta",
  "thinking.final",
]);

function messageRole(role?: string): ConversationMessage["role"] {
  if (role === "user" || role === "system" || role === "tool") return role;
  return "assistant";
}

function legacyRunEventType(
  eventType: ThreadRunEvent["eventType"],
): "run.started" | "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted" | undefined {
  switch (eventType) {
    case "run.attempt.started":
      return "run.started";
    case "run.attempt.completed":
      return "run.completed";
    case "run.attempt.failed":
      return "run.failed";
    case "run.attempt.cancelled":
      return "run.cancelled";
    default:
      return undefined;
  }
}
