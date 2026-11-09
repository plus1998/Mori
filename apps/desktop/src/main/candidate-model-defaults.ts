import type { CandidateModelView, RuntimeRoleRouteConfig } from "../shared/ipc";
import type { ModelRef } from "../shared/agent-orchestration";

interface CandidateModelRouteSource {
  isBuiltInCodexProvider: (providerId: string) => boolean;
  isChatGptSubscriptionProvider: (providerId: string) => boolean;
  listCandidateModels: (providerId: string) => readonly CandidateModelView[];
}

export function isCandidateModelReferenceAvailable(model: ModelRef, source: CandidateModelRouteSource): boolean {
  if (!model.candidateModelId) return true;
  if (source.isBuiltInCodexProvider(model.providerId) &&
    model.candidateModelId === codexCatalogCandidateId(model.modelId)) return true;
  if (source.isChatGptSubscriptionProvider(model.providerId) &&
    (model.candidateModelId === chatGptCatalogCandidateId(model.modelId) ||
      model.candidateModelId === `account:${encodeURIComponent(model.providerId)}:${encodeURIComponent(model.modelId)}`)) return true;
  return source.listCandidateModels(model.providerId).some(candidate => candidate.id === model.candidateModelId);
}

export function codexCatalogCandidateId(modelId: string): string {
  return `cand-openai-${modelId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")}`;
}

export function chatGptCatalogCandidateId(modelId: string): string {
  return `cand-chatgpt-${modelId}`;
}

export function resolveCandidateModelRouteDefaults(
  routes: readonly RuntimeRoleRouteConfig[],
  source: CandidateModelRouteSource,
): RuntimeRoleRouteConfig[] {
  return routes.map((route) => {
    if (source.isChatGptSubscriptionProvider(route.providerId)) {
      route = { ...route, apiCompat: "openai_responses" };
    }
    // Frozen task routes already own a concrete endpoint; do not reconnect them
    // to a mutable catalog entry just because the model ID still matches.
    if (!route.candidateModelId && !route.baseUrl && !source.isBuiltInCodexProvider(route.providerId) && !source.isChatGptSubscriptionProvider(route.providerId)) {
      const existing = source.listCandidateModels(route.providerId).find((candidate) => candidate.modelId === route.modelId);
      if (existing) route = { ...route, candidateModelId: existing.id };
    }
    if (!route.candidateModelId) return route;

    // Account catalogs expose selection IDs, not ProviderStore candidate rows.
    // Match both the source and model so stale stored candidates still fail.
    const catalogSelection =
      (source.isBuiltInCodexProvider(route.providerId) &&
        route.candidateModelId === codexCatalogCandidateId(route.modelId)) ||
      (source.isChatGptSubscriptionProvider(route.providerId) &&
        (route.candidateModelId === chatGptCatalogCandidateId(route.modelId) ||
          route.candidateModelId === `account:${encodeURIComponent(route.providerId)}:${encodeURIComponent(route.modelId)}`));
    if (catalogSelection) {
      const { candidateModelId: _catalogSelectionId, ...modelRoute } = route;
      return modelRoute;
    }

    const candidate = source
      .listCandidateModels(route.providerId)
      .find((entry) => entry.id === route.candidateModelId);
    if (!candidate) throw new Error(`模型 ${route.candidateModelId} 已不存在，请重新选择（角色：${route.role}）。`);
    if (candidate.apiCompat === "system_one") {
      throw new Error(`模型 ${candidate.modelId} 使用 SystemOne 协议，仅可作为审批模型。`);
    }
    if (!candidate.baseUrl || !candidate.apiCompat) {
      throw new Error(`模型 ${candidate.modelId} 缺少端点或协议配置，请重新编辑模型。`);
    }
    const manualSpec =
      candidate.manualSpec || route.manualSpec ? { ...candidate.manualSpec, ...route.manualSpec } : undefined;
    return {
      ...route,
      modelId: candidate.modelId || route.modelId,
      baseUrl: candidate.baseUrl,
      requestPath: candidate.requestPath ?? "",
      version: candidate.version ?? "v1",
      ...(candidate.tokenCountMode ? { tokenCountMode: candidate.tokenCountMode } : {}),
      apiCompat: candidate.apiCompat,
      ...(route.modelsDevMapping
        ? { modelsDevMapping: route.modelsDevMapping }
        : candidate.modelsDevMapping
          ? { modelsDevMapping: candidate.modelsDevMapping }
          : {}),
      ...(manualSpec ? { manualSpec } : {}),
    };
  });
}
