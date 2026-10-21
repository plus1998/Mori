import type { GatewayCodexRequestKind, GatewayUsageEvent } from "@eco/gateway";
import {
  type CodexThreadAttribution,
  computeWindowOccupancy,
  type ParsedUsage,
  parseCodexGatewayModelAlias,
} from "@eco/runtime";
import type { RuntimeAgentRole } from "../shared/ipc";
import { resolvePriceMultiplier } from "../shared/manual-spec-pricing";
import type { UsageBillingObservation } from "./billing-orchestration";
import type { RuntimeRoute } from "./billing-resolver";
import type { SingleUsageBillingRequest } from "./single-usage-billing-orchestration";
import { normalizeTelemetryBillingRole } from "./telemetry-billing-role";

export interface ResolveCodexGatewayUsageBillingInput {
  event: GatewayUsageEvent;
  /** Resolve only from the persisted Codex thread map; never infer from active routes. */
  resolveThreadAttribution: (codexThreadId: string) => CodexThreadAttribution | undefined;
  resolveParentCodexThreadId: (codexThreadId: string) => string | undefined;
  resolveRuntimeRoutes: (threadId: string) => readonly RuntimeRoute[];
  runAttemptId?: (threadId: string) => string | undefined;
  plannerAgentId?: (threadId: string) => string | undefined;
}

export interface CodexGatewayUsageBillingResolution {
  status: "resolved";
  threadId: string;
  codexThreadId: string;
  turnId: string;
  requestKind: GatewayCodexRequestKind;
  billingRole: RuntimeAgentRole;
  routeRole: RuntimeAgentRole;
  contextOccupied: number;
  requestKey: string;
  usage: ParsedUsage;
  observation: UsageBillingObservation;
  billingInput: SingleUsageBillingRequest;
  subagentAgentId?: string;
}

export type CodexGatewayUsageBillingRejectionReason =
  | "missing_turn_metadata"
  | "invalid_source_event_id"
  | "invalid_provider_or_model"
  | "thread_attribution_not_found"
  | "thread_attribution_mismatch"
  | "runtime_routes_unavailable"
  | "route_not_found"
  | "ambiguous_route";

export interface CodexGatewayUsageBillingRejection {
  status: "rejected";
  reason: CodexGatewayUsageBillingRejectionReason;
  codexThreadId?: string;
  turnId?: string;
  matchedRouteCount?: number;
}

export type CodexGatewayUsageBillingResult =
  | CodexGatewayUsageBillingResolution
  | CodexGatewayUsageBillingRejection;

