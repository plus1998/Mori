import type { ParsedUsage } from "@eco/runtime";
import type { UpstreamApiCompat } from "../shared/api-compat";
import type { BillingUsageSource, RuntimeAgentRole } from "../shared/ipc";
import { shouldUpdateContextFromUsageSource } from "./billing-orchestration";
import type { RuntimeRoute } from "./billing-resolver";
import type { UpstreamProxyCallBilling } from "./upstream-proxy-log";
import {
  type CodexApiRatesLookup,
  resolveSingleUsageBillingArtifacts,
  type UsageBillingPricingLookup,
} from "./usage-billing-artifacts";
import type { ApplySingleUsageBillingEffectsInput } from "./usage-billing-effects";

/** Billing request — carries normalized {@link ParsedUsage} from the boundary; do not flatten token fields. */
export interface SingleUsageBillingRequest {
  threadId: string;
  role: RuntimeAgentRole;
  usage: ParsedUsage;
  agentId?: string;
  source?: BillingUsageSource;
  /** When set, overrides {@link ParsedUsage.totalCostUsd} for reported-cost billing. */
  sourceReportedCostUsd?: number;
  /** Routing/pricing model override; merged onto `usage.modelId` for artifact resolution. */
  modelId?: string;
  messageId?: string;
  runAttemptId?: string;
  plannerAgentId?: string;
  parentToolUseId?: string;
  requestKey?: string;
  sourceEventId?: string;
  providerRequestId?: string;
  sourceDedupId?: string;
  updateContext?: boolean;
  reconciliationOnly?: boolean;
  fillSdkPrimaryForSubagent?: boolean;
  routeRole?: RuntimeAgentRole;
  attributionPending?: boolean;
  aliasModelId?: string;
  providerId?: string;
  /** Aggregate usage has no individual request sizes for long-context tier selection. */
  codexUsageIsAggregate?: boolean;
  apiCompat?: UpstreamApiCompat;
  /** Gateway-measured time to first upstream response chunk (ms), new-api TTFT. */
  ttftMs?: number;
  /** Gateway-measured first-chunk → stream-end window (ms), new-api generationMs. */
  generationMs?: number;
  /** Gateway-measured network RTT estimate (ms): upstream start → first headers. */
  firstHeadersMs?: number;
  /** Gateway-measured time to first text token delta (ms): upstream start → first content token. */
  firstTokenMs?: number;
  /** Bridge logical request id for joining multi-invocation usage onto one feed span. */
  logicalRequestId?: string;
}

export interface ResolveSingleUsageBillingOrchestrationInput {
  request: SingleUsageBillingRequest;
  runtimeRoutes: readonly RuntimeRoute[];
  lookupPricing: UsageBillingPricingLookup;
  lookupCodexApiRates?: CodexApiRatesLookup;
  codexPlannerModelId?: string;
}

export interface SingleUsageBillingOrchestration {
  requestBillingLog: UpstreamProxyCallBilling;
  effectsInput: ApplySingleUsageBillingEffectsInput;
}

export function resolveBillingUsage(request: SingleUsageBillingRequest): ParsedUsage {
  return {
    ...request.usage,
    ...(request.modelId && { modelId: request.modelId }),
  };
}

export async function resolveSingleUsageBillingOrchestration(
  input: ResolveSingleUsageBillingOrchestrationInput,
): Promise<SingleUsageBillingOrchestration | null> {
  const { request } = input;
  const usage = resolveBillingUsage(request);
  const sourceReportedCostUsd = request.sourceReportedCostUsd ?? usage.totalCostUsd;

  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheReadTokens === 0 &&
    usage.cacheCreationTokens === 0 &&
    sourceReportedCostUsd === undefined
  ) {
    return null;
  }

  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: request.threadId,
    role: request.role,
    usage,
    runtimeRoutes: input.runtimeRoutes,
    lookupPricing: input.lookupPricing,
    ...(input.lookupCodexApiRates && { lookupCodexApiRates: input.lookupCodexApiRates }),
    ...(input.codexPlannerModelId && { codexPlannerModelId: input.codexPlannerModelId }),
    ...(request.source && { source: request.source }),
    ...(sourceReportedCostUsd !== undefined && { sourceReportedCostUsd }),
    ...(request.modelId && { modelId: request.modelId }),
    ...(request.messageId && { messageId: request.messageId }),
    ...(request.runAttemptId && { runAttemptId: request.runAttemptId }),
    ...(request.plannerAgentId && { plannerAgentId: request.plannerAgentId }),
    ...(request.agentId && { agentId: request.agentId }),
    ...(request.parentToolUseId && { parentToolUseId: request.parentToolUseId }),
    ...(request.requestKey && { requestKey: request.requestKey }),
    ...(request.sourceEventId && { sourceEventId: request.sourceEventId }),
    ...(request.providerRequestId && { providerRequestId: request.providerRequestId }),
    ...(request.sourceDedupId && { sourceDedupId: request.sourceDedupId }),
    ...(request.routeRole && { routeRole: request.routeRole }),
    ...(request.attributionPending && { attributionPending: true }),
    ...(request.aliasModelId && { aliasModelId: request.aliasModelId }),
    ...(request.providerId && { providerId: request.providerId }),
    ...(request.ttftMs !== undefined && request.ttftMs > 0 && { ttftMs: request.ttftMs }),
    ...(request.generationMs !== undefined &&
      request.generationMs > 0 && { generationMs: request.generationMs }),
    ...(request.firstHeadersMs !== undefined &&
      request.firstHeadersMs > 0 && { firstHeadersMs: request.firstHeadersMs }),
    ...(request.firstTokenMs !== undefined &&
      request.firstTokenMs > 0 && { firstTokenMs: request.firstTokenMs }),
    ...(request.logicalRequestId?.trim() && { logicalRequestId: request.logicalRequestId.trim() }),
  });
  const updateContext =
    request.updateContext ?? shouldUpdateContextFromUsageSource(request.source, request.role);

  return {
    requestBillingLog: artifacts.requestBillingLog,
    effectsInput: {
      threadId: request.threadId,
      artifacts,
      updateContext,
      ...(request.agentId && { agentId: request.agentId }),
      ...(request.messageId && { messageId: request.messageId }),
      ...(sourceReportedCostUsd !== undefined && { sourceReportedCostUsd }),
      ...(request.reconciliationOnly && { reconciliationOnly: true }),
      ...(request.fillSdkPrimaryForSubagent && { fillSdkPrimaryForSubagent: true }),
    },
  };
}
