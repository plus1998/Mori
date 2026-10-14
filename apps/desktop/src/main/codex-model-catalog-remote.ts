import fs from "node:fs/promises";
import path from "node:path";
import type {
  CodexCatalogModelOrigin,
  CodexCatalogModelView,
  CodexModelCatalogStatusView,
} from "../shared/models";

/**
 * Codex account (auth.json) model catalog.
 *
 * The built-in Codex provider has no upstream /v1/models endpoint, so its model
 * list used to be a constant compiled into the desktop client — every new OpenAI
 * model needed a client release. The list now comes from the codex-rs
 * models-manager catalog, cached on disk so the picker still works offline, with
 * an explicit refresh action and user-added models.
 */
export const CODEX_MODELS_JSON_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
export const CODEX_MODEL_CATALOG_CACHE_FILE_NAME = "codex-model-catalog.json";
/** A cached catalog older than this is refetched the next time the picker opens. */
export const CODEX_MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const CODEX_MODEL_CATALOG_FETCH_TIMEOUT_MS = 15_000;
/** After a failed background refetch, wait this long before the picker tries again. */
export const CODEX_MODEL_CATALOG_FAILURE_RETRY_MS = 5 * 60 * 1000;
const CODEX_MODEL_CATALOG_DOCUMENT_VERSION = 1;

interface CodexModelCatalogDocument {
  version: number;
  sourceUrl: string;
  fetchedAt?: number;
  lastError?: string;
  remote: CodexCatalogModelView[];
  manual: CodexCatalogModelView[];
}

export interface CodexRemoteModelCatalogServiceOptions {
  cachePath: string;
  sourceUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  fetchTimeoutMs?: number;
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

export class CodexRemoteModelCatalogService {
  private readonly sourceUrl: string;
  private readonly ttlMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly now: () => number;
  private document: CodexModelCatalogDocument | undefined;
  private loading: Promise<CodexModelCatalogDocument> | undefined;
  private failedAt = 0;