export function resolveCodexGatewayUsageBilling(
  input: ResolveCodexGatewayUsageBillingInput,
): CodexGatewayUsageBillingResult {
  const turnMetadata = input.event.codexTurnMetadata;
  const codexThreadId = turnMetadata?.threadId.trim();
  const turnId = turnMetadata?.turnId.trim();
  if (!turnMetadata || !codexThreadId || !turnId) {
    return { status: "rejected", reason: "missing_turn_metadata" };
  }

  const providerId = input.event.providerId.trim();
  const sourceEventId = input.event.sourceEventId.trim();
  if (!sourceEventId) {
    return {
      status: "rejected",
      reason: "invalid_source_event_id",
      codexThreadId,
      turnId,
    };
  }
  const requestedModel = input.event.requestedModel.trim();
  const alias = parseCodexGatewayModelAlias(requestedModel);
  const eventUpstreamModelId = input.event.upstreamModelId.trim();
  const modelId =
    alias?.upstreamModelId || eventUpstreamModelId || input.event.usage.modelId?.trim() || requestedModel;

  if (
    !providerId ||
    !modelId ||
    (alias !== undefined && alias.providerId !== providerId) ||
    (alias !== undefined && eventUpstreamModelId !== "" && alias.upstreamModelId !== eventUpstreamModelId)
  ) {
    return {
      status: "rejected",
      reason: "invalid_provider_or_model",
      codexThreadId,
      turnId,
    };
  }

  const attribution = input.resolveThreadAttribution(codexThreadId);
  if (!attribution?.ecoThreadId.trim()) {
    return {
      status: "rejected",
      reason: "thread_attribution_not_found",
      codexThreadId,
      turnId,
    };
  }
  const threadId = attribution.ecoThreadId.trim();
  const subagentAgentId = attribution.agentId?.trim();
  const declaredParentThreadId = turnMetadata.parentThreadId?.trim();
  const rawPersistedParentThreadId = input.resolveParentCodexThreadId(codexThreadId)?.trim();
  const persistedParentThreadId =
    rawPersistedParentThreadId === codexThreadId ? undefined : rawPersistedParentThreadId;
  const rootAttributionMismatch = Boolean(declaredParentThreadId) || Boolean(persistedParentThreadId);
  const childAttributionMismatch =
    !declaredParentThreadId ||
    !persistedParentThreadId ||
    declaredParentThreadId !== persistedParentThreadId ||
    subagentAgentId !== codexThreadId;
  if (attribution.isSubagentThread ? childAttributionMismatch : rootAttributionMismatch) {
    return {
      status: "rejected",
      reason: "thread_attribution_mismatch",
      codexThreadId,
      turnId,
    };
  }

  let routes: readonly RuntimeRoute[];
  try {
    routes = input.resolveRuntimeRoutes(threadId);
  } catch {
    return {
      status: "rejected",
      reason: "runtime_routes_unavailable",
      codexThreadId,
      turnId,
    };
  }

  const billingRole = normalizeTelemetryBillingRole(attribution.billingRole);
  const routeSelection = selectExactPricingRoute(routes, {
    providerId: alias?.providerId ?? providerId,
    modelId,
    requestedModel,
    billingRole,
    ...(alias?.apiCompat && { apiCompat: alias.apiCompat }),
  });
  if (routeSelection.status === "rejected") {
    return {
      ...routeSelection,
      codexThreadId,
      turnId,
    };
  }
  const routeRole = normalizeTelemetryBillingRole(routeSelection.route.role);

  const usage: ParsedUsage = {
    ...input.event.usage,
    modelId,
  };
  const requestKey = buildCodexGatewayUsageRequestKey({
    threadId,
    codexThreadId,
    turnId,
    requestKind: turnMetadata.requestKind,
    role: billingRole,
    modelId,
    providerId: alias?.providerId ?? providerId,
    apiCompat: routeSelection.route.apiCompat,
    sourceEventId,
  });
  const contextOccupied = computeWindowOccupancy(usage);
  const runAttemptId = input.runAttemptId?.(threadId);
  const plannerAgentId =
    input.plannerAgentId?.(threadId) ??
    (!subagentAgentId && turnMetadata.requestKind !== "turn"
      ? `main:codex-control:${threadId}`
      : undefined);
  const providerRequestId = input.event.providerRequestId ?? input.event.responseId;

  return {
    status: "resolved",
    threadId,
    codexThreadId,
    turnId,
    requestKind: turnMetadata.requestKind,
    billingRole,
    routeRole,
    contextOccupied,
    requestKey,
    usage,
    observation: {
      source: "codex",
      role: billingRole,
      usage,
      requestKey,
      modelId,
      ...(subagentAgentId && { agentId: subagentAgentId }),
    },
    billingInput: {
      threadId,
      role: billingRole,
      source: "codex",
      usage,
      modelId,
      requestKey,
      sourceEventId,
      sourceDedupId: sourceEventId,
      updateContext: turnMetadata.requestKind !== "compaction",
      fillSdkPrimaryForSubagent: false,
      routeRole,
      aliasModelId: requestedModel,
      providerId: alias?.providerId ?? providerId,
      ...(routeSelection.route.apiCompat && { apiCompat: routeSelection.route.apiCompat }),
      ...(providerRequestId && { providerRequestId }),
      ...(runAttemptId && { runAttemptId }),
      ...(plannerAgentId && { plannerAgentId }),
      ...(input.event.usage.totalCostUsd !== undefined && {
        sourceReportedCostUsd: input.event.usage.totalCostUsd,
      }),
      ...(subagentAgentId && { agentId: subagentAgentId }),
    },
    ...(subagentAgentId && { subagentAgentId }),
  };
}

function selectExactPricingRoute(
  routes: readonly RuntimeRoute[],
  input: {
    providerId: string;
    modelId: string;
    requestedModel: string;
    billingRole: RuntimeAgentRole;
    apiCompat?: RuntimeRoute["apiCompat"];
  },
):
  | { status: "resolved"; route: RuntimeRoute }
  | {
      status: "rejected";
      reason: "route_not_found" | "ambiguous_route";
      matchedRouteCount: number;
    } {
  const matchingRoutes = routes.filter((route) => routeMatchesGatewayUsage(route, input));
  if (matchingRoutes.length === 0) {
    return { status: "rejected", reason: "route_not_found", matchedRouteCount: 0 };
  }

  const roleMatches = matchingRoutes.filter(
    (route) => normalizeTelemetryBillingRole(route.role) === input.billingRole,
  );
  if (roleMatches.length === 1) {
    const route = roleMatches[0];
    if (!route) {
      throw new Error("Expected one exact role route after length validation.");
    }
    return { status: "resolved", route };
  }
  if (roleMatches.length > 1) {
    const route = selectEquivalentPricingRoute(roleMatches);
    if (route) {
      return { status: "resolved", route };
    }
    return {
      status: "rejected",
      reason: "ambiguous_route",
      matchedRouteCount: roleMatches.length,
    };
  }
  if (matchingRoutes.length === 1) {
    const route = matchingRoutes[0];
    if (!route) {
      throw new Error("Expected one exact pricing route after length validation.");
    }
    return { status: "resolved", route };
  }
  const equivalentRoute = selectEquivalentPricingRoute(matchingRoutes);
  if (equivalentRoute) {
    return { status: "resolved", route: equivalentRoute };
  }
  return {
    status: "rejected",
    reason: "ambiguous_route",
    matchedRouteCount: matchingRoutes.length,
  };
}

