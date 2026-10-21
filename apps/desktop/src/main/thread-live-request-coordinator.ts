import { resolveActivityAgentId } from "./activity-agent-id.js";
import {
  readClaudeCodeAgentIdFromRequestHeaders,
  readProxyBillingStampFromRequestHeaders,
} from "./proxy-billing-stamp.js";
import type { SubagentMetricsRegistry } from "./subagent-metrics-registry.js";
import type { BindLogicalAgentIdResult, ThreadLiveRequestRegistry } from "./thread-live-request-registry.js";
import {
  clearRequestStartedPersisted,
  markRequestStartedPersisted,
  type RequestTerminalStage,
} from "./thread-request-lifecycle.js";

export const GATEWAY_ATTEMPT_CONNECTION_ERROR_ORIGIN = "proxy.connection_error";

export interface BridgeMessagesRequestInput {
  threadId: string;
  role: string;
  agentId?: string;
  /** When false, registry/lifecycle still run but no request.started timeline UI is emitted. */
  emitTimelineActivity: boolean;
}

export interface BridgeMessagesRequestResult {
  logicalRequestId: string;
  emitTimelineActivity: boolean;
  role: string;
  agentId?: string;
}

export interface FrozenLiveRequestAttribution {
  logicalRequestId: string;
  role: string;
  agentId?: string;
  emitTimelineActivity: boolean;
  providerRequestId?: string;
}

/** Bridge /messages — sole authority to create a logical request entry. */
export function handleBridgeMessagesRequest(
  registry: ThreadLiveRequestRegistry,
  input: BridgeMessagesRequestInput,
): BridgeMessagesRequestResult {
  finalizeCompletedSameScopeActiveRequests(registry, input.threadId, {
    role: input.role,
    ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
  });
  const begun = registry.beginRequest(input.threadId, {
    role: input.role,
    ...(input.agentId?.trim() ? { agentId: input.agentId.trim() } : {}),
    emitTimelineActivity: input.emitTimelineActivity,
  });
  return {
    logicalRequestId: begun.logicalRequestId,
    emitTimelineActivity: begun.emitTimelineActivity,
    role: begun.role,
    ...(begun.agentId ? { agentId: begun.agentId } : {}),
  };
}

/** PI tool loops: close prior upstream-completed same-scope requests before the next LLM call. */
function finalizeCompletedSameScopeActiveRequests(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  scope: { role: string; agentId?: string },
): void {
  const role = scope.role.trim();
  const agentId = scope.agentId?.trim();
  for (const entry of registry.listActive(threadId)) {
    if (entry.role !== role) {
      continue;
    }
    if (agentId) {
      if (entry.agentId !== agentId) {
        continue;
      }
    } else if (entry.agentId) {
      continue;
    }
    if (!entry.providerRequestId?.trim()) {
      continue;
    }
    registry.moveToFinalized(threadId, entry.logicalRequestId);
  }
}

/**
 * Bridge /messages agentId may only come from explicit request-scoped headers.
 * Priority: Eco Vision stamp (`x-eco-agent-id` + matching `x-eco-billing-role`) →
 * Claude instance header (`x-claude-code-agent-id`, route.role as billing role).
 * Billing stamp registry inference must not pre-fill entries.
 */
export function resolveExplicitBridgeRequestAgentId(
  routeRole: string,
  requestHeaders?: Headers,
): string | undefined {
  if (!requestHeaders) {
    return undefined;
  }
  const stamp = readProxyBillingStampFromRequestHeaders(requestHeaders);
  const ecoAgentId = stamp.agentId?.trim();
  const ecoBillingRole = stamp.billingRole?.trim();
  if (ecoAgentId && ecoBillingRole && ecoBillingRole === routeRole.trim()) {
    return ecoAgentId;
  }
  // Claude header carries instance id only; Eco route.role is the billing role.
  // Eco stamp with mismatched role does not block Claude header fallback.
  return readClaudeCodeAgentIdFromRequestHeaders(requestHeaders);
}

function readSdkPayloadParentToolUseId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const parentToolUseId = (payload as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parentToolUseId === "string" && parentToolUseId.trim() ? parentToolUseId.trim() : undefined;
}

