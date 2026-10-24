import {
  computeRequestBilling,
  computeSavings,
  type ModelCostRates,
  type ModelPricingLookup,
  type ParsedUsage,
  type RequestBillingDelta,
} from "@eco/runtime";
import type { BillingUsageSource, ModelsDevMapping, RouteManualSpec, RuntimeAgentRole } from "../shared/ipc";
import {
  buildPlannerModelLabel,
  type ResolvedUsageRoute,
  type RuntimeRoute,
  resolvePublicModelId,
  resolveRatesForRoute,
  resolveUsageRoute,
} from "./billing-resolver";
import {
  PROXY_PENDING_ATTRIBUTION_REASON,
  PROXY_PENDING_PARENT_UNMAPPED_REASON,
  USAGE_LEDGER_ALIAS_MODEL_ID_METADATA_KEY,
  USAGE_LEDGER_BILLING_ROLE_METADATA_KEY,
  USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY,
  USAGE_LEDGER_PROVIDER_ID_METADATA_KEY,
  USAGE_LEDGER_ROUTE_ROLE_METADATA_KEY,
} from "./proxy-usage-pending-settlement";
import { buildUsageRequestKey } from "./thread-usage-accumulator";
import type { UpstreamProxyCallBilling } from "./upstream-proxy-log";
import type { UsageAttribution, UsageLedgerEvent } from "./usage-ledger";
import { buildSingleUsageLedgerEvent } from "./usage-ledger-adapters";
import {
  USAGE_LEDGER_FIRST_HEADERS_MS_METADATA_KEY,
  USAGE_LEDGER_FIRST_TOKEN_MS_METADATA_KEY,
  USAGE_LEDGER_GENERATION_MS_METADATA_KEY,
  USAGE_LEDGER_LOGICAL_REQUEST_ID_METADATA_KEY,
  USAGE_LEDGER_TTFT_MS_METADATA_KEY,
} from "./usage-ledger-cost-metadata";

export interface UsageBillingPricingRoute {
  provider: { baseUrl: string; authMethod?: string };
  modelId: string;
  modelsDevMapping?: ModelsDevMapping;
  manualSpec?: RouteManualSpec;
}

export type UsageBillingPricingLookup = (
  route: UsageBillingPricingRoute,
  usage?: ParsedUsage,
  isAggregate?: boolean,
) => Promise<ModelPricingLookup | null>;

function resolveUsageRates(
  lookup: ModelPricingLookup | null,
  route?: UsageBillingPricingRoute,
): ModelCostRates | null {
  if (route?.provider.authMethod === "chatgpt_subscription") return lookup?.rates ?? null;
  return resolveRatesForRoute(lookup, route?.manualSpec);
}

export type CodexApiRatesLookup = (modelId: string, usage: ParsedUsage) => Promise<ModelCostRates | null>;

export interface UsageBillingContextUpdate {
  role: RuntimeAgentRole;
  modelId: string;
  providerBaseUrl: string;
  modelsDevMapping?: ModelsDevMapping;
  manualSpec?: RouteManualSpec;
}

export interface SingleUsageBillingArtifacts {
  delta: ParsedUsage;
  source: BillingUsageSource;
  billingRole: RuntimeAgentRole;
  requestKey: string;
  requestBilling: RequestBillingDelta;
  requestBillingLog: UpstreamProxyCallBilling;
  actualRates: ModelCostRates | null;
  plannerRates: ModelCostRates | null;
  ledgerEvent: UsageLedgerEvent;
  parsedUsage: ParsedUsage;
  plannerModelLabel?: string;
  resolvedModelId?: string;
  contextUpdate?: UsageBillingContextUpdate;
}