function selectEquivalentPricingRoute(routes: readonly RuntimeRoute[]): RuntimeRoute | undefined {
  const first = routes[0];
  if (!first) {
    return undefined;
  }
  const signature = pricingRouteSignature(first);
  return routes.every((route) => pricingRouteSignature(route) === signature) ? first : undefined;
}

function pricingRouteSignature(route: RuntimeRoute): string {
  const manualSpec = route.manualSpec;
  const hasManualRates = manualSpec?.inputPerM !== undefined && manualSpec.outputPerM !== undefined;
  return JSON.stringify({
    providerBaseUrl: route.provider.baseUrl.trim(),
    modelId: route.modelId.trim(),
    modelsDevMapping: route.modelsDevMapping
      ? {
          providerKey: route.modelsDevMapping.providerKey.trim(),
          modelId: route.modelsDevMapping.modelId.trim(),
        }
      : null,
    manualRates: hasManualRates
      ? {
          inputPerM: manualSpec.inputPerM,
          outputPerM: manualSpec.outputPerM,
          cacheReadPerM: manualSpec.cacheReadPerM ?? null,
          cacheWritePerM: manualSpec.cacheWritePerM ?? null,
        }
      : null,
    priceMultiplier: resolvePriceMultiplier(manualSpec),
  });
}

function routeMatchesGatewayUsage(
  route: RuntimeRoute,
  input: {
    providerId: string;
    modelId: string;
    requestedModel: string;
    apiCompat?: RuntimeRoute["apiCompat"];
  },
): boolean {
  if (input.apiCompat !== undefined && route.apiCompat !== input.apiCompat) {
    return false;
  }
  return (
    route.provider.id === input.providerId &&
    (route.modelId === input.modelId || route.modelId === input.requestedModel)
  );
}

export function buildCodexGatewayUsageRequestKey(input: {
  threadId: string;
  codexThreadId: string;
  turnId: string;
  requestKind: GatewayCodexRequestKind;
  role: RuntimeAgentRole;
  modelId: string;
  providerId: string;
  apiCompat?: RuntimeRoute["apiCompat"];
  sourceEventId: string;
}): string {
  return [
    "codex-gateway",
    input.threadId,
    input.codexThreadId,
    input.turnId,
    input.requestKind,
    input.role,
    input.modelId,
    input.providerId,
    input.apiCompat ?? "default",
    input.sourceEventId,
  ].join(":");
}

export interface CodexGatewayUsageDeduplicationInput {
  requestKey: string;
  usage: ParsedUsage;
  providerRequestId?: string;
  sourceReportedCostUsd?: number;
}

export type CodexGatewayUsageDeduplicationResult =
  | { status: "accepted" }
  | { status: "duplicate" }
  | { status: "conflict"; reason: "usage_payload_mismatch" };

/**
 * Guards the in-process side effects that sit in front of the persistent ledger.
 * The stable request key handles normal retries; a changed payload for the same
 * upstream identity is surfaced as a conflict instead of creating shadow drift.
 */
export class CodexGatewayUsageDeduplicator {
  private readonly payloadByRequestKey = new Map<string, string>();

  constructor(private readonly maxEntries = 20_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("Codex Gateway usage deduplicator maxEntries must be a positive integer.");
    }
  }

  observe(input: CodexGatewayUsageDeduplicationInput): CodexGatewayUsageDeduplicationResult {
    const requestKey = input.requestKey.trim();
    if (!requestKey) {
      throw new Error("Codex Gateway usage deduplication requires requestKey.");
    }
    const fingerprint = codexGatewayUsagePayloadFingerprint(input);
    const existing = this.payloadByRequestKey.get(requestKey);
    if (existing !== undefined) {
      return existing === fingerprint
        ? { status: "duplicate" }
        : { status: "conflict", reason: "usage_payload_mismatch" };
    }

    this.payloadByRequestKey.set(requestKey, fingerprint);
    while (this.payloadByRequestKey.size > this.maxEntries) {
      const oldest = this.payloadByRequestKey.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.payloadByRequestKey.delete(oldest);
    }
    return { status: "accepted" };
  }

  clear(): void {
    this.payloadByRequestKey.clear();
  }

  forget(requestKey: string): void {
    this.payloadByRequestKey.delete(requestKey.trim());
  }
}

function codexGatewayUsagePayloadFingerprint(input: CodexGatewayUsageDeduplicationInput): string {
  return JSON.stringify([
    input.usage.inputTokens,
    input.usage.outputTokens,
    input.usage.cacheReadTokens,
    input.usage.cacheCreationTokens,
    input.usage.reasoningTokens ?? null,
    input.usage.modelId ?? null,
    input.providerRequestId ?? null,
    input.sourceReportedCostUsd ?? null,
  ]);
}