export interface SdkLateBindAttributionInput {
  type: string;
  role: string;
  agentId?: string;
  payload?: unknown;
}

export interface SdkLateBindAttribution {
  agentId: string;
  role: string;
}

/**
 * Exact SDK late-bind identity: main planner session or subagent via parentToolUseId/metrics.
 * Never infers from role/current/latest/FIFO.
 */
export function resolveSdkLateBindAttribution(
  threadId: string,
  event: SdkLateBindAttributionInput,
  options: {
    plannerSessionId?: string;
    metricsRegistry?: SubagentMetricsRegistry;
  },
): SdkLateBindAttribution | undefined {
  if (event.type !== "usage.recorded" && event.type !== "message.delta") {
    return undefined;
  }

  const plannerSessionId = options.plannerSessionId?.trim();
  const eventAgentId = event.agentId?.trim();
  const parentToolUseId = readSdkPayloadParentToolUseId(event.payload);

  if (plannerSessionId && eventAgentId === plannerSessionId && !parentToolUseId) {
    return { agentId: plannerSessionId, role: "main" };
  }

  const activityAgentId = resolveActivityAgentId(
    threadId,
    {
      type: event.type,
      role: event.role,
      agentId: eventAgentId,
      payload: event.payload,
    } as Parameters<typeof resolveActivityAgentId>[1],
    {
      ...(plannerSessionId ? { plannerSessionId } : {}),
      ...(options.metricsRegistry ? { metricsRegistry: options.metricsRegistry } : {}),
    },
  );
  if (!activityAgentId) {
    return undefined;
  }
  return { agentId: activityAgentId, role: event.role.trim() || "coder" };
}

export function clearFinalizedLiveRequestsForAttempt(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  runAttemptId: string,
): void {
  registry.clearFinalizedForAttempt(threadId, runAttemptId);
}

export function resolveFrozenLiveRequestAttribution(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  logicalRequestId: string,
): FrozenLiveRequestAttribution | undefined {
  const trimmed = logicalRequestId.trim();
  if (!trimmed) {
    return undefined;
  }
  const active = registry.findEntryByLogicalId(threadId, trimmed);
  if (active) {
    return {
      logicalRequestId: active.logicalRequestId,
      role: active.role,
      emitTimelineActivity: active.emitTimelineActivity,
      ...(active.agentId ? { agentId: active.agentId } : {}),
      ...(active.providerRequestId ? { providerRequestId: active.providerRequestId } : {}),
    };
  }
  // Late Gateway usage may arrive after lifecycle finalize — still resolve stamp.
  const finalized = registry.findFinalizedByLogicalId(threadId, trimmed);
  if (!finalized) {
    return undefined;
  }
  return {
    logicalRequestId: finalized.logicalRequestId,
    role: finalized.role,
    emitTimelineActivity: finalized.emitTimelineActivity,
    ...(finalized.agentId ? { agentId: finalized.agentId } : {}),
    ...(finalized.providerRequestId ? { providerRequestId: finalized.providerRequestId } : {}),
  };
}

function lifecycleEventRoleMatchesEntry(entryRole: string, eventRole?: string): boolean {
  const trimmed = eventRole?.trim();
  if (!trimmed) {
    return true;
  }
  return trimmed === entryRole;
}

/**
 * SDK live-event attribution. Never begins registry entries.
 * SDK request.started must never resolve via registry — Bridge owns started spans.
 */
