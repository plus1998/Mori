import { z } from "zod";
import type {
  CandidateModelInput,
  CandidateModelView,
  ProviderConfigInput,
  ProviderConfigView,
  ProviderDeleteResult,
} from "../shared/ipc";
import type {
  AddCodexCatalogModelRequest,
  ListUpstreamModelsResult,
  TestProviderConnectionResult,
} from "../shared/models";
import { UPSTREAM_API_COMPAT_CYCLE } from "../shared/api-compat";
import { PROVIDER_TOKEN_COUNT_MODES } from "../shared/provider-token-count";
import type { McpToolDefinition } from "./mcp-streamable-http";

const id = z.string().trim().min(1);
const manualSpec = z.strictObject({
  contextTokens: z.number().int().positive().nullable().optional(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  supportsImageInput: z.boolean().nullable().optional(),
  supportsReasoning: z.boolean().nullable().optional(),
  supportsNativeWebSearch: z.boolean().nullable().optional(),
  supportsRemoteCompaction: z.boolean().nullable().optional(),
  inputPerM: z.number().nonnegative().nullable().optional(),
  outputPerM: z.number().nonnegative().nullable().optional(),
  cacheReadPerM: z.number().nonnegative().nullable().optional(),
  cacheWritePerM: z.number().nonnegative().nullable().optional(),
  priceMultiplier: z.number().nonnegative().nullable().optional(),
});
const schemas = {
  list_providers: z.strictObject({}),
  save_provider: z.strictObject({
    id: id.optional(),
    name: id.optional(),
    baseUrl: z.url().optional(),
    requestPath: z.string().optional(),
    version: z.string().optional(),
    apiCompat: z.enum(UPSTREAM_API_COMPAT_CYCLE).optional(),
    tokenCountMode: z.enum(PROVIDER_TOKEN_COUNT_MODES).optional(),
    apiKey: z.string().min(1).optional().describe("Write-only API key. Omit to preserve the saved key."),
    upstreamProxyUrl: z.string().optional(),
    defaultModel: z
      .string()
      .optional()
      .describe(
        "Fallback when no models are configured. With configured models, the first model is the default; use reorder_models to change it.",
      ),
    enabled: z.boolean().optional(),
  }),
  delete_provider: z.strictObject({ providerId: id }),
  list_models: z.strictObject({ providerId: id, source: z.enum(["saved", "upstream"]).optional() }),
  save_model: z.strictObject({
    providerId: id,
    modelId: id,
    displayName: z.string().optional(),
    modelsDevMapping: z.strictObject({ providerKey: id, modelId: id }).nullable().optional(),
    manualSpec: manualSpec.nullable().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  }),
  delete_model: z.strictObject({ providerId: id, modelId: id }),
  import_models: z.strictObject({ providerId: id, modelIds: z.array(id).min(1).max(500) }),
  reorder_models: z.strictObject({ providerId: id, modelIds: z.array(id).max(500) }),
  test_provider: z.strictObject({ providerId: id, modelId: id }),
  refresh_model_catalog: z.strictObject({ providerId: id }),
};
type ToolName = keyof typeof schemas;
const descriptions: Record<ToolName, string> = {
  list_providers:
    "List Mori's global providers (供应商) and their model sources. API keys are never returned. Built-in account providers are read-only here.",
  save_provider:
    "Add or partially update an API provider (供应商); supports enable/disable, endpoint, protocol and write-only API key. Omit id to create (name and baseUrl required); pass an existing id to update. Omitted fields and saved credentials are preserved. Does not perform account login.",
  delete_provider:
    "Delete a custom provider and its models, dependent main-agent configurations and subagent orchestrations. Active conversations block deletion. Read settings and explain the deletion impact first. Built-in account providers cannot be deleted here.",
  list_models:
    "List models (模型) for a provider. source=saved (default) lists configured models with capabilities/pricing; source=upstream discovers available models without importing. Account providers use their real account catalog.",
  save_model:
    "Add or partially update a configured model by providerId/modelId. Omitted fields are preserved. manualSpec fields override capabilities and USD pricing per million tokens; null clears an override. Account catalogs support modelId/displayName only; unsupported edits fail explicitly.",
  delete_model:
    "Delete a configured model by providerId/modelId. For account catalogs this removes a manual addition only; remote models cannot be deleted.",
  import_models:
    "Import selected upstream model IDs into a custom provider without replacing existing model configuration. Does not invent or auto-select model IDs. Account catalogs use save_model for manual additions.",
  reorder_models:
    "Order all configured models of a custom provider. Supply every modelId exactly once; the first becomes the provider default model.",
  test_provider:
    "Send a small real request using an API provider's saved credentials and the specified modelId. May incur upstream API usage. Account login providers use their account settings for connection testing. Report failures accurately.",
  refresh_model_catalog:
    "Refresh the real model catalog of a Codex Auth or ChatGPT subscription provider. For API providers use list_models with source=upstream.",
};
const readOnly = new Set<ToolName>(["list_providers", "list_models"]);
export const modelManagementTools = Object.entries(schemas).map(
  ([name, schema]) =>
    ({
      name,
      description: descriptions[name as ToolName],
      inputSchema: z.toJSONSchema(schema),
      annotations: {
        readOnlyHint: readOnly.has(name as ToolName),
        destructiveHint: name.startsWith("delete_"),
        openWorldHint: ["list_models", "test_provider", "refresh_model_catalog"].includes(name),
      },
    }) satisfies McpToolDefinition,
);

export type ModelSource = "provider" | "codex_catalog" | "chatgpt_catalog";
export interface ModelManagementBackend {
  listProviders(): ProviderConfigView[];
  modelSource(providerId: string): ModelSource;
  saveProvider(input: ProviderConfigInput): Promise<ProviderConfigView>;
  deleteProvider(providerId: string): Promise<ProviderDeleteResult>;
  listModels(providerId: string): Promise<CandidateModelView[]>;
  listUpstreamModels(providerId: string): Promise<ListUpstreamModelsResult>;
  saveModel(input: CandidateModelInput): Promise<CandidateModelView>;
  deleteModel(id: string): Promise<unknown>;
  importModels(providerId: string, modelIds: string[]): CandidateModelView[];
  reorderModels(providerId: string, candidateIds: string[]): void;
  testProvider(providerId: string, modelId: string): Promise<TestProviderConnectionResult>;
  saveCatalogModel(
    source: Exclude<ModelSource, "provider">,
    input: AddCodexCatalogModelRequest,
  ): Promise<void>;
  deleteCatalogModel(source: Exclude<ModelSource, "provider">, modelId: string): Promise<boolean>;
  refreshCatalog(source: Exclude<ModelSource, "provider">): Promise<void>;
}

/** Shared desktop actions remain responsible for persistence, reference checks and settings notifications. */
export class ModelManagementService {
  constructor(private readonly backend: ModelManagementBackend) {}

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "list_providers": {
        schemas.list_providers.parse(args);
        return { providers: this.backend.listProviders().map((provider) => this.providerView(provider)) };
      }
      case "save_provider": {
        const input = schemas.save_provider.parse(args);
        const existing = input.id ? this.requireProvider(input.id) : undefined;
        if (existing) this.requireCustomProvider(existing.id);
        let base: ProviderConfigInput;
        if (existing) base = providerInput(existing);
        else {
          if (!input.name || !input.baseUrl) throw new Error("新增供应商必须提供 name 和 baseUrl。");
          base = {
            name: input.name,
            baseUrl: input.baseUrl,
            defaultModel: "",
            enabled: true,
            authMethod: "api_key",
          };
        }
        const patch = Object.fromEntries(
          Object.entries(input).filter(([, value]) => value !== undefined),
        ) as Partial<ProviderConfigInput>;
        const saved = await this.backend.saveProvider({ ...base, ...patch });
        return this.providerView(saved);
      }
      case "delete_provider": {
        const { providerId } = schemas.delete_provider.parse(args);
        this.requireCustomProvider(providerId);
        return this.backend.deleteProvider(providerId);
      }
      case "list_models": {
        const { providerId, source } = schemas.list_models.parse(args);
        this.requireProvider(providerId);
        return source === "upstream"
          ? this.backend.listUpstreamModels(providerId)
          : { models: await this.backend.listModels(providerId) };
      }
      case "save_model": {
        const input = schemas.save_model.parse(args);
        this.requireProvider(input.providerId);
        const source = this.backend.modelSource(input.providerId);
        if (source !== "provider") {
          if (
            input.manualSpec !== undefined ||
            input.modelsDevMapping !== undefined ||
            input.sortOrder !== undefined
          )
            throw new Error("账号模型目录仅支持 modelId 和 displayName，不能修改能力、价格或排序。");
          await this.backend.saveCatalogModel(source, {
            modelId: input.modelId,
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          });
          return { models: await this.backend.listModels(input.providerId) };
        }
        const models = await this.backend.listModels(input.providerId);
        const existing = models.find((model) => model.modelId === input.modelId);
        const mergedSpec =
          input.manualSpec === null ? undefined : mergeOverrides(existing?.manualSpec, input.manualSpec);
        const mapping =
          input.modelsDevMapping === null
            ? undefined
            : (input.modelsDevMapping ?? existing?.modelsDevMapping);
        const displayName = input.displayName ?? existing?.displayName;
        return this.backend.saveModel({
          providerId: input.providerId,
          modelId: input.modelId,
          ...(existing ? { id: existing.id } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
          ...(mapping ? { modelsDevMapping: mapping } : {}),
          ...(mergedSpec ? { manualSpec: mergedSpec } : {}),
          sortOrder:
            input.sortOrder ??
            existing?.sortOrder ??
            Math.max(-1, ...models.map((model) => model.sortOrder)) + 1,
        });
      }
      case "delete_model": {
        const { providerId, modelId } = schemas.delete_model.parse(args);
        this.requireProvider(providerId);
        const source = this.backend.modelSource(providerId);
        if (source !== "provider") {
          if (!(await this.backend.deleteCatalogModel(source, modelId)))
            throw new Error(`未删除模型：${modelId} 不是手动添加的账号模型，或已不存在。`);
        } else {
          const model = (await this.backend.listModels(providerId)).find((item) => item.modelId === modelId);
          if (!model) throw new Error(`找不到模型：${modelId}`);
          await this.backend.deleteModel(model.id);
        }
        return { ok: true };
      }
      case "import_models": {
        const { providerId, modelIds } = schemas.import_models.parse(args);
        this.requireCustomProvider(providerId);
        return { models: this.backend.importModels(providerId, [...new Set(modelIds)]) };
      }
      case "reorder_models": {
        const { providerId, modelIds } = schemas.reorder_models.parse(args);
        this.requireCustomProvider(providerId);
        const models = await this.backend.listModels(providerId);
        if (modelIds.length !== models.length || new Set(modelIds).size !== models.length)
          throw new Error("排序必须包含该供应商的全部 modelId，且每个只能出现一次。");
        const candidateIds: string[] = [];
        for (const id of modelIds) {
          const model = models.find((model) => model.modelId === id);
          if (!model) throw new Error(`找不到模型：${id}`);
          candidateIds.push(model.id);
        }
        this.backend.reorderModels(providerId, candidateIds);
        return { ok: true };
      }
      case "test_provider": {
        const { providerId, modelId } = schemas.test_provider.parse(args);
        this.requireCustomProvider(providerId);
        return this.backend.testProvider(providerId, modelId);
      }
      case "refresh_model_catalog": {
        const { providerId } = schemas.refresh_model_catalog.parse(args);
        this.requireProvider(providerId);
        const source = this.backend.modelSource(providerId);
        if (source === "provider")
          throw new Error("API 供应商请使用 list_models 的 source=upstream 获取上游列表。");
        await this.backend.refreshCatalog(source);
        return { models: await this.backend.listModels(providerId) };
      }
      default:
        throw new Error(`未知模型管理工具：${name}`);
    }
  }

  private requireProvider(id: string): ProviderConfigView {
    const provider = this.backend.listProviders().find((item) => item.id === id);
    if (!provider) throw new Error(`找不到供应商：${id}`);
    return provider;
  }
  private requireCustomProvider(id: string): void {
    this.requireProvider(id);
    if (this.backend.modelSource(id) !== "provider")
      throw new Error("内置账号供应商请在账号设置中管理；模型请使用账号模型目录工具。");
  }
  private providerView(provider: ProviderConfigView) {
    const { apiKeyPreview: _preview, upstreamProxyUrl, ...view } = provider;
    return {
      ...view,
      ...(upstreamProxyUrl ? { upstreamProxyUrl: redactUrlCredentials(upstreamProxyUrl) } : {}),
      modelSource: this.backend.modelSource(provider.id),
    };
  }
}

function providerInput(provider: ProviderConfigView): ProviderConfigInput {
  const {
    hasApiKey: _key,
    apiKeyPreview: _preview,
    createdAt: _created,
    updatedAt: _updated,
    ...input
  } = provider;
  return input;
}

function mergeOverrides(
  existing: CandidateModelInput["manualSpec"],
  patch: z.infer<typeof manualSpec> | undefined,
): CandidateModelInput["manualSpec"] {
  const merged = { ...existing, ...patch };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null));
}

function redactUrlCredentials(value: string): string {
  const url = new URL(value);
  if (url.username) url.username = "redacted";
  if (url.password) url.password = "redacted";
  return url.toString();
}