  constructor(private readonly options: CodexRemoteModelCatalogServiceOptions) {
    this.sourceUrl = options.sourceUrl?.trim() || CODEX_MODELS_JSON_URL;
    this.ttlMs = options.ttlMs ?? CODEX_MODEL_CATALOG_TTL_MS;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? CODEX_MODEL_CATALOG_FETCH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Visible models: non-hidden remote entries plus user-added ones, in Codex priority order. */
  async listModels(): Promise<CodexCatalogModelView[]> {
    const document = await this.ensureDocument();
    await this.refreshIfStale(document);
    return selectVisibleModels(document);
  }

  /** Force a network refresh. Throws when the catalog cannot be fetched or parsed. */
  async refresh(): Promise<CodexCatalogModelView[]> {
    const document = await this.ensureDocument();
    await this.fetchInto(document);
    return selectVisibleModels(document);
  }

  async getStatus(): Promise<CodexModelCatalogStatusView> {
    const document = await this.ensureDocument();
    const status: CodexModelCatalogStatusView = {
      sourceUrl: this.sourceUrl,
      remoteCount: document.remote.length,
      manualCount: document.manual.length,
    };
    if (document.fetchedAt !== undefined) status.fetchedAt = document.fetchedAt;
    if (document.lastError) status.lastError = document.lastError;
    return status;
  }

  async addManualModel(input: { modelId: string; displayName?: string }): Promise<CodexCatalogModelView> {
    const modelId = input.modelId?.trim() ?? "";
    if (!modelId) {
      throw new Error("Model ID 不能为空。");
    }
    if (/\s/.test(modelId)) {
      throw new Error("Model ID 不能包含空格。");
    }
    const document = await this.ensureDocument();
    // Fetch first so the duplicate check sees the upstream catalog, not just manual rows.
    await this.refreshIfStale(document);
    const existing = [...document.remote, ...document.manual].find((entry) => entry.modelId === modelId);
    if (existing) {
      throw new Error(
        existing.origin === "remote"
          ? `${modelId} 已存在于 Codex 模型目录中。`
          : `${modelId} 已在手动添加的模型中。`,
      );
    }
    const entry: CodexCatalogModelView = {
      modelId,
      displayName: input.displayName?.trim() || modelId,
      reasoningEfforts: [],
      hidden: false,
      origin: "manual",
    };
    document.manual.push(entry);
    await this.persist(document);
    return { ...entry };
  }

  /** Manual entries only: remote entries follow the upstream catalog and cannot be deleted. */
  async removeManualModel(modelId: string): Promise<boolean> {
    const trimmed = modelId.trim();
    const document = await this.ensureDocument();
    const index = document.manual.findIndex((entry) => entry.modelId === trimmed);
    if (index < 0) {
      return false;
    }
    document.manual.splice(index, 1);
    await this.persist(document);
    return true;
  }

  /** Cached list stays usable when the refetch fails; the failure lands in status.lastError. */
  private async refreshIfStale(document: CodexModelCatalogDocument): Promise<void> {
    if (!this.isStale(document)) {
      return;
    }
    // A dead network must not make every picker open wait for the fetch timeout.
    if (this.failedAt && this.now() - this.failedAt < CODEX_MODEL_CATALOG_FAILURE_RETRY_MS) {
      return;
    }
    try {
      await this.fetchInto(document);
    } catch {
      this.failedAt = this.now();
    }
  }

  private isStale(document: CodexModelCatalogDocument): boolean {
    if (document.remote.length === 0 || document.fetchedAt === undefined) {
      return true;
    }
    return this.now() - document.fetchedAt >= this.ttlMs;
  }

  private async ensureDocument(): Promise<CodexModelCatalogDocument> {
    if (this.document) {
      return this.document;
    }
    if (!this.loading) {
      this.loading = this.loadFromDisk().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  private async loadFromDisk(): Promise<CodexModelCatalogDocument> {
    if (this.document) {
      return this.document;
    }
    const empty = (): CodexModelCatalogDocument => ({
      version: CODEX_MODEL_CATALOG_DOCUMENT_VERSION,
      sourceUrl: this.sourceUrl,
      remote: [],
      manual: [],
    });

    let raw: string;
    try {
      raw = await fs.readFile(this.options.cachePath, "utf8");
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      this.document = empty();
      return this.document;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      this.document = empty();
      this.document.lastError = "本地 Codex 模型缓存已损坏，请手动刷新。";
      return this.document;
    }

    this.document = normalizeCachedDocument(parsed, this.sourceUrl);
    return this.document;
  }

  private async fetchInto(document: CodexModelCatalogDocument): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const response = await fetchImpl(this.sourceUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Codex 模型目录获取失败：HTTP ${response.status}`);
      }
      const remote = parseCodexModelsJson(await response.text());
      document.remote = remote;
      document.fetchedAt = this.now();
      delete document.lastError;
      await this.persist(document);
    } catch (error) {
      document.lastError = error instanceof Error ? error.message : String(error);
      await this.persist(document);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async persist(document: CodexModelCatalogDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.options.cachePath), { recursive: true });
    const tempPath = `${this.options.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(document, null, 2), "utf8");
    await fs.rename(tempPath, this.options.cachePath);
  }
}

function selectVisibleModels(document: CodexModelCatalogDocument): CodexCatalogModelView[] {
  const visible = [...document.remote.filter((entry) => !entry.hidden), ...document.manual];
  return visible.sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.modelId.localeCompare(right.modelId);
  });
}

function normalizeCachedDocument(value: unknown, sourceUrl: string): CodexModelCatalogDocument {
  const document: CodexModelCatalogDocument = {
    version: CODEX_MODEL_CATALOG_DOCUMENT_VERSION,
    sourceUrl,
    remote: [],
    manual: [],
  };
  if (!isRecord(value)) {
    return document;
  }
  const fetchedAt = readFiniteNumber(value.fetchedAt);
  if (fetchedAt !== undefined) document.fetchedAt = fetchedAt;
  const lastError = readTrimmedString(value.lastError);
  if (lastError) document.lastError = lastError;
  if (Array.isArray(value.remote)) {
    document.remote = value.remote
      .filter(isRecord)
      .map((entry) => normalizeCachedEntry(entry, "remote"))
      .filter((entry) => entry.modelId);
  }
  if (Array.isArray(value.manual)) {
    document.manual = value.manual
      .filter(isRecord)
      .map((entry) => normalizeCachedEntry(entry, "manual"))
      .filter((entry) => entry.modelId);
  }
  return document;
}

function normalizeCachedEntry(
  entry: Record<string, unknown>,
  origin: CodexCatalogModelOrigin,
): CodexCatalogModelView {
  const modelId = readTrimmedString(entry.modelId) ?? "";
  const normalized: CodexCatalogModelView = {
    modelId,
    displayName: readTrimmedString(entry.displayName) ?? modelId,
    reasoningEfforts: Array.isArray(entry.reasoningEfforts)
      ? entry.reasoningEfforts.filter((effort): effort is string => typeof effort === "string")
      : [],
    hidden: entry.hidden === true,
    origin,
  };
  const description = readTrimmedString(entry.description);
  if (description) normalized.description = description;
  const contextWindow = readPositiveNumber(entry.contextWindow);
  if (contextWindow !== undefined) normalized.contextWindow = contextWindow;
  const maxContextWindow = readPositiveNumber(entry.maxContextWindow);
  if (maxContextWindow !== undefined) normalized.maxContextWindow = maxContextWindow;
  const defaultReasoningEffort = readTrimmedString(entry.defaultReasoningEffort);
  if (defaultReasoningEffort) normalized.defaultReasoningEffort = defaultReasoningEffort;
  const priority = readFiniteNumber(entry.priority);
  if (priority !== undefined) normalized.priority = priority;
  if (typeof entry.supportsImageInput === "boolean") normalized.supportsImageInput = entry.supportsImageInput;
  return normalized;
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

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function resolveCodexModelCatalogCachePath(ecoDataDir: string): string {
  return path.join(ecoDataDir, CODEX_MODEL_CATALOG_CACHE_FILE_NAME);
}
