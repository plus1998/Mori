import {
  DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
  type GlobalMaxOutputTokens,
  resolveEffectiveContextLimit,
} from "@eco/runtime";
import type { AuxiliaryModelSelection } from "../shared/auxiliary-model";
import { type AnthropicProxyRoute, runtimeRouteToProxyRoute } from "./anthropic-proxy";
import type { ProviderStore } from "./provider-store";

export function resolveAuxiliaryModelRoute(
  selection: AuxiliaryModelSelection | undefined,
  providerStore: ProviderStore,
  options?: {
    globalMaxOutputTokens?: GlobalMaxOutputTokens;
    contextTokens?: number;
    catalogMaxOutputTokens?: number;
    globalContextWindowLimit?: number;
  },
): AnthropicProxyRoute {
  if (!selection) {
    throw new Error("未配置辅助模型。请在 Composer 的运行配置中选择辅助模型。");
  }
  const provider = providerStore
    .listProvidersWithSecrets()
    .find((candidate) => candidate.id === selection.providerId && candidate.enabled);
  if (!provider) {
    throw new Error(`辅助模型所属 Provider 不存在或已禁用：${selection.providerId}`);
  }
  const candidate = providerStore
    .listCandidateModels(provider.id)
    .find((model) => model.id === selection.candidateModelId);
  if (!candidate) {
    throw new Error(`辅助模型已不在候选模型列表中：${selection.candidateModelId}`);
  }
  if (candidate.modelId.trim() !== selection.modelId.trim()) {
    throw new Error(
      `辅助模型配置已发生变化：预期 ${selection.modelId}，当前 ${candidate.modelId}。请重新选择。`,
    );
  }
  const contextTokens = options?.contextTokens ?? candidate.manualSpec?.contextTokens;
  return runtimeRouteToProxyRoute(
    {
      role: "auxiliary",
      provider,
      modelId: candidate.modelId,
      apiCompat: provider.apiCompat,
      ...(candidate.manualSpec ? { manualSpec: candidate.manualSpec } : {}),
    },
    {
      ...(options?.globalMaxOutputTokens !== undefined && {
        globalMaxOutputTokens: options.globalMaxOutputTokens,
      }),
      ...(contextTokens !== undefined && {
        contextTokens: resolveEffectiveContextLimit(
          contextTokens,
          options?.globalContextWindowLimit ?? DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT,
        ),
      }),
      ...(options?.catalogMaxOutputTokens !== undefined && {
        catalogMaxOutputTokens: options.catalogMaxOutputTokens,
      }),
    },
  );
}