export interface ResolveSingleUsageBillingArtifactsInput {
  threadId: string;
  role: RuntimeAgentRole;
  usage: ParsedUsage;
  runtimeRoutes: readonly RuntimeRoute[];
  lookupPricing: UsageBillingPricingLookup;
  lookupCodexApiRates?: CodexApiRatesLookup;
  codexPlannerModelId?: string;
  source?: BillingUsageSource;
  sourceReportedCostUsd?: number;
  modelId?: string;
  messageId?: string;
  runAttemptId?: string;
  plannerAgentId?: string;
  agentId?: string;
  parentToolUseId?: string;
  requestKey?: string;
  sourceEventId?: string;
  providerRequestId?: string;
  sourceDedupId?: string;
  routeRole?: RuntimeAgentRole;
  attributionPending?: boolean;
  aliasModelId?: string;
  providerId?: string;
  ttftMs?: number;
  generationMs?: number;
  firstHeadersMs?: number;
  firstTokenMs?: number;
  logicalRequestId?: string;
}

export async function resolveSingleUsageBillingArtifacts(
  input: ResolveSingleUsageBillingArtifactsInput,
): Promise<SingleUsageBillingArtifacts> {
  const source = input.source ?? "sdk";
  const plannerRoute = input.runtimeRoutes.find((route) => route.role === "main");

  let usageRoute: ResolvedUsageRoute | undefined;
  let billingRole: RuntimeAgentRole;
  let resolvedModelId: string | undefined;

  if (source === "proxy") {
    billingRole = input.role;
    resolvedModelId = input.modelId?.trim() || undefined;
    const roleRoute = input.runtimeRoutes.find((route) => route.role === billingRole);
    usageRoute = roleRoute
      ? {
          role: roleRoute.role,
          provider: roleRoute.provider,
          modelId: roleRoute.modelId,
          ...(roleRoute.modelsDevMapping && { modelsDevMapping: roleRoute.modelsDevMapping }),
          ...(roleRoute.manualSpec && { manualSpec: roleRoute.manualSpec }),
        }
      : undefined;
  } else {
    const pricingRole = input.routeRole ?? input.role;
    usageRoute = resolveUsageRoute(pricingRole, input.modelId, input.runtimeRoutes);
    resolvedModelId = resolvePublicModelId(pricingRole, input.modelId, input.runtimeRoutes) ?? input.modelId;
    billingRole = input.routeRole ? input.role : (usageRoute?.role ?? input.role);
  }

  const actualLookup = usageRoute
    ? await input.lookupPricing(
        usageRoute.provider.authMethod === "chatgpt_subscription"
          ? { ...usageRoute, modelId: resolvedModelId ?? usageRoute.modelId }
          : usageRoute,
        input.usage,
        source !== "proxy",
      )
    : null;
  const plannerLookup = plannerRoute
    ? await input.lookupPricing(plannerRoute, input.usage, source !== "proxy")
    : null;
  let actualRates = resolveUsageRates(actualLookup, usageRoute);
  let plannerRates = resolveUsageRates(plannerLookup, plannerRoute);
  // Account usage uses the same manually refreshed official Standard prices as
  // the model list. Unknown prices stay unresolved, including cached-token rates.
  if (source === "codex" && input.providerId === "openai") {
    const pricingModelId = input.modelId ?? resolvedModelId;
    actualRates =
      pricingModelId && input.lookupCodexApiRates
        ? await input.lookupCodexApiRates(pricingModelId, input.usage)
        : null;
  }
  if (input.codexPlannerModelId) {
    plannerRates = input.lookupCodexApiRates
      ? await input.lookupCodexApiRates(input.codexPlannerModelId, input.usage)
      : null;
  }
  const requestKey =
    input.requestKey ??
    buildUsageRequestKey({
      role: input.role,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheCreationTokens: input.usage.cacheCreationTokens,
      ...(input.modelId && { modelId: input.modelId }),
      ...(input.sourceDedupId && { dedupId: input.sourceDedupId }),
    });

  const requestBilling = computeRequestBilling(input.usage, actualRates, plannerRates);
  const { savedUsd } = computeSavings(requestBilling.plannerTokenCostUsd, requestBilling.ecoCostUsd);
  const ledgerAgentId =
    input.agentId ?? (!input.attributionPending && billingRole === "main" ? input.plannerAgentId : undefined);
  const pendingAttributionReason = input.parentToolUseId
    ? PROXY_PENDING_PARENT_UNMAPPED_REASON
    : PROXY_PENDING_ATTRIBUTION_REASON;
  const ledgerAttribution: UsageAttribution | undefined =
    source === "proxy" && input.attributionPending && !ledgerAgentId
      ? { status: "pending", reason: pendingAttributionReason }
      : undefined;
  const parsedUsage: ParsedUsage = {
    ...input.usage,
    ...(resolvedModelId && { modelId: resolvedModelId }),
  };
  const plannerModelLabel = buildPlannerModelLabel(
    plannerRoute,
    plannerLookup?.displayName ?? plannerRoute?.modelId,
  );
  const contextUpdate = resolveSingleUsageContextUpdate({
    billingRole,
    runtimeRoutes: input.runtimeRoutes,
    ...(resolvedModelId && { resolvedModelId }),
    ...(usageRoute && { usageRoute }),
    ...(plannerRoute && { plannerRoute }),
  });

  return {
    delta: input.usage,
    source,
    billingRole,
    requestKey,
    requestBilling,
    requestBillingLog: {
      ecoCostUsd: requestBilling.ecoCostUsd,
      plannerTokenCostUsd: requestBilling.plannerTokenCostUsd,
      savedUsd,
      sourceReportedCostUsd: input.sourceReportedCostUsd ?? 0,
    },
    actualRates,
    plannerRates,
    ledgerEvent: buildSingleUsageLedgerEvent({
      threadId: input.threadId,
      role: billingRole,
      source,
      sourceEventId: input.sourceEventId ?? requestKey,
      usageKind: source === "sdk" && input.messageId ? "assistant_fallback" : "request_final",
      usage: input.usage,
      computedBilling: requestBilling,
      requestKey,
      ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
      ...(ledgerAgentId && { agentId: ledgerAgentId }),
      ...(ledgerAttribution && { attribution: ledgerAttribution }),
      ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
      ...(input.providerRequestId && { providerRequestId: input.providerRequestId }),
      ...(input.messageId && { sdkMessageId: input.messageId }),
      ...(resolvedModelId && { modelId: resolvedModelId }),
      ...(input.sourceReportedCostUsd !== undefined && { reportedCostUsd: input.sourceReportedCostUsd }),
      metadata: {
        path: "processUsageBilling",
        ...(input.routeRole && { [USAGE_LEDGER_ROUTE_ROLE_METADATA_KEY]: input.routeRole }),
        [USAGE_LEDGER_BILLING_ROLE_METADATA_KEY]: billingRole,
        ...(input.aliasModelId && { [USAGE_LEDGER_ALIAS_MODEL_ID_METADATA_KEY]: input.aliasModelId }),
        ...(input.providerId && { [USAGE_LEDGER_PROVIDER_ID_METADATA_KEY]: input.providerId }),
        ...(input.sourceDedupId && { sourceDedupId: input.sourceDedupId }),
        ...(contextUpdate && { [USAGE_LEDGER_CONTEXT_UPDATE_METADATA_KEY]: contextUpdate }),
        ...(input.ttftMs !== undefined &&
          input.ttftMs > 0 && { [USAGE_LEDGER_TTFT_MS_METADATA_KEY]: input.ttftMs }),
        ...(input.generationMs !== undefined &&
          input.generationMs > 0 && { [USAGE_LEDGER_GENERATION_MS_METADATA_KEY]: input.generationMs }),
        ...(input.firstHeadersMs !== undefined &&
          input.firstHeadersMs > 0 && { [USAGE_LEDGER_FIRST_HEADERS_MS_METADATA_KEY]: input.firstHeadersMs }),
        ...(input.firstTokenMs !== undefined &&
          input.firstTokenMs > 0 && { [USAGE_LEDGER_FIRST_TOKEN_MS_METADATA_KEY]: input.firstTokenMs }),
        ...(input.logicalRequestId?.trim() && {
          [USAGE_LEDGER_LOGICAL_REQUEST_ID_METADATA_KEY]: input.logicalRequestId.trim(),
        }),
      },
    }),
    parsedUsage,
    ...(plannerModelLabel && { plannerModelLabel }),
    ...(resolvedModelId && { resolvedModelId }),
    ...(contextUpdate && { contextUpdate }),
  };
}

