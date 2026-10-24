import path from "node:path";
import type { CodexCatalogModelView } from "../shared/models";
import { AccountModelCatalogService, type AccountModelCatalogServiceOptions } from "./account-model-catalog";

export const CODEX_MODELS_JSON_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
export const CODEX_MODEL_CATALOG_CACHE_FILE_NAME = "codex-model-catalog.json";
export type CodexRemoteModelCatalogServiceOptions = Omit<
  AccountModelCatalogServiceOptions,
  "catalogName" | "sourceUrl" | "fetchModels"
> & { sourceUrl?: string };

export class CodexRemoteModelCatalogService extends AccountModelCatalogService {
  constructor(options: CodexRemoteModelCatalogServiceOptions) {
    const sourceUrl = options.sourceUrl?.trim() || CODEX_MODELS_JSON_URL;
    super({
      ...options,
      sourceUrl,
      catalogName: "Codex",
      fetchModels: async (signal) => {
        const response = await (options.fetchImpl ?? fetch)(sourceUrl, {
          headers: { accept: "application/json" },
          signal,
        });
        if (!response.ok) throw new Error(`Codex 模型目录获取失败：HTTP ${response.status}`);
        return parseCodexModelsJson(await response.text());
      },
    });
  }
}

/**
 * Parse the codex-rs models.json document into the trimmed Eco view. Throws on
 * anything malformed: a truncated or renamed catalog must surface as a refresh
 * error instead of silently shrinking the model list.
 */
export function parseCodexModelsJson(raw: string): CodexCatalogModelView[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex models.json 解析失败：${message}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    throw new Error('Codex models.json 缺少 "models" 数组。');
  }

  const entries: CodexCatalogModelView[] = [];
  const seen = new Set<string>();
  for (const [index, value] of parsed.models.entries()) {
    if (!isRecord(value)) {
      throw new Error(`Codex models.json models[${index}] 不是对象。`);
    }
    const modelId = readTrimmedString(value.slug);
    if (!modelId) {
      throw new Error(`Codex models.json models[${index}] 缺少 slug。`);
    }
    if (seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    entries.push(trimRemoteEntry(value, modelId));
  }
  if (entries.length === 0) {
    throw new Error("Codex models.json 没有任何模型。");
  }
  return entries;
}

function trimRemoteEntry(value: Record<string, unknown>, modelId: string): CodexCatalogModelView {
  const entry: CodexCatalogModelView = {
    modelId,
    displayName: readTrimmedString(value.display_name) ?? modelId,
    reasoningEfforts: Array.isArray(value.supported_reasoning_levels)
      ? value.supported_reasoning_levels
          .filter(isRecord)
          .map((level) => readTrimmedString(level.effort))
          .filter((effort): effort is string => Boolean(effort))
      : [],
    hidden: readTrimmedString(value.visibility) === "hide",
    origin: "remote",
  };

  const description = readTrimmedString(value.description);
  if (description) entry.description = description;
  const contextWindow = readPositiveNumber(value.context_window);
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  const maxContextWindow = readPositiveNumber(value.max_context_window);
  if (maxContextWindow !== undefined) entry.maxContextWindow = maxContextWindow;
  const defaultReasoningEffort = readTrimmedString(value.default_reasoning_level);
  if (defaultReasoningEffort) entry.defaultReasoningEffort = defaultReasoningEffort;
  const priority = readFiniteNumber(value.priority);
  if (priority !== undefined) entry.priority = priority;
  if (Array.isArray(value.input_modalities)) {
    entry.supportsImageInput = value.input_modalities.includes("image");
  }
  return entry;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveCodexModelCatalogCachePath(ecoDataDir: string): string {
  return path.join(ecoDataDir, CODEX_MODEL_CATALOG_CACHE_FILE_NAME);
}