export function resolveLiveRequestIdForEvent(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  input: { type: string; role: string; stream: boolean; agentId?: string },
): string | undefined {
  if (input.type === "request.started") {
    return undefined;
  }
  if (
    !input.type.startsWith("request.") &&
    input.type !== "thread.api_error" &&
    !input.stream &&
    input.type !== "message.delta" &&
    input.type !== "message.final" &&
    input.type !== "thinking.delta" &&
    input.type !== "thinking.final"
  ) {
    return undefined;
  }
  const scope = {
    role: input.role,
    ...(input.agentId && { agentId: input.agentId }),
  };
  // A lifecycle event is about one span: `request.retry_scheduled` cancels the request it
  // is attributed to, so it resolves only when the scope names exactly one open request.
  // Content events keep the permissive lookup — overlapping tool-loop calls are expected
  // there and the in-flight one is the request being written to.
  const existing = isLifecycleRequestEvent(input.type)
    ? registry.resolveUnique(threadId, scope)
    : registry.resolve(threadId, scope);
  if (existing) {
    return existing;
  }
  if (input.role === "thinking") {
    const plannerRequestId = registry.resolve(threadId, {
      role: "main",
      ...(input.agentId && { agentId: input.agentId }),
    });
    if (plannerRequestId) {
      return plannerRequestId;
    }
  }
  return undefined;
}

/**
 * Event types that describe the fate of one request rather than its content.
 *
 * `request.started` never reaches the registry (Bridge owns started spans); the rest of the
 * lifecycle is what marks a span completed, failed or retried.
 */
function isLifecycleRequestEvent(type: string): boolean {
  return type.startsWith("request.") || type === "thread.api_error";
}

/**
 * PI usage.recorded may arrive after lifecycle finalize — prefer active, else newest
 * finalized tombstone.
 *
 * Resolution order (fail closed at each step — never mix a different agent's request):
 * 1. Strict agent-scoped match (registry entries stamped with the event's agentId).
 * 2. Active role-only match — bridge entries are commonly created without an agentId,
 *    so an agentId on the event alone must not disqualify the unstamped entry.
 * 3. Newest finalized tombstone for the role — stamped with the agent first, else unstamped.
 */
export function resolvePiUsageLogicalRequestId(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  input: { role: string; agentId?: string },
): string | undefined {
  const agentId = input.agentId?.trim();
  const role = input.role.trim();
  if (agentId) {
    const strict = registry.resolve(threadId, { role, agentId });
    if (strict) {
      return strict;
    }
  }
  const byRole = registry.resolve(threadId, { role });
  if (byRole) {
    return byRole;
  }
  const finalized = registry.listFinalized(threadId).filter((entry) => entry.role === role);
  const stamped = agentId ? finalized.filter((entry) => entry.agentId === agentId) : [];
  const pool = stamped.length > 0 ? stamped : finalized.filter((entry) => !entry.agentId);
  return pool.at(-1)?.logicalRequestId;
}

/** Only Bridge-emitted request.started (explicit extras logical id) may persist a shadow event. */
export function shouldPersistRequestStartedShadowEvent(input: {
  eventType: string;
  bridgeLogicalRequestId?: string;
}): boolean {
  if (input.eventType !== "request.started") {
    return true;
  }
  return Boolean(input.bridgeLogicalRequestId?.trim());
}

export function shouldEmitRetryScheduledCancellation(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  requestId: string | undefined,
): requestId is string {
  const trimmed = requestId?.trim();
  if (!trimmed) {
    return false;
  }
  return registry.hasActiveRequestId(threadId, trimmed);
}

export function isGatewayAttemptConnectionDiagnostic(input: {
  eventType: string;
  activityOrigin?: string;
}): boolean {
  return input.eventType === "api.error" && input.activityOrigin === GATEWAY_ATTEMPT_CONNECTION_ERROR_ORIGIN;
}

/**
 * SDK shadow terminals for request spans.
 *
 * Thinking/reasoning is a content block inside one upstream request (Cherry /
 * Anthropic streaming model): `thinking.final` must NOT close the span, or later
 * `message.*` events lose `requestId` and tok/s timing collapses to the thinking
 * window. Prefer Bridge/`onLogicalCompleted` as the authority; fall back to
 * `message.final` / `api.error` when the SDK path needs a local terminal.
 */
export function shouldEmitSdkShadowRequestTerminal(input: {
  eventType: string;
  activityOrigin?: string;
}): boolean {
  if (isGatewayAttemptConnectionDiagnostic(input)) {
    return false;
  }
  return input.eventType === "message.final" || input.eventType === "api.error";
}