export interface SdkStreamPartialBillingArtifacts {
  ledgerEvent: UsageLedgerEvent;
  resolvedModelId?: string;
  contextUpdate?: UsageBillingContextUpdate;
}

export interface ResolveSdkStreamPartialBillingArtifactsInput {
  threadId: string;
  eventId: string;
  role: RuntimeAgentRole;
  usage: ParsedUsage;
  runtimeRoutes: readonly RuntimeRoute[];
  lookupPricing: UsageBillingPricingLookup;
  modelId?: string;
  runAttemptId?: string;
  plannerAgentId?: string;
  subagentAgentId?: string;
  parentToolUseId?: string;
}

export async function resolveSdkStreamPartialBillingArtifacts(
  input: ResolveSdkStreamPartialBillingArtifactsInput,
): Promise<SdkStreamPartialBillingArtifacts> {
  const usageRoute = resolveUsageRoute(input.role, input.modelId, input.runtimeRoutes);
  const plannerRoute = input.runtimeRoutes.find((route) => route.role === "main");
  const actualLookup = usageRoute ? await input.lookupPricing(usageRoute, input.usage, true) : null;
  const plannerLookup = plannerRoute ? await input.lookupPricing(plannerRoute, input.usage, true) : null;
  const actualRates = resolveUsageRates(actualLookup, usageRoute);
  const plannerRates = resolveUsageRates(plannerLookup, plannerRoute);
  const computedBilling = computeRequestBilling(input.usage, actualRates, plannerRates);
  const resolvedModelId = usageRoute?.modelId ?? input.modelId;
  const ledgerAgentId = input.subagentAgentId ?? (input.role === "main" ? input.plannerAgentId : undefined);
  const requestKey = `sdk-stream:${input.eventId}`;
  const contextUpdate = usageRoute ? contextUpdateFromRoute(input.role, usageRoute) : undefined;

  return {
    ledgerEvent: buildSingleUsageLedgerEvent({
      threadId: input.threadId,
      role: usageRoute?.role ?? input.role,
      source: "sdk",
      sourceEventId: requestKey,
      usageKind: "request_partial",
      usage: input.usage,
      computedBilling,
      requestKey,
      ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
      ...(ledgerAgentId && { agentId: ledgerAgentId }),
      ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
      ...(resolvedModelId && { modelId: resolvedModelId }),
      metadata: {
        path: "processSdkStreamPartialUsage",
        settlement: "partial",
      },
    }),
    ...(resolvedModelId && { resolvedModelId }),
    ...(contextUpdate && { contextUpdate }),
  };
}

