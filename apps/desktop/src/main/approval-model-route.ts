import type { GlobalMaxOutputTokens } from "@eco/runtime";
import type { ApprovalModelSelection } from "../shared/approval-model";
import type { AnthropicProxyRoute } from "./anthropic-proxy";
import { resolveAuxiliaryModelRoute } from "./auxiliary-model-route";
import type { ProviderConfigSecret, ProviderStore } from "./provider-store";

export interface SystemOneApprovalRoute {
  kind: "system_one";
  provider: ProviderConfigSecret;
  modelId: string;
}
export type ApprovalModelRoute = AnthropicProxyRoute | SystemOneApprovalRoute;

export function resolveApprovalModelRoute(
  selection: ApprovalModelSelection | undefined,
  providerStore: ProviderStore,
  options?: {
    globalMaxOutputTokens?: GlobalMaxOutputTokens;
    contextTokens?: number;
    catalogMaxOutputTokens?: number;
    globalContextWindowLimit?: number;
  },
): ApprovalModelRoute {
  if (!selection) throw new Error("未配置审批模型。请在运行配置中选择审批模型。");
  const provider = providerStore
    .listProvidersWithSecrets()
    .find((entry) => entry.id === selection.providerId && entry.enabled);
  if (!provider) throw new Error(`审批模型所属 Provider 不存在或已禁用：${selection.providerId}`);
  const candidate = providerStore
    .listCandidateModels(provider.id)
    .find((entry) => entry.id === selection.candidateModelId);
  if (!candidate) throw new Error(`审批模型已不在候选模型列表中：${selection.candidateModelId}`);
  if (candidate.modelId.trim() !== selection.modelId.trim()) {
    throw new Error(
      `审批模型配置已发生变化：预期 ${selection.modelId}，当前 ${candidate.modelId}。请重新选择。`,
    );
  }
  if (provider.apiCompat === "system_one") {
    return { kind: "system_one", provider, modelId: candidate.modelId };
  }
  return resolveAuxiliaryModelRoute(selection, providerStore, options);
}
