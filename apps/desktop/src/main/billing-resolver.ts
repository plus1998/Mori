import {
  buildModelPricingSummary,
  formatModelPricingLabel,
  type ModelCostRates,
  type ModelPricingLookup,
  unresolvedModelCapabilities,
} from "@eco/runtime";
import { resolveUpstreamApiCompat } from "../shared/api-compat";
import type {
  CommitModelPricingHint,
  ModelSettingsSnapshot,
  ModelsDevMapping,
  RouteCapabilityHint,
  RouteManualSpec,
  RoutePricingHint,
  RuntimeAgentRole,
  RuntimeRoleRouteConfig,
  ThinkingEffort,
  UpstreamApiCompat,
} from "../shared/ipc";
import { applyPriceMultiplierToCostRates, resolvePriceMultiplier } from "../shared/manual-spec-pricing";
import {
  type AnthropicProxyResolvedRoute,
  createModelAlias,
  resolveProxyRoute,
  stripExtendedContextModelSuffix,
} from "./anthropic-proxy";
import type { ModelsDevPricingCache } from "./models-dev-pricing-cache";
import type { ProviderConfigSecret } from "./provider-store";

export interface RuntimeRoute {
  role: RuntimeAgentRole;
  provider: ProviderConfigSecret;
  modelId: string;
  apiCompat: UpstreamApiCompat;
  thinkingEffort?: ThinkingEffort;
  modelsDevMapping?: ModelsDevMapping;
  manualSpec?: RouteManualSpec;
}

export interface ResolvedUsageRoute {
  role: RuntimeAgentRole;
  provider: ProviderConfigSecret;
  modelId: string;
  modelsDevMapping?: ModelsDevMapping;
  manualSpec?: RouteManualSpec;
}

export function manualSpecToRates(spec?: RouteManualSpec): ModelCostRates | null {
  if (spec?.inputPerM === undefined || spec.outputPerM === undefined) {
    return null;
  }
  return {
    input: spec.inputPerM,
    output: spec.outputPerM,
    ...(spec.cacheReadPerM !== undefined && { cacheRead: spec.cacheReadPerM }),
    ...(spec.cacheWritePerM !== undefined && { cacheWrite: spec.cacheWritePerM }),
  };
}

export function resolveRatesForRoute(
  lookup: ModelPricingLookup | null,
  manualSpec?: RouteManualSpec,
): ModelCostRates | null {
  const catalogRates = lookup?.rates ?? null;
  const manualRates = manualSpecToRates(manualSpec);
  let baseRates: ModelCostRates | null;
  if (manualRates && manualSpec?.inputPerM !== undefined && manualSpec?.outputPerM !== undefined) {
    baseRates = {
      input: manualSpec.inputPerM,
      output: manualSpec.outputPerM,
      ...(manualSpec.cacheReadPerM !== undefined
        ? { cacheRead: manualSpec.cacheReadPerM }
        : catalogRates?.cacheRead !== undefined && { cacheRead: catalogRates.cacheRead }),
      ...(manualSpec.cacheWritePerM !== undefined
        ? { cacheWrite: manualSpec.cacheWritePerM }
        : catalogRates?.cacheWrite !== undefined && { cacheWrite: catalogRates.cacheWrite }),
    };
  } else {
    baseRates = catalogRates ?? manualRates;
  }
  if (!baseRates) {
    return null;
  }
  return applyPriceMultiplierToCostRates(baseRates, resolvePriceMultiplier(manualSpec));
}

export function formatManualPricingLabel(spec: RouteManualSpec): string {
  const parts: string[] = [];
  const multiplier = resolvePriceMultiplier(spec);
  if (multiplier !== 1) {
    parts.push(`倍率 x${formatMultiplierLabel(multiplier)}`);
  }
  if (spec.inputPerM !== undefined && spec.outputPerM !== undefined) {
    parts.push(`输入 $${spec.inputPerM}/M · 输出 $${spec.outputPerM}/M`);
  }
  if (spec.cacheReadPerM !== undefined) {
    parts.push(`缓存读 $${spec.cacheReadPerM}/M`);
  }
  if (spec.cacheWritePerM !== undefined) {
    parts.push(`缓存写 $${spec.cacheWritePerM}/M`);
  }
  return parts.length > 0 ? `手动单价：${parts.join(" · ")}` : "手动单价";
}

