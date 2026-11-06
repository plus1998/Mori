import type { AuxiliaryModelSelection } from "../shared/auxiliary-model";
import type { CandidateModelView } from "../shared/ipc";
import type { ProviderConfigSecret, ProviderStore } from "./provider-store";

/** OAuth model identities come from the selected account, not the API-key candidate database. */
export function resolveStatelessModelCandidate(
  selection: AuxiliaryModelSelection,
  provider: ProviderConfigSecret,
  store: ProviderStore,
): CandidateModelView | undefined {
  const catalogue = store.listStatelessModelCandidates(provider.id);
  if (provider.authMethod !== "chatgpt_subscription") {
    return catalogue.find((model) => model.id === selection.candidateModelId);
  }
  if (!selection.accountId?.trim()) throw new Error("ChatGPT OAuth 模型尚未选择账号，请先选择账号和模型。");
  const id = `account:${encodeURIComponent(provider.id)}:${encodeURIComponent(selection.modelId)}`;
  if (selection.candidateModelId !== id)
    throw new Error("ChatGPT OAuth 模型标识不匹配，请重新选择账号和模型。");
  // The shared cache supplies capability hints only. A different account's catalogue
  // must not invalidate a model selected from this account's official model list.
  const hints = catalogue.find((model) => model.id === id);
  return {
    id,
    providerId: provider.id,
    modelId: selection.modelId,
    baseUrl: provider.baseUrl,
    requestPath: provider.requestPath,
    version: provider.version,
    apiCompat: "openai_responses",
    tokenCountMode: "openai_responses",
    ...(hints?.manualSpec ? { manualSpec: hints.manualSpec } : {}),
    sortOrder: 0,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}
