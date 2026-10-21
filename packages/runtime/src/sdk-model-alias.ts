import { normalizeAgentRole } from "../../shared/src";
import type { ResolvedModelRoute } from "../../model-router/src";
import type { RuntimeAgentRole } from "../../shared/src";

function normalizeRouteAgentKey(agentKey: string): string {
  return normalizeAgentRole(agentKey.startsWith("eco_") ? agentKey.slice(4) : agentKey);
}

function isEcoAliasModelId(modelId: string): boolean {
  return modelId.startsWith("eco-");
}

function findRouteByRole(
  routes: readonly ResolvedModelRoute[],
  role: string,
): ResolvedModelRoute | undefined {
  return routes.find((route) => normalizeAgentRole(route.role) === role);
}

/** Map orchestration/SDK upstream model ids to configured proxy alias ids. */
export function resolveSdkModelId(
  routes: readonly ResolvedModelRoute[],
  agentKey: string,
  modelId: string,
): string {
  const role = normalizeRouteAgentKey(agentKey);
  const byRole = findRouteByRole(routes, role)?.primary.modelId;
  if (byRole) {
    return byRole;
  }

  if (isEcoAliasModelId(modelId)) {
    const knownAliases = new Set(routes.map((route) => route.primary.modelId));
    if (knownAliases.has(modelId)) {
      return modelId;
    }
  }

  const byUpstream = routes.find((route) => route.upstreamModelId === modelId)?.primary.modelId;
  if (byUpstream) {
    return byUpstream;
  }

  for (const route of routes) {
    const upstream = route.upstreamModelId;
    if (!upstream) {
      continue;
    }
    if (upstream === modelId || upstream.startsWith(`${modelId}-`)) {
      return route.primary.modelId;
    }
  }

  const plannerAlias = findRouteByRole(routes, "main")?.primary.modelId;
  if (plannerAlias) {
    return plannerAlias;
  }

  return routes[0]?.primary.modelId ?? modelId;
}

export function resolveMainSdkModelId(
  routes: readonly ResolvedModelRoute[],
  orchestrationMainModelId?: string,
): string {
  const plannerAlias = findRouteByRole(routes, "main")?.primary.modelId;
  if (plannerAlias) {
    return plannerAlias;
  }
  if (orchestrationMainModelId?.trim()) {
    return resolveSdkModelId(routes, "main", orchestrationMainModelId);
  }
  return routes[0]?.primary.modelId ?? "";
}

export function createSdkModelResolver(routes: readonly ResolvedModelRoute[]) {
  return (agentKey: string, modelId: string): string => resolveSdkModelId(routes, agentKey, modelId);
}