export interface GatewayUpstreamConnectionErrorInput {
  threadId: string;
  logicalRequestId: string;
  statusCode?: number;
  eventRole?: string;
}

/** Named-field adapter — never treat statusCode as a request id. */
export function resolveConnectionErrorLogicalRequestId(input: GatewayUpstreamConnectionErrorInput): string {
  return input.logicalRequestId.trim();
}

export function shouldEmitUpstreamConnectionErrorActivity(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  logicalRequestId: string,
): boolean {
  const entry = registry.findEntryByLogicalId(threadId, logicalRequestId.trim());
  return entry?.emitTimelineActivity === true;
}

export function resolveUpstreamConnectionErrorAttribution(
  registry: ThreadLiveRequestRegistry,
  input: GatewayUpstreamConnectionErrorInput,
): FrozenLiveRequestAttribution | undefined {
  const attribution = resolveFrozenLiveRequestAttribution(
    registry,
    input.threadId,
    resolveConnectionErrorLogicalRequestId(input),
  );
  if (!attribution || attribution.emitTimelineActivity !== true) {
    return undefined;
  }
  if (!lifecycleEventRoleMatchesEntry(attribution.role, input.eventRole)) {
    return undefined;
  }
  return attribution;
}

export function shouldEmitUpstreamConnectionErrorFromLifecycle(
  registry: ThreadLiveRequestRegistry,
  input: GatewayUpstreamConnectionErrorInput,
): boolean {
  return resolveUpstreamConnectionErrorAttribution(registry, input) !== undefined;
}

export function resolveConnectionErrorDisplayRequestId(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  logicalRequestId: string,
): string | undefined {
  const entry = registry.findEntryByLogicalId(threadId, logicalRequestId.trim());
  return entry?.logicalRequestId;
}

export function recordProviderRequestIdForLogical(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  logicalRequestId: string,
  providerRequestId: string,
): boolean {
  return registry.recordProviderRequestIdByLogicalId(threadId, logicalRequestId, providerRequestId);
}

export function markBridgeRequestStartedPersisted(threadId: string, logicalRequestId: string): boolean {
  return markRequestStartedPersisted(threadId, logicalRequestId.trim());
}

export function finalizeLiveRequest(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  logicalRequestId: string,
  options?: { runAttemptId?: string },
): void {
  const trimmedLogical = logicalRequestId.trim();
  if (!trimmedLogical) {
    return;
  }
  if (!registry.moveToFinalized(threadId, trimmedLogical, options)) {
    registry.endRequest(threadId, trimmedLogical);
  }
  clearRequestStartedPersisted(threadId, trimmedLogical);
}

export function bindLogicalRequestAgentId(
  registry: ThreadLiveRequestRegistry,
  input: {
    threadId: string;
    logicalRequestId: string;
    agentId: string;
    role?: string;
  },
): BindLogicalAgentIdResult {
  return registry.bindAgentId(input.threadId, input.logicalRequestId, {
    agentId: input.agentId,
    ...(input.role ? { role: input.role } : {}),
  });
}

export type LogicalRequestLateBindStore = {
  attributeThreadRunEventsByLogicalRequestId(
    threadId: string,
    logicalRequestId: string,
    input: { agentId: string; role?: string },
  ): { updated: number; conflict: boolean };
};

export type ExactLogicalRequestLateBindResult =
  | {
      ok: true;
      bound: boolean;
      updated: number;
      emitTimelineActivity: boolean;
      agentId: string;
      role: string;
      logicalRequestId: string;
      source: "active" | "finalized";
    }
  | {
      ok: false;
      reason: "empty" | "missing" | "role_conflict" | "agent_conflict" | "db_conflict";
    };

/**
 * Fail-closed late bind across registry + ConversationStore.
 *
 * Order (sync, main-process single-threaded):
 * 1) registry.canBindAgentId — conflict/missing leaves DB untouched
 * 2) DB atomic attribute (timeline only) — conflict leaves registry untouched
 * 3) registry.bindAgentId — only after DB success (or skipped silent path)
 */
