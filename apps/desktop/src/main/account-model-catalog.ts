import fs from "node:fs/promises";
import path from "node:path";
import type { ModelCostRates, ParsedUsage } from "@eco/runtime";
import type {
  CodexApiPricing,
  CodexCatalogModelOrigin,
  CodexCatalogModelView,
  CodexModelCatalogStatusView,
} from "../shared/models";
import {
  isCodexApiPricing,
  OPENAI_API_PRICING_URL,
  parseOpenAiApiPricing,
  resolveOpenAiApiRates,
} from "./openai-api-pricing";

const ACCOUNT_MODEL_CATALOG_FETCH_TIMEOUT_MS = 15_000;
const ACCOUNT_MODEL_CATALOG_DOCUMENT_VERSION = 2;

interface AccountModelCatalogDocument {
  version: number;
  sourceUrl: string;
  fetchedAt?: number;
  lastError?: string;
  remote: CodexCatalogModelView[];
  manual: CodexCatalogModelView[];
  pricing: Record<string, CodexApiPricing>;
  pricingFetchedAt?: number;
}

export interface AccountModelCatalogServiceOptions {
  cachePath: string;
  catalogName: string;
  sourceUrl: string;
  fetchModels: (signal: AbortSignal, accountId?: string) => Promise<CodexCatalogModelView[]>;
  pricingSourceUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
  onContextWindowsChanged?: () => void;
}

export class AccountModelCatalogService {
  private readonly sourceUrl: string;
  private readonly pricingSourceUrl: string;
  private readonly fetchTimeoutMs: number;
  private readonly now: () => number;
  private document: AccountModelCatalogDocument | undefined;
  private loading: Promise<AccountModelCatalogDocument> | undefined;
  private fetching: Promise<void> | undefined;

