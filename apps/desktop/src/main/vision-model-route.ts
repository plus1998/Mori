import type { VisionModelSelection } from "../shared/vision-model";
import type { RuntimeRoute } from "./billing-resolver";
import type { ProviderStore } from "./provider-store";

export function resolveThreadVisionAnalysisRoute(input: {
  coreKind?: string;
  visionSelection: VisionModelSelection | undefined;
  providerStore: ProviderStore;
  resolveEcoFallback: () => RuntimeRoute;
}): RuntimeRoute {
  if (input.visionSelection) {
    return resolveVisionModelRoute(input.visionSelection, input.providerStore);
  }
  if (input.coreKind === "acp") {
    throw new Error("未配置视觉模型。ACP 会话没有 Mori 主模型可回退，请在 Composer 运行配置中选择视觉模型。");
  }
  return input.resolveEcoFallback();
}

export function resolveVisionModelRoute(
  selection: VisionModelSelection | undefined,
  providerStore: ProviderStore,
): RuntimeRoute {
  if (!selection) {
    throw new Error("未配置视觉模型。请在 Composer 的运行配置中选择视觉模型，或保持未配置以使用主模型。");
  }
  const provider = providerStore
    .listProvidersWithSecrets()
    .find((candidate) => candidate.id === selection.providerId && candidate.enabled);
  if (!provider) {
    throw new Error(`视觉模型所属 Provider 不存在或已禁用：${selection.providerId}`);
  }
  const candidate = providerStore
    .listStatelessModelCandidates(provider.id)
    .find((model) => model.id === selection.candidateModelId);
  if (!candidate) {
    throw new Error(`视觉模型已不在候选模型列表中：${selection.candidateModelId}`);
  }
  if (candidate.modelId.trim() !== selection.modelId.trim()) {
    throw new Error(
      `视觉模型配置已发生变化：预期 ${selection.modelId}，当前 ${candidate.modelId}。请重新选择。`,
    );
  }
  if (candidate.apiCompat === "system_one") {
    throw new Error(`模型 ${candidate.modelId} 使用 SystemOne 协议，仅可用于审批。`);
  }
  if (!candidate.baseUrl || !candidate.apiCompat) {
    throw new Error(`模型 ${candidate.modelId} 缺少端点或协议配置，请重新编辑模型。`);
  }
  return {
    role: "vision",
    provider: {
      ...provider,
      baseUrl: candidate.baseUrl,
      requestPath: candidate.requestPath ?? "",
      version: candidate.version ?? "v1",
      apiCompat: candidate.apiCompat,
      ...((candidate.tokenCountMode ?? provider.tokenCountMode)
        ? { tokenCountMode: candidate.tokenCountMode ?? provider.tokenCountMode }
        : {}),
    },
    modelId: candidate.modelId,
    apiCompat: candidate.apiCompat,
    ...(candidate.manualSpec ? { manualSpec: candidate.manualSpec } : {}),
    ...(candidate.modelsDevMapping ? { modelsDevMapping: candidate.modelsDevMapping } : {}),
  };
}