export function buildResolvedProxyRoutes(routes: readonly RuntimeRoute[]): AnthropicProxyResolvedRoute[] {
  return routes.map((route) => ({
    role: route.role,
    provider: route.provider,
    modelId: route.modelId,
    apiCompat: route.apiCompat,
    aliasModelId: createModelAlias(route.role, route.provider.id, route.modelId),
    ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
  }));
}

export function resolveUsageRoute(
  role: RuntimeAgentRole,
  requestedModel: string | undefined,
  routes: readonly RuntimeRoute[],
): ResolvedUsageRoute | undefined {
  const resolved = buildResolvedProxyRoutes(routes);
  const roleRoute = routes.find((route) => route.role === role);
  const toResolved = (route: RuntimeRoute): ResolvedUsageRoute => ({
    role: route.role,
    provider: route.provider,
    modelId: route.modelId,
    ...(route.modelsDevMapping && { modelsDevMapping: route.modelsDevMapping }),
    ...(route.manualSpec && { manualSpec: route.manualSpec }),
  });
  const fromProxyRoute = (route: AnthropicProxyResolvedRoute): ResolvedUsageRoute => {
    const runtimeRoute = routes.find(
      (entry) =>
        entry.role === route.role &&
        entry.provider.id === route.provider.id &&
        entry.modelId === route.modelId,
    );
    return runtimeRoute
      ? toResolved(runtimeRoute)
      : {
          role: route.role,
          provider: route.provider,
          modelId: route.modelId,
        };
  };

  if (!requestedModel?.trim()) {
    return roleRoute ? toResolved(roleRoute) : undefined;
  }

  const trimmed = requestedModel.trim();
  const normalizedRequest = stripExtendedContextModelSuffix(trimmed);

  const byAlias = resolved.find(
    (route) =>
      route.aliasModelId === trimmed ||
      stripExtendedContextModelSuffix(route.aliasModelId) === normalizedRequest,
  );
  if (byAlias) {
    return fromProxyRoute(byAlias);
  }

  const byModelId = routes.filter((route) => route.modelId === trimmed);
  if (byModelId.length === 1) {
    const route = byModelId[0]!;
    if (roleRoute && route.role !== role) {
      const plannerRoute = routes.find((entry) => entry.role === "main");
      // SDK often reports the planner upstream id for subagent calls — prefer the billing role's route.
      if (plannerRoute && route.modelId === plannerRoute.modelId && role !== "main") {
        return toResolved(roleRoute);
      }
      // Unique upstream id identifies a specific role (e.g. explore haiku when billing role wrongly says planner).
      return toResolved(route);
    }
    return toResolved(route);
  }

  // SDK often reports the planner upstream id for every role; prefer this role's route.
  if (byModelId.length > 1 && roleRoute) {
    const roleMatch = byModelId.find((route) => route.role === role);
    if (roleMatch) {
      return toResolved(roleMatch);
    }
    return toResolved(roleRoute);
  }

  if (roleRoute) {
    return toResolved(roleRoute);
  }

  const byModel = resolveProxyRoute(resolved, trimmed);
  if (byModel) {
    return fromProxyRoute(byModel);
  }

  return undefined;
}

/** Resolve SDK alias model to the upstream id shown in UI and billing snapshots. */
export function resolvePublicModelId(
  role: RuntimeAgentRole,
  requestedModel: string | undefined,
  routes: readonly RuntimeRoute[],
): string | undefined {
  return resolveUsageRoute(role, requestedModel, routes)?.modelId;
}

export async function lookupRatesForRoute(
  cache: ModelsDevPricingCache,
  route: ResolvedUsageRoute | undefined,
): Promise<ModelCostRates | null> {
  if (!route) {
    return null;
  }
  const lookup = await cache.lookupForRoute({
    baseUrl: route.provider.baseUrl,
    modelId: route.modelId,
    ...(route.modelsDevMapping && { mapping: route.modelsDevMapping }),
  });
  return resolveRatesForRoute(lookup, route.manualSpec);
}

