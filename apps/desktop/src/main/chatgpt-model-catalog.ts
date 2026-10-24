import path from "node:path";
import type { UpstreamModelOption } from "../shared/models";
import { AccountModelCatalogService, type AccountModelCatalogServiceOptions } from "./account-model-catalog";

export const CHATGPT_MODELS_URL = "https://api.openai.com/v1/models";
export const CHATGPT_MODEL_CATALOG_CACHE_FILE_NAME = "chatgpt-model-catalog.json";

export type ChatGptModelCatalogOptions = Omit<
  AccountModelCatalogServiceOptions,
  "catalogName" | "sourceUrl" | "fetchModels"
> & {
  fetchModels: (signal: AbortSignal, accountId?: string) => Promise<UpstreamModelOption[]>;
};

export class ChatGptModelCatalogService extends AccountModelCatalogService {
  constructor(options: ChatGptModelCatalogOptions) {
    super({
      ...options,
      catalogName: "ChatGPT OAuth",
      sourceUrl: CHATGPT_MODELS_URL,
      fetchModels: async (signal, accountId) => {
        const models = await options.fetchModels(signal, accountId);
        if (!models.length) throw new Error("官方 ChatGPT 模型列表为空。");
        return models.map((model) => ({
          modelId: model.id,
          displayName: model.displayName || model.id,
          reasoningEfforts: [],
          hidden: false,
          origin: "remote" as const,
        }));
      },
    });
  }
}

export function resolveChatGptModelCatalogCachePath(dataDir: string): string {
  return path.join(dataDir, CHATGPT_MODEL_CATALOG_CACHE_FILE_NAME);
}