export interface SdkRunUsageInputModel {
  modelId: string;
  usage: ParsedUsage;
  sdkCostUsd?: number;
}

export interface ResolvedSdkRunBillingModel {
  sdkModelId?: string;
  role?: RuntimeAgentRole;
  modelId: string;
  usage: ParsedUsage;
  actualRates: ModelCostRates | null;
  plannerRates: ModelCostRates | null;
  sdkCostUsd?: number;
  computedBilling: RequestBillingDelta;
}

export interface SdkRunBillingModels {
  models: ResolvedSdkRunBillingModel[];
  plannerRates: ModelCostRates | null;
  plannerModelLabel?: string;
}

export interface ResolveSdkRunBillingModelsInput {
  role: RuntimeAgentRole;
  models: readonly SdkRunUsageInputModel[];
  runtimeRoutes: readonly RuntimeRoute[];
  lookupPricing: UsageBillingPricingLookup;
}

export async function resolveSdkRunBillingModels(
  input: ResolveSdkRunBillingModelsInput,
): Promise<SdkRunBillingModels> {
  const plannerRoute = input.runtimeRoutes.find((route) => route.role === "main");
  const combinedUsage = input.models.reduce<ParsedUsage>(
    (sum, entry) => ({
      inputTokens: sum.inputTokens + entry.usage.inputTokens,
      outputTokens: sum.outputTokens + entry.usage.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + entry.usage.cacheReadTokens,
      cacheCreationTokens: sum.cacheCreationTokens + entry.usage.cacheCreationTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  );
  const plannerLookup = plannerRoute ? await input.lookupPricing(plannerRoute, combinedUsage, true) : null;
  const plannerRates = resolveUsageRates(plannerLookup, plannerRoute);
  const models = await Promise.all(
    input.models.map(async (entry) => {
      const usageRoute = resolveUsageRoute(input.role, entry.modelId, input.runtimeRoutes);
      const billingRole = usageRoute?.role ?? input.role;
      const actualLookup = usageRoute ? await input.lookupPricing(usageRoute, entry.usage, true) : null;
      const actualRates = resolveUsageRates(actualLookup, usageRoute);
      const computedBilling = computeRequestBilling(entry.usage, actualRates, plannerRates);
      return {
        role: billingRole,
        sdkModelId: entry.modelId,
        modelId: usageRoute?.modelId ?? entry.modelId,
        usage: entry.usage,
        actualRates,
        plannerRates,
        computedBilling,
        ...(entry.sdkCostUsd !== undefined && { sdkCostUsd: entry.sdkCostUsd }),
      };
    }),
  );
  const plannerModelLabel = buildPlannerModelLabel(
    plannerRoute,
    plannerLookup?.displayName ?? plannerRoute?.modelId,
  );
  return {
    models,
    plannerRates,
    ...(plannerModelLabel && { plannerModelLabel }),
  };
}

function resolveSingleUsageContextUpdate(input: {
  billingRole: RuntimeAgentRole;
  resolvedModelId?: string;
  runtimeRoutes: readonly RuntimeRoute[];
  usageRoute?: ResolvedUsageRoute;
  plannerRoute?: RuntimeRoute;
}): UsageBillingContextUpdate | undefined {
  const monitorModelId = input.usageRoute?.modelId ?? input.plannerRoute?.modelId ?? input.resolvedModelId;
  const monitorBaseUrl = input.usageRoute?.provider.baseUrl ?? input.plannerRoute?.provider.baseUrl;
  const monitorRoute = resolveUsageRoute(input.billingRole, input.resolvedModelId, input.runtimeRoutes);
  const contextRoute = monitorRoute ?? input.usageRoute;
  const modelId = monitorRoute?.modelId ?? monitorModelId;
  const providerBaseUrl = monitorRoute?.provider.baseUrl ?? monitorBaseUrl;
  if (!modelId || !providerBaseUrl) {
    return undefined;
  }
  return {
    role: input.billingRole,
    modelId,
    providerBaseUrl,
    ...(contextRoute?.modelsDevMapping && { modelsDevMapping: contextRoute.modelsDevMapping }),
    ...(contextRoute?.manualSpec && { manualSpec: contextRoute.manualSpec }),
  };
}

function contextUpdateFromRoute(
  role: RuntimeAgentRole,
  route: ResolvedUsageRoute,
): UsageBillingContextUpdate {
  return {
    role,
    modelId: route.modelId,
    providerBaseUrl: route.provider.baseUrl,
    ...(route.modelsDevMapping && { modelsDevMapping: route.modelsDevMapping }),
    ...(route.manualSpec && { manualSpec: route.manualSpec }),
  };
}