export function buildPlannerModelLabel(
  route: ResolvedUsageRoute | undefined,
  displayName?: string,
): string | undefined {
  if (!route) {
    return undefined;
  }
  const model = displayName ?? route.modelId;
  return `${model} · ${route.provider.name}`;
}

export function resolveRuntimeRoutesFromSettings(
  settings: ModelSettingsSnapshot,
  providers: readonly ProviderConfigSecret[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
): RuntimeRoute[] {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const sourceRoutes = routesOverride ?? [];
  return sourceRoutes.flatMap((route) => {
    const provider = providersById.get(route.providerId);
    if (!provider) {
      return [];
    }
    return [
      {
        role: route.role,
        provider,
        modelId: route.modelId,
        apiCompat: resolveUpstreamApiCompat(route.apiCompat, provider.apiCompat),
        ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
        ...(route.modelsDevMapping && { modelsDevMapping: route.modelsDevMapping }),
        ...(route.manualSpec && { manualSpec: route.manualSpec }),
      },
    ];
  });
}

function formatModelsDevLabel(mapping: ModelsDevMapping, displayName?: string): string {
  if (displayName?.trim()) {
    return `${displayName.trim()} · ${mapping.providerKey}/${mapping.modelId}`;
  }
  return `${mapping.providerKey}/${mapping.modelId}`;
}

function resolvedMappingFromLookup(
  lookup?: { providerKey: string; modelId: string; displayName?: string } | null,
): { mapping: ModelsDevMapping; label: string } | undefined {
  if (!lookup) {
    return undefined;
  }
  const mapping = { providerKey: lookup.providerKey, modelId: lookup.modelId };
  return {
    mapping,
    label: formatModelsDevLabel(mapping, lookup.displayName),
  };
}

function routeLookupFromRuntime(route: RuntimeRoute) {
  return {
    baseUrl: route.provider.baseUrl,
    modelId: route.modelId,
    ...(route.modelsDevMapping && { mapping: route.modelsDevMapping }),
  };
}

function manualContextTokens(spec?: RouteManualSpec): number | undefined {
  const tokens = spec?.contextTokens;
  return tokens !== undefined && tokens > 0 ? tokens : undefined;
}

function manualMaxOutputTokens(spec?: RouteManualSpec): number | undefined {
  const tokens = spec?.maxOutputTokens;
  return tokens !== undefined && tokens > 0 ? tokens : undefined;
}

function hasManualCapabilityOverride(spec?: RouteManualSpec): boolean {
  if (!spec) {
    return false;
  }
  return (
    spec.contextTokens !== undefined ||
    spec.maxOutputTokens !== undefined ||
    spec.supportsImageInput !== undefined ||
    spec.supportsReasoning !== undefined
  );
}

function hasManualPricingOverride(spec?: RouteManualSpec): boolean {
  if (!spec) {
    return false;
  }
  return (
    spec.inputPerM !== undefined ||
    spec.outputPerM !== undefined ||
    spec.cacheReadPerM !== undefined ||
    spec.cacheWritePerM !== undefined ||
    (spec.priceMultiplier !== undefined && spec.priceMultiplier !== 1)
  );
}

function formatMultiplierLabel(multiplier: number): string {
  return Number.isInteger(multiplier) ? String(multiplier) : multiplier.toString();
}

function resolveEffectiveCapabilities(
  catalog: ReturnType<typeof unresolvedModelCapabilities>,
  manualSpec?: RouteManualSpec,
) {
  return {
    supportsImageInput: manualSpec?.supportsImageInput ?? catalog.supportsImageInput,
    supportsReasoning: manualSpec?.supportsReasoning ?? catalog.supportsReasoning,
    capabilitiesResolved: catalog.capabilitiesResolved || hasManualCapabilityOverride(manualSpec),
  };
}

function resolveEffectiveLimits(
  limitsLookup: Awaited<ReturnType<ModelsDevPricingCache["lookupLimitsForRoute"]>>,
  manualSpec?: RouteManualSpec,
) {
  const manualContext = manualContextTokens(manualSpec);
  const manualMaxOutput = manualMaxOutputTokens(manualSpec);
  const contextTokens = manualContext ?? limitsLookup?.limits.contextTokens;
  const maxOutputTokens = manualMaxOutput ?? limitsLookup?.limits.maxOutputTokens;
  const contextLimitResolved = manualContext !== undefined || Boolean(limitsLookup);
  return {
    ...(contextTokens !== undefined && { contextTokens }),
    ...(maxOutputTokens !== undefined && { maxOutputTokens }),
    contextLimitResolved,
  };
}

function resolveEffectivePricingSummary(lookup: ModelPricingLookup | null, manualSpec?: RouteManualSpec) {
  const catalogSummary = lookup ? buildModelPricingSummary(lookup) : null;
  const rates = resolveRatesForRoute(lookup, manualSpec);
  if (!rates) {
    return null;
  }
  const summary = {
    inputPerM: rates.input,
    outputPerM: rates.output,
    ...(rates.cacheRead !== undefined && { cacheReadPerM: rates.cacheRead }),
    ...(rates.cacheWrite !== undefined && { cacheWritePerM: rates.cacheWrite }),
  };
  const pricingResolved = Boolean(catalogSummary) || hasManualPricingOverride(manualSpec);
  const pricingLabel =
    hasManualPricingOverride(manualSpec) && manualSpec
      ? formatManualPricingLabel(manualSpec)
      : lookup
        ? formatModelPricingLabel(lookup)
        : manualSpec
          ? formatManualPricingLabel(manualSpec)
          : undefined;
  return { summary, pricingResolved, pricingLabel };
}

export async function lookupRouteCapabilityHints(
  cache: ModelsDevPricingCache,
  settings: ModelSettingsSnapshot,
  providers: readonly ProviderConfigSecret[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
): Promise<RouteCapabilityHint[]> {
  const routes = resolveRuntimeRoutesFromSettings(settings, providers, routesOverride);
  const hints: RouteCapabilityHint[] = [];

  for (const route of routes) {
    const routeLookup = routeLookupFromRuntime(route);
    const lookup = await cache.lookupCapabilitiesForRoute(routeLookup);
    const limitsLookup = await cache.lookupLimitsForRoute(routeLookup);
    const pricingLookup = await cache.lookupForRoute(routeLookup);
    const capabilities = lookup?.capabilities ?? unresolvedModelCapabilities();
    const effectiveCapabilities = resolveEffectiveCapabilities(capabilities, route.manualSpec);
    const resolved =
      resolvedMappingFromLookup(lookup) ??
      resolvedMappingFromLookup(limitsLookup) ??
      resolvedMappingFromLookup(pricingLookup);
    const effectiveLimits = resolveEffectiveLimits(limitsLookup, route.manualSpec);
    hints.push({
      role: route.role,
      modelId: route.modelId,
      providerName: route.provider.name,
      supportsImageInput: effectiveCapabilities.supportsImageInput,
      supportsReasoning: effectiveCapabilities.supportsReasoning,
      supportsRemoteCompaction: route.manualSpec?.supportsRemoteCompaction === true,
      capabilitiesResolved: effectiveCapabilities.capabilitiesResolved,
      ...(capabilities.capabilitiesResolved && {
        catalogSupportsImageInput: capabilities.supportsImageInput,
        catalogSupportsReasoning: capabilities.supportsReasoning,
      }),
      ...(limitsLookup && {
        catalogContextTokens: limitsLookup.limits.contextTokens,
        ...(limitsLookup.limits.maxOutputTokens !== undefined && {
          catalogMaxOutputTokens: limitsLookup.limits.maxOutputTokens,
        }),
      }),
      ...effectiveLimits,
      ...(resolved && {
        resolvedModelsDevMapping: resolved.mapping,
        resolvedModelsDevLabel: resolved.label,
      }),
      ...(route.modelsDevMapping && {
        modelsDevMapping: route.modelsDevMapping,
        modelsDevLabel: formatModelsDevLabel(
          route.modelsDevMapping,
          lookup?.capabilities.displayName ?? limitsLookup?.displayName ?? pricingLookup?.displayName,
        ),
      }),
    });
  }

  return hints;
}

export async function lookupRoutePricingHints(
  cache: ModelsDevPricingCache,
  settings: ModelSettingsSnapshot,
  providers: readonly ProviderConfigSecret[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
  lookupAccountPricing?: (route: RuntimeRoute) => Promise<ModelPricingLookup | null>,
): Promise<RoutePricingHint[]> {
  const routes = resolveRuntimeRoutesFromSettings(settings, providers, routesOverride);
  const hints: RoutePricingHint[] = [];

  for (const route of routes) {
    const isAccount = route.provider.authMethod === "chatgpt_subscription";
    const lookup = isAccount
      ? ((await lookupAccountPricing?.(route)) ?? null)
      : await cache.lookupForRoute(routeLookupFromRuntime(route));
    const catalogSummary = lookup ? buildModelPricingSummary(lookup) : null;
    const effectivePricing = resolveEffectivePricingSummary(lookup, isAccount ? undefined : route.manualSpec);
    hints.push({
      role: route.role,
      modelId: route.modelId,
      providerName: route.provider.name,
      ...(effectivePricing?.summary && {
        rates: effectivePricing.summary,
        ...(effectivePricing.pricingLabel && { pricingLabel: effectivePricing.pricingLabel }),
      }),
      ...(catalogSummary && {
        catalogRates: {
          inputPerM: catalogSummary.inputPerM,
          outputPerM: catalogSummary.outputPerM,
          ...(catalogSummary.cacheReadPerM !== undefined && { cacheReadPerM: catalogSummary.cacheReadPerM }),
          ...(catalogSummary.cacheWritePerM !== undefined && {
            cacheWritePerM: catalogSummary.cacheWritePerM,
          }),
        },
      }),
      pricingResolved: effectivePricing?.pricingResolved ?? false,
      ...(route.modelsDevMapping && {
        modelsDevMapping: route.modelsDevMapping,
        modelsDevLabel: formatModelsDevLabel(route.modelsDevMapping, lookup?.displayName),
      }),
    });
  }

  return hints;
}

function candidateLookupFromModel(
  provider: ProviderConfigSecret,
  candidate: {
    modelId: string;
    modelsDevMapping?: RuntimeRoleRouteConfig["modelsDevMapping"];
  },
) {
  return {
    baseUrl: provider.baseUrl,
    modelId: candidate.modelId,
    ...(candidate.modelsDevMapping && { mapping: candidate.modelsDevMapping }),
  };
}

export async function lookupCommitModelPricingHints(
  cache: ModelsDevPricingCache,
  providers: readonly ProviderConfigSecret[],
  candidates: readonly {
    candidateModelId: string;
    providerId: string;
    providerName: string;
    modelId: string;
    modelsDevMapping?: RuntimeRoleRouteConfig["modelsDevMapping"];
    manualSpec?: RouteManualSpec;
  }[],
): Promise<CommitModelPricingHint[]> {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const hints: CommitModelPricingHint[] = [];

  for (const candidate of candidates) {
    const provider = providerById.get(candidate.providerId);
    if (!provider) {
      continue;
    }
    const lookup = await cache.lookupForRoute(candidateLookupFromModel(provider, candidate));
    const catalogSummary = lookup ? buildModelPricingSummary(lookup) : null;
    const effectivePricing = resolveEffectivePricingSummary(lookup, candidate.manualSpec);
    hints.push({
      candidateModelId: candidate.candidateModelId,
      modelId: candidate.modelId,
      providerName: provider.name,
      ...(effectivePricing?.summary && {
        rates: effectivePricing.summary,
        ...(effectivePricing.pricingLabel && { pricingLabel: effectivePricing.pricingLabel }),
      }),
      ...(catalogSummary && {
        catalogRates: {
          inputPerM: catalogSummary.inputPerM,
          outputPerM: catalogSummary.outputPerM,
          ...(catalogSummary.cacheReadPerM !== undefined && { cacheReadPerM: catalogSummary.cacheReadPerM }),
          ...(catalogSummary.cacheWritePerM !== undefined && {
            cacheWritePerM: catalogSummary.cacheWritePerM,
          }),
        },
      }),
      pricingResolved: effectivePricing?.pricingResolved ?? false,
    });
  }

  return hints;
}
