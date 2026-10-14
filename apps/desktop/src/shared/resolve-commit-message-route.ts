import type {
  CandidateModelView,
  CommitModelPricingHint,
  ProviderConfigView,
  RoutePricingHint,
  RuntimeAgentRole,
  RuntimeRoleRouteConfig,
  SubagentRole,
} from "./ipc";
import { SUBAGENT_ROLES } from "./ipc";

export type CommitMessageRolePreference = RuntimeAgentRole | "auto";
export type CommitMessageModelPreference = string | "auto";

export interface CommitMessageCandidateModel {
  candidateModelId: string;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName?: string;
  modelsDevMapping?: CandidateModelView["modelsDevMapping"];
  manualSpec?: CandidateModelView["manualSpec"];
}

const SUBAGENT_ROLE_PRIORITY: Record<SubagentRole, number> = {
  explore: 0,
  architect: 1,
  coder: 2,
  reviewer: 3,
  tester: 4,
};

function isSubagentRole(role: RuntimeAgentRole): role is SubagentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(role);
}

function rolePriority(role: RuntimeAgentRole): number {
  return isSubagentRole(role) ? SUBAGENT_ROLE_PRIORITY[role] : 99;
}

export function commitModelPriceScore(hint: CommitModelPricingHint | RoutePricingHint | undefined): number {
  if (!hint?.rates) {
    return Number.POSITIVE_INFINITY;
  }
  return hint.rates.inputPerM * 0.7 + hint.rates.outputPerM * 0.3;
}

/** @deprecated Use commitModelPriceScore */
export const commitRoutePriceScore = commitModelPriceScore;

export function listCommitMessageCandidateModels(
  providers: readonly ProviderConfigView[],
  listCandidateModels: (providerId: string) => readonly CandidateModelView[],
  purpose: "general" | "approval" = "general",
): CommitMessageCandidateModel[] {
  const candidates: CommitMessageCandidateModel[] = [];
  for (const provider of providers) {
    if (!provider.enabled || (provider.apiCompat === "system_one" && purpose !== "approval")) {
      continue;
    }
    for (const candidate of listCandidateModels(provider.id)) {
      candidates.push({
        candidateModelId: candidate.id,
        providerId: provider.id,
        providerName: provider.name,
        modelId: candidate.modelId,
        ...(candidate.displayName && { displayName: candidate.displayName }),
        ...(candidate.modelsDevMapping && { modelsDevMapping: candidate.modelsDevMapping }),
        ...(candidate.manualSpec && { manualSpec: candidate.manualSpec }),
      });
    }
  }
  return candidates;
}

export function resolveDefaultCommitMessageCandidateModel(
  candidates: readonly CommitMessageCandidateModel[],
  hints: readonly CommitModelPricingHint[],
): CommitMessageCandidateModel | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const hintById = new Map(hints.map((hint) => [hint.candidateModelId, hint]));
  const sorted = [...candidates].sort((left, right) => {
    const scoreDelta =
      commitModelPriceScore(hintById.get(left.candidateModelId)) -
      commitModelPriceScore(hintById.get(right.candidateModelId));
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const providerDelta = left.providerName.localeCompare(right.providerName);
    if (providerDelta !== 0) {
      return providerDelta;
    }
    return left.modelId.localeCompare(right.modelId);
  });
  return sorted[0];
}

export function resolveCommitMessageCandidateModel(
  candidates: readonly CommitMessageCandidateModel[],
  hints: readonly CommitModelPricingHint[],
  savedCandidateModelId?: CommitMessageModelPreference,
): CommitMessageCandidateModel | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  if (savedCandidateModelId && savedCandidateModelId !== "auto") {
    const saved = candidates.find((candidate) => candidate.candidateModelId === savedCandidateModelId);
    if (saved) {
      return saved;
    }
  }
  return resolveDefaultCommitMessageCandidateModel(candidates, hints);
}

/** Legacy role-based resolution for migrating saved preferences. */
export function listCommitMessageCandidateRoutes(
  routes: readonly RuntimeRoleRouteConfig[],
  enabledRoles: ReadonlySet<SubagentRole>,
): RuntimeRoleRouteConfig[] {
  return routes.filter(
    (route) => route.role !== "planner" && isSubagentRole(route.role) && enabledRoles.has(route.role),
  );
}

export function resolveDefaultCommitMessageRole(
  routes: readonly RuntimeRoleRouteConfig[],
  hints: readonly RoutePricingHint[],
  enabledRoles: ReadonlySet<SubagentRole>,
): RuntimeAgentRole | undefined {
  const candidates = listCommitMessageCandidateRoutes(routes, enabledRoles);
  if (candidates.length === 0) {
    return undefined;
  }
  const hintByRole = new Map(hints.map((hint) => [hint.role, hint]));
  const sorted = [...candidates].sort((left, right) => {
    const scoreDelta =
      commitModelPriceScore(hintByRole.get(left.role)) - commitModelPriceScore(hintByRole.get(right.role));
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return rolePriority(left.role) - rolePriority(right.role);
  });
  return sorted[0]?.role;
}

export function resolveCommitMessageRoute(
  routes: readonly RuntimeRoleRouteConfig[],
  hints: readonly RoutePricingHint[],
  enabledRoles: ReadonlySet<SubagentRole>,
  savedRole?: CommitMessageRolePreference,
): RuntimeRoleRouteConfig | undefined {
  const candidates = listCommitMessageCandidateRoutes(routes, enabledRoles);
  if (candidates.length === 0) {
    return undefined;
  }
  if (savedRole && savedRole !== "auto") {
    const saved = candidates.find((route) => route.role === savedRole);
    if (saved) {
      return saved;
    }
  }
  const defaultRole = resolveDefaultCommitMessageRole(routes, hints, enabledRoles);
  return defaultRole ? candidates.find((route) => route.role === defaultRole) : candidates[0];
}

export function resolveLegacyCommitMessageCandidateModel(
  candidates: readonly CommitMessageCandidateModel[],
  routes: readonly RuntimeRoleRouteConfig[],
  savedRole?: CommitMessageRolePreference,
): CommitMessageCandidateModel | undefined {
  if (!savedRole || savedRole === "auto") {
    return undefined;
  }
  const route = routes.find((entry) => entry.role === savedRole);
  if (!route) {
    return undefined;
  }
  if (route.candidateModelId) {
    const byId = candidates.find((candidate) => candidate.candidateModelId === route.candidateModelId);
    if (byId) {
      return byId;
    }
  }
  return (
    candidates.find(
      (candidate) => candidate.providerId === route.providerId && candidate.modelId === route.modelId,
    ) ?? undefined
  );
}
