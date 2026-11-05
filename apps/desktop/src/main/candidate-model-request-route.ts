import { type GatewayProvider, mapApiCompatToUpstreamKind, normalizeProvider } from "@eco/gateway";
import type { CandidateModelView } from "../shared/ipc";
import { normalizeProviderTokenCountMode } from "../shared/provider-token-count";
import type { ProviderConfigSecret, ProviderStore } from "./provider-store";

export interface CandidateModelRequestRoute {
  candidate: CandidateModelView;
  provider: ProviderConfigSecret;
  gatewayProvider: GatewayProvider;
}

/** Capture one database snapshot for this physical request, including count_tokens. */
export function resolveCandidateModelRequestRoute(
  store: Pick<ProviderStore, "getCandidateModel" | "getProviderWithSecret">,
  candidateId: string,
): CandidateModelRequestRoute {
  const candidate = store.getCandidateModel(candidateId);
  if (!candidate) throw new Error(`候选模型 ${candidateId} 已不存在，请重新选择。`);
  const supplier = store.getProviderWithSecret(candidate.providerId);
  if (!supplier) throw new Error(`候选模型 ${candidateId} 的供应商不存在。`);
  if (!supplier.enabled) throw new Error(`供应商 ${supplier.name} 已停用。`);
  if (!candidate.baseUrl || !candidate.apiCompat)
    throw new Error(`模型 ${candidate.modelId} 缺少端点或协议，请重新选择供应商端点。`);
  if (candidate.apiCompat === "system_one") throw new Error("SystemOne 模型仅可用于审批，不能发起模型请求。");
  const provider = {
    ...supplier,
    baseUrl: candidate.baseUrl,
    requestPath: candidate.requestPath ?? "",
    version: candidate.version ?? "v1",
    apiCompat: candidate.apiCompat,
    tokenCountMode: normalizeProviderTokenCountMode(candidate.tokenCountMode),
  };
  const model = candidate.modelId;
  const gatewayProvider = normalizeProvider({
    id: supplier.id,
    name: supplier.name,
    baseUrl: provider.baseUrl,
    requestPath: provider.requestPath,
    version: provider.version,
    upstreamKind: mapApiCompatToUpstreamKind(candidate.apiCompat),
    apiKey: supplier.apiKey || "local-unused",
    ...(supplier.authMethod ? { authMethod: supplier.authMethod } : {}),
    ...(supplier.credentialPoolId ? { credentialPoolId: supplier.credentialPoolId } : {}),
    ...(supplier.upstreamProxyUrl ? { upstreamProxyUrl: supplier.upstreamProxyUrl } : {}),
    upstreamModelId: model,
    models: [model],
    tokenCountMode: provider.tokenCountMode,
    ...(candidate.manualSpec?.maxOutputTokens
      ? { modelMaxOutputTokens: { [model]: candidate.manualSpec.maxOutputTokens } }
      : {}),
    ...(candidate.manualSpec?.supportsImageInput !== undefined
      ? { modelSupportsImageInput: { [model]: candidate.manualSpec.supportsImageInput } }
      : {}),
  });
  return { candidate, provider, gatewayProvider };
}
