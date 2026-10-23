import type { ResolvedModelRoute } from "@eco/model-router";
import { DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT, resolveEffectiveContextLimit } from "@eco/runtime";
import { normalizeAgentRole } from "@eco/shared";
import { resolveUpstreamApiCompat } from "../shared/api-compat";
import {
  AGENT_ROLES,
  type ModelSettingsSnapshot,
  type RuntimeAgentRole,
  type RuntimeRoleRouteConfig,
} from "../shared/ipc";
import { type AnthropicProxyResolvedRoute, createModelAlias, toSdkModelAlias } from "./anthropic-proxy";
import type { RuntimeRoute } from "./billing-resolver";
import type { ModelsDevPricingCache } from "./models-dev-pricing-cache";
import type { ProviderConfigSecret } from "./provider-store";

export interface RuntimeConfig {
  routes: RuntimeRoute[];
}

export type RuntimeConfigResolution = { ok: true; routes: RuntimeRoute[] } | { ok: false; reason: string };

export function resolveThreadRuntimeConfig(
  _settings: ModelSettingsSnapshot,
  providersWithSecrets: readonly ProviderConfigSecret[],
  routesOverride?: readonly RuntimeRoleRouteConfig[],
  options: { requireCompleteCodingRoutes?: boolean } = {},
): RuntimeConfigResolution {
  const providersById = new Map(providersWithSecrets.map((provider) => [provider.id, provider]));
  // Built-in OpenAI (auth.json) — no ProviderStore entry needed
  if (!providersById.has("openai")) {
    providersById.set("openai", {
      id: "openai",
      name: "ChatGPT Login",
      baseUrl: "",
      requestPath: "/v1",
      version: "v1",
      apiCompat: "openai_responses" as const,
      defaultModel: "gpt-5.6-luna",
      enabled: true,
      hasApiKey: false,
      apiKey: "",
    } as ProviderConfigSecret);
  }
  const activeRoutes = (routesOverride ?? []).map((route) => ({
    ...route,
    role: normalizeAgentRole(route.role),
  }));
  const routes = activeRoutes.map((route): RuntimeRoute | undefined => {
    const provider = providersById.get(route.providerId);
    if (!provider) return undefined;
    return {
      role: route.role,
      provider,
      modelId: route.modelId,
      apiCompat: resolveUpstreamApiCompat(route.apiCompat, provider.apiCompat),
      ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
      ...(route.modelsDevMapping && { modelsDevMapping: route.modelsDevMapping }),
      ...(route.manualSpec && { manualSpec: route.manualSpec }),
    };
  });

  const missingRoute = activeRoutes.find((route) => !providersById.has(route.providerId));
  if (missingRoute) {
    return { ok: false, reason: `Route ${missingRoute.role} references a missing provider.` };
  }

  const resolvedRoutes = routes.filter((route): route is RuntimeRoute => Boolean(route));
  for (const route of resolvedRoutes) {
    if (!route.modelId.trim()) {
      return { ok: false, reason: `Model id is required for ${route.role}.` };
    }
    if (!route.provider.enabled) {
      return { ok: false, reason: `Provider "${route.provider.name}" for ${route.role} is disabled.` };
    }
  }

  if (options.requireCompleteCodingRoutes === false) {
    if (resolvedRoutes.length === 0) {
      return { ok: false, reason: "At least one model route is required for this orchestration." };
    }
    return { ok: true, routes: resolvedRoutes };
  }

  for (const role of AGENT_ROLES) {
    const route = resolvedRoutes.find((candidate) => candidate.role === role);
    if (!route) {
      return { ok: false, reason: `Configure a ${role} route before starting a coding thread.` };
    }
  }

  return {
    ok: true,
    routes: resolvedRoutes,
  };
}

export function roleRoutesFromRuntime(routes: readonly RuntimeRoute[]): RuntimeRoleRouteConfig[] {
  return routes.map((route) => ({
    role: route.role,
    providerId: route.provider.id,
    modelId: route.modelId,
    apiCompat: resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat),
    ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
    ...(route.modelsDevMapping && { modelsDevMapping: route.modelsDevMapping }),
    ...(route.manualSpec && { manualSpec: route.manualSpec }),
  }));
}

export function buildDriverRoutes(routes: readonly AnthropicProxyResolvedRoute[]): ResolvedModelRoute[] {
  return routes.map((route) => ({
    role: route.role,
    upstreamModelId: route.modelId,
    primary: {
      id: `${route.role}:${route.provider.id}`,
      provider: "custom",
      displayName: `${route.provider.name} / ${route.role}`,
      baseUrl: route.provider.baseUrl,
      // Role-specific alias lets the local proxy attribute shared upstream models to the right context window.
      modelId: route.aliasModelId,
      capabilities: ["messages_api", "streaming", "tool_use", "subagent_compatible"],
      enabled: route.provider.enabled,
      ...(route.contextTokens !== undefined && { contextWindow: route.contextTokens }),
      ...(route.contextTokensResolved !== undefined && {
        contextWindowResolved: route.contextTokensResolved,
      }),
    },
    fallbacks: [],
    ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
    ...(route.maxOutputTokens !== undefined && { maxOutputTokens: route.maxOutputTokens }),
  }));
}

export async function resolveContextTokensByRole(
  routes: readonly RuntimeRoute[],
  pricingCache: ModelsDevPricingCache,
  globalContextWindowLimit: number = DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
): Promise<Partial<Record<RuntimeAgentRole, number>>> {
  const pairs = await Promise.all(
    routes.map(async (route) => {
      const resolved = await pricingCache.resolveContextLimit(
        route.provider.baseUrl,
        route.modelId,
        route.modelsDevMapping,
        route.manualSpec?.contextTokens,
        route.manualSpec?.maxOutputTokens,
      );
      return [route.role, resolveEffectiveContextLimit(resolved.limit, globalContextWindowLimit)] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

export function buildDriverRoutesFromRuntime(
  routes: readonly RuntimeRoute[],
  contextTokensByRole?: Partial<Record<RuntimeAgentRole, number>>,
): ResolvedModelRoute[] {
  return routes.map((route) => {
    const baseAlias = createModelAlias(route.role, route.provider.id, route.modelId);
    const contextWindow = contextTokensByRole?.[route.role];
    const aliasModelId = toSdkModelAlias(baseAlias, contextWindow);
    return {
      role: route.role,
      upstreamModelId: route.modelId,
      providerId: route.provider.id,
      apiCompat: resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat),
      primary: {
        id: `${route.role}:${route.provider.id}`,
        provider: "custom",
        displayName: `${route.provider.name} / ${route.role}`,
        baseUrl: route.provider.baseUrl,
        modelId: aliasModelId,
        capabilities: ["messages_api", "streaming", "tool_use", "subagent_compatible"],
        enabled: route.provider.enabled,
        ...(contextWindow !== undefined && { contextWindow }),
      },
      fallbacks: [],
      ...(route.thinkingEffort && { thinkingEffort: route.thinkingEffort }),
    };
  });
}