export function applyExactLogicalRequestLateBind(
  registry: ThreadLiveRequestRegistry,
  store: LogicalRequestLateBindStore,
  input: {
    threadId: string;
    logicalRequestId: string;
    agentId: string;
    role?: string;
  },
): ExactLogicalRequestLateBindResult {
  const preview = registry.canBindAgentId(input.threadId, input.logicalRequestId, {
    agentId: input.agentId,
    ...(input.role ? { role: input.role } : {}),
  });
  if (!preview.ok) {
    return preview;
  }

  let updated = 0;
  if (preview.emitTimelineActivity) {
    const patched = store.attributeThreadRunEventsByLogicalRequestId(input.threadId, input.logicalRequestId, {
      agentId: input.agentId,
      ...(input.role ? { role: input.role } : {}),
    });
    if (patched.conflict) {
      return { ok: false, reason: "db_conflict" };
    }
    updated = patched.updated;
  }

  const bind = registry.bindAgentId(input.threadId, input.logicalRequestId, {
    agentId: input.agentId,
    ...(input.role ? { role: input.role } : {}),
  });
  if (!bind.ok) {
    // Invariant under sync main: canBind passed and no registry mutation between steps.
    return bind;
  }
  return {
    ok: true,
    bound: bind.bound,
    updated,
    emitTimelineActivity: bind.emitTimelineActivity,
    agentId: bind.agentId,
    role: bind.role,
    logicalRequestId: bind.logicalRequestId,
    source: bind.source,
  };
}

/** Resolve logical id before registry removal, then finalize. */
export function finalizeDisplayRequestTerminal(
  registry: ThreadLiveRequestRegistry,
  threadId: string,
  logicalRequestId: string,
  options?: { runAttemptId?: string },
): string | undefined {
  const trimmed = logicalRequestId.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!registry.resolveLogicalRequestId(threadId, trimmed)) {
    return undefined;
  }
  finalizeLiveRequest(registry, threadId, trimmed, options);
  return trimmed;
}

export interface LogicalRequestTerminalInput {
  threadId: string;
  logicalRequestId: string;
  stage: RequestTerminalStage;
  detail?: string;
  /** Gateway event role for consistency check only — must match frozen entry role. */
  eventRole?: string;
  runAttemptId?: string;
}

export type EmitLogicalRequestTerminalUi = (input: {
  threadId: string;
  role: string;
  agentId?: string;
  /** Always the immutable logical request id. */
  displayRequestId: string;
  providerRequestId?: string;
  stage: RequestTerminalStage;
  detail?: string;
}) => void;

export type LogicalRequestTerminalResult =
  | { ok: true }
  | { ok: false; reason: "empty_logical_id" | "missing_entry" | "role_conflict" };

/** Gateway logical terminal — emitUi is UI-only; registry cleanup always runs here. */
export function applyLogicalRequestTerminal(
  registry: ThreadLiveRequestRegistry,
  input: LogicalRequestTerminalInput,
  emitUi?: EmitLogicalRequestTerminalUi,
): LogicalRequestTerminalResult {
  const trimmedLogical = input.logicalRequestId.trim();
  if (!trimmedLogical) {
    return { ok: false, reason: "empty_logical_id" };
  }
  const entry = registry.findEntryByLogicalId(input.threadId, trimmedLogical);
  if (!entry) {
    return { ok: false, reason: "missing_entry" };
  }
  if (!lifecycleEventRoleMatchesEntry(entry.role, input.eventRole)) {
    return { ok: false, reason: "role_conflict" };
  }
  try {
    if (entry.emitTimelineActivity && emitUi) {
      emitUi({
        threadId: input.threadId,
        role: entry.role,
        ...(entry.agentId ? { agentId: entry.agentId } : {}),
        displayRequestId: entry.logicalRequestId,
        ...(entry.providerRequestId ? { providerRequestId: entry.providerRequestId } : {}),
        stage: input.stage,
        ...(input.detail ? { detail: input.detail } : {}),
      });
    }
  } finally {
    finalizeLiveRequest(registry, input.threadId, trimmedLogical, {
      ...(input.runAttemptId ? { runAttemptId: input.runAttemptId } : {}),
    });
  }
  return { ok: true };
}