  constructor(private readonly options: AccountModelCatalogServiceOptions) {
    this.sourceUrl = options.sourceUrl;
    this.pricingSourceUrl = options.pricingSourceUrl?.trim() || OPENAI_API_PRICING_URL;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? ACCOUNT_MODEL_CATALOG_FETCH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** Synchronous settings snapshots use this after the startup disk read. */
  getLoadedDefaultModelId(): string | undefined {
    return this.document ? selectVisibleModels(this.document)[0]?.modelId : undefined;
  }

  /** Visible models: non-hidden remote entries plus user-added ones, in Codex priority order. */
  async listModels(): Promise<CodexCatalogModelView[]> {
    const document = await this.ensureDocument();
    return selectVisibleModels(document);
  }

  /** Include hidden entries so persisted account threads keep their own window. */
  async listRuntimeModels(): Promise<CodexCatalogModelView[]> {
    const document = await this.ensureDocument();
    return [...document.remote, ...document.manual].map((model) => ({
      ...model,
      reasoningEfforts: [...model.reasoningEfforts],
    }));
  }

  /** Read only the manually refreshed official prices; billing never starts a network request. */
  async resolveApiRates(
    modelId: string,
    usage: ParsedUsage,
    isAggregate = false,
  ): Promise<ModelCostRates | null> {
    const document = await this.ensureDocument();
    return resolveOpenAiApiRates(document.pricing[modelId.trim()], usage, isAggregate);
  }

  /** Force a network refresh. Throws when the catalog cannot be fetched or parsed. */
  async refresh(accountId?: string): Promise<CodexCatalogModelView[]> {
    const document = await this.ensureDocument();
    await this.fetchInto(document, accountId);
    return selectVisibleModels(document);
  }

  async getStatus(): Promise<CodexModelCatalogStatusView> {
    const document = await this.ensureDocument();
    const status: CodexModelCatalogStatusView = {
      sourceUrl: this.sourceUrl,
      remoteCount: document.remote.length,
      manualCount: document.manual.length,
      pricingSourceUrl: this.pricingSourceUrl,
    };
    if (document.pricingFetchedAt !== undefined) status.pricingFetchedAt = document.pricingFetchedAt;
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
    const existing = [...document.remote, ...document.manual].find((entry) => entry.modelId === modelId);
    if (existing) {
      throw new Error(
        existing.origin === "remote"
          ? `${modelId} 已存在于 ${this.options.catalogName} 模型目录中。`
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

  private async ensureDocument(): Promise<AccountModelCatalogDocument> {
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

  private async loadFromDisk(): Promise<AccountModelCatalogDocument> {
    if (this.document) {
      return this.document;
    }
    const empty = (): AccountModelCatalogDocument => ({
      version: ACCOUNT_MODEL_CATALOG_DOCUMENT_VERSION,
      sourceUrl: this.sourceUrl,
      remote: [],
      manual: [],
      pricing: {},
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
      this.document.lastError = `本地 ${this.options.catalogName} 模型缓存已损坏，请手动刷新。`;
      return this.document;
    }

    this.document = normalizeCachedDocument(parsed, this.sourceUrl);
    return this.document;
  }

  private async fetchInto(document: AccountModelCatalogDocument, accountId?: string): Promise<void> {
    if (this.fetching) return this.fetching;
    const request = this.fetchAndPersist(document, accountId);
    this.fetching = request;
    try {
      await request;
    } finally {
      if (this.fetching === request) this.fetching = undefined;
    }
  }

  private async fetchAndPersist(document: AccountModelCatalogDocument, accountId?: string): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const read = async (url: string, accept: string, label: string) => {
        const response = await fetchImpl(url, { headers: { accept }, signal: controller.signal });
        if (!response.ok) throw new Error(`${label}获取失败：HTTP ${response.status}`);
        return response.text();
      };
      const [remote, pricingMarkdown] = await Promise.all([
        this.options.fetchModels(controller.signal, accountId),
        read(this.pricingSourceUrl, "text/markdown", "官方 API 价格"),
      ]);
      const pricing = parseOpenAiApiPricing(pricingMarkdown);
      const windows = (models: readonly CodexCatalogModelView[]) =>
        JSON.stringify(models.map((model) => [model.modelId, model.contextWindow]).sort());
      const contextChanged = windows(document.remote) !== windows(remote);
      const refreshed: AccountModelCatalogDocument = {
        ...document,
        remote,
        pricing,
        fetchedAt: this.now(),
        pricingFetchedAt: this.now(),
      };
      delete refreshed.lastError;
      await this.persist(refreshed);
      Object.assign(document, refreshed);
      delete document.lastError;
      if (contextChanged) this.options.onContextWindowsChanged?.();
    } catch (error) {
      controller.abort();
      document.lastError = error instanceof Error ? error.message : String(error);
      await this.persist(document);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async persist(document: AccountModelCatalogDocument): Promise<void> {
    await fs.mkdir(path.dirname(this.options.cachePath), { recursive: true });
    const tempPath = `${this.options.cachePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(document, null, 2), "utf8");
    await fs.rename(tempPath, this.options.cachePath);
  }
}

function selectVisibleModels(document: AccountModelCatalogDocument): CodexCatalogModelView[] {
  const visible = [...document.remote.filter((entry) => !entry.hidden), ...document.manual].map((entry) => ({
    ...entry,
    ...(document.pricing[entry.modelId] && { apiPricing: structuredClone(document.pricing[entry.modelId]) }),
  }));
  return visible.sort((left, right) => {
    const leftPriority = left.priority ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = right.priority ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return left.modelId.localeCompare(right.modelId);
  });
}

function normalizeCachedDocument(value: unknown, sourceUrl: string): AccountModelCatalogDocument {
  const document: AccountModelCatalogDocument = {
    version: ACCOUNT_MODEL_CATALOG_DOCUMENT_VERSION,
    sourceUrl,
    remote: [],
    manual: [],
    pricing: {},
  };
  if (!isRecord(value)) {
    return document;
  }
  const fetchedAt = readFiniteNumber(value.fetchedAt);
  if (fetchedAt !== undefined) document.fetchedAt = fetchedAt;
  // A v1 model-only cache remains usable, but has no verified official prices.
  if (value.version === ACCOUNT_MODEL_CATALOG_DOCUMENT_VERSION && isRecord(value.pricing)) {
    for (const [modelId, pricing] of Object.entries(value.pricing)) {
      if (isCodexApiPricing(pricing)) document.pricing[modelId] = structuredClone(pricing);
    }
    const pricingFetchedAt = readFiniteNumber(value.pricingFetchedAt);
    if (pricingFetchedAt !== undefined) document.pricingFetchedAt = pricingFetchedAt;
  }
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
