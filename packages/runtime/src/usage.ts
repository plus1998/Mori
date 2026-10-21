export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** OpenAI/LongCat `completion_tokens_details.reasoning_tokens` when reported. */
  reasoningTokens?: number;
  totalCostUsd?: number;
  modelId?: string;
}

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd?: number;
  /** Claude Agent SDK ModelUsage.thinkingTokens when reported. */
  thinkingTokens?: number;
  /** Claude Agent SDK ModelUsage.costBasis when reported. */
  costBasis?: "list" | "managed" | "unknown";
}

export function parseUsagePayload(payload: unknown): ParsedUsage | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const usage = isRecord(record.usage) ? record.usage : record;
  const inputTokens = readTokenCount(usage, ["input_tokens", "inputTokens"]);
  const outputTokens = readTokenCount(usage, ["output_tokens", "outputTokens"]);
  const cacheReadTokens = readTokenCount(usage, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
  ]);
  const cacheCreationTokens = readTokenCount(usage, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
  ]);

  const totalCostUsd =
    typeof record.total_cost_usd === "number"
      ? record.total_cost_usd
      : typeof record.totalCostUsd === "number"
        ? record.totalCostUsd
        : undefined;

  const modelId = extractModelId(record);

  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheCreationTokens === 0 &&
    totalCostUsd === undefined
  ) {
    return null;
  }

  const reasoningTokens = readReasoningTokens(usage);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...(reasoningTokens > 0 && { reasoningTokens }),
    ...(totalCostUsd !== undefined && { totalCostUsd }),
    ...(modelId && { modelId }),
  };
}

export function mergeUsageTotals(current: ParsedUsage, incoming: ParsedUsage): ParsedUsage {
  const reasoningTokens = (current.reasoningTokens ?? 0) + (incoming.reasoningTokens ?? 0);
  return {
    inputTokens: current.inputTokens + incoming.inputTokens,
    outputTokens: current.outputTokens + incoming.outputTokens,
    cacheReadTokens: current.cacheReadTokens + incoming.cacheReadTokens,
    cacheCreationTokens: current.cacheCreationTokens + incoming.cacheCreationTokens,
    ...(reasoningTokens > 0 && { reasoningTokens }),
    ...(incoming.modelId && { modelId: incoming.modelId }),
  };
}

export interface SdkModelUsageBilling {
  modelId: string;
  usage: ParsedUsage;
  sdkCostUsd?: number;
}

/** Authoritative per-model usage from SDK result `modelUsage`. */
export function parseSdkModelUsageBilling(payload: unknown): SdkModelUsageBilling[] | null {
  const modelUsage = parseModelUsage(payload);
  if (!modelUsage) {
    return null;
  }
  const entries = Object.entries(modelUsage).map(([modelId, entry]) => ({
    modelId,
    usage: {
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      ...(entry.thinkingTokens !== undefined &&
        entry.thinkingTokens > 0 && { reasoningTokens: entry.thinkingTokens }),
    },
    ...(entry.costUsd !== undefined && { sdkCostUsd: entry.costUsd }),
  }));
  return entries.length > 0 ? entries : null;
}

function hasBillableOrContextTokens(usage: ParsedUsage): boolean {
  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheCreationTokens > 0
  );
}

function contextWindowOccupancy(usage: ParsedUsage): number {
  const normalized = normalizeOverlappingCacheContextUsage(usage);
  return normalized.inputTokens + normalized.cacheReadTokens + normalized.cacheCreationTokens;
}

/**
 * OpenAI-compatible providers often put the full prompt in `input_tokens` while also
 * reporting the cached subset as `cache_read_input_tokens` (Anthropic field names).
 * Anthropic-native usage keeps uncached input separate; only dedupe when input clearly
 * represents total prompt size (near-equal to cache, or a small uncached tail).
 */
export function normalizeOverlappingCacheContextUsage(usage: ParsedUsage): ParsedUsage {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = usage;
  if (cacheReadTokens <= 0) {
    return usage;
  }
  if (inputTokens >= cacheReadTokens) {
    const uncachedTail = inputTokens - cacheReadTokens;
    const uncachedTailRatio = uncachedTail / inputTokens;
    const nearEqualTotal = inputTokens <= cacheReadTokens * 1.02;
    const smallUncachedTail = uncachedTailRatio <= 0.1;
    if (nearEqualTotal || smallUncachedTail) {
      return {
        inputTokens: Math.max(0, uncachedTail),
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
      };
    }
  }
  return usage;
}

const EXTENDED_CONTEXT_MODEL_SUFFIX = "[1m]";

function stripExtendedContextModelSuffix(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.endsWith(EXTENDED_CONTEXT_MODEL_SUFFIX)) {
    return trimmed.slice(0, -EXTENDED_CONTEXT_MODEL_SUFFIX.length);
  }
  return trimmed;
}

function normalizeSdkModelIdForMatch(modelId: string): string {
  return stripExtendedContextModelSuffix(modelId).toLowerCase();
}

function findModelBillingEntry(
  modelBillings: NonNullable<ReturnType<typeof parseSdkModelUsageBilling>>,
  subagentModelId: string,
) {
  const normalized = normalizeSdkModelIdForMatch(subagentModelId);
  let match = modelBillings.find((entry) => normalizeSdkModelIdForMatch(entry.modelId) === normalized);
  if (match) {
    return match;
  }
  match = modelBillings.find((entry) => entry.modelId === subagentModelId);
  if (match) {
    return match;
  }
  if (normalized.startsWith("eco-")) {
    return modelBillings.find((entry) => normalizeSdkModelIdForMatch(entry.modelId).startsWith("eco-"));
  }
  return undefined;
}

function maxModelContextUsage(
  modelBillings: NonNullable<ReturnType<typeof parseSdkModelUsageBilling>>,
): ParsedUsage | null {
  let best: ParsedUsage | null = null;
  let bestOccupancy = 0;
  for (const entry of modelBillings) {
    const occupancy = contextWindowOccupancy(entry.usage);
    if (occupancy >= bestOccupancy) {
      bestOccupancy = occupancy;
      best = entry.usage;
    }
  }
  return best;
}

function minModelContextUsage(
  modelBillings: NonNullable<ReturnType<typeof parseSdkModelUsageBilling>>,
): ParsedUsage | null {
  let best: ParsedUsage | null = null;
  let bestOccupancy = Number.POSITIVE_INFINITY;
  for (const entry of modelBillings) {
    const occupancy = contextWindowOccupancy(entry.usage);
    if (occupancy > 0 && occupancy <= bestOccupancy) {
      bestOccupancy = occupancy;
      best = entry.usage;
    }
  }
  return best;
}

/**
 * Session context fill for the context meter (not billing totals).
 * Prefers top-level `usage` when it reflects current window fill; when `modelUsage`
 * is also present, falls back to per-model occupancy if top-level cache reads look
 * cumulative (billing totals) rather than current fill.
 */
export function parseSdkContextUsage(
  payload: unknown,
  options?: { subagentModelId?: string },
): ParsedUsage | null {
  if (!isRecord(payload)) {
    return null;
  }

  const topLevel = parseUsagePayload(payload);
  const modelBillings = parseSdkModelUsageBilling(payload);

  if (options?.subagentModelId && modelBillings?.length) {
    const match = findModelBillingEntry(modelBillings, options.subagentModelId);
    if (match) {
      return match.usage;
    }
    if (modelBillings.length === 1) {
      return modelBillings[0]!.usage;
    }
    return minModelContextUsage(modelBillings);
  }

  const maxModelUsage = modelBillings?.length ? maxModelContextUsage(modelBillings) : null;
  const topLevelBillable = topLevel && hasBillableOrContextTokens(topLevel);

  if (topLevelBillable && maxModelUsage) {
    const topLevelOccupancy = contextWindowOccupancy(topLevel);
    const maxModelOccupancy = contextWindowOccupancy(maxModelUsage);
    return topLevelOccupancy <= maxModelOccupancy ? topLevel : maxModelUsage;
  }

  if (topLevelBillable) {
    return topLevel;
  }

  if (!modelBillings || modelBillings.length === 0) {
    return topLevel;
  }

  return maxModelUsage;
}

export function mergeModelUsages(usages: readonly ParsedUsage[]): ParsedUsage {
  return usages.reduce((total, usage) => mergeUsageTotals(total, usage), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  });
}

export function parseSdkUsageBilling(payload: unknown): {
  models: SdkModelUsageBilling[];
  contextUsage: ParsedUsage;
  totalCostUsd?: number;
  authoritative: boolean;
} | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (payload.type === "sdk_context_usage" || payload.ecoSdkContextUsage !== undefined) {
    return null;
  }

  const modelBillings = parseSdkModelUsageBilling(payload);
  const explicitTotalCostUsd =
    typeof payload.totalCostUsd === "number"
      ? payload.totalCostUsd
      : typeof payload.total_cost_usd === "number"
        ? payload.total_cost_usd
        : undefined;
  const modelCostTotal = modelBillings?.reduce((sum, entry) => sum + (entry.sdkCostUsd ?? 0), 0);
  const totalCostUsd =
    explicitTotalCostUsd !== undefined
      ? explicitTotalCostUsd
      : modelCostTotal !== undefined && modelCostTotal > 0
        ? modelCostTotal
        : undefined;

  if (modelBillings) {
    const contextUsage =
      parseSdkContextUsage(payload) ?? mergeModelUsages(modelBillings.map((entry) => entry.usage));
    return {
      models: modelBillings,
      contextUsage,
      ...(totalCostUsd !== undefined && { totalCostUsd }),
      authoritative: true,
    };
  }

  const usage = parseUsagePayload(payload);
  if (!usage) {
    return null;
  }

  const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
  const modelId = usage.modelId ?? "unknown";
  return {
    models: [{ modelId, usage }],
    contextUsage: usage,
    ...(totalCostUsd !== undefined && { totalCostUsd }),
    authoritative: !messageId,
  };
}

export function parseModelUsage(payload: unknown): Record<string, ModelUsageEntry> | null {
  if (!isRecord(payload)) {
    return null;
  }
  const raw = payload.modelUsage;
  if (!isRecord(raw)) {
    return null;
  }

  const result: Record<string, ModelUsageEntry> = {};
  for (const [modelName, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      continue;
    }
    const costUsd =
      typeof entry.costUSD === "number"
        ? entry.costUSD
        : typeof entry.cost_usd === "number"
          ? entry.cost_usd
          : undefined;
    const thinkingTokens = readTokenCount(entry, ["thinkingTokens", "thinking_tokens"]);
    const costBasisRaw =
      typeof entry.costBasis === "string"
        ? entry.costBasis
        : typeof entry.cost_basis === "string"
          ? entry.cost_basis
          : undefined;
    const costBasis =
      costBasisRaw === "list" || costBasisRaw === "managed" || costBasisRaw === "unknown"
        ? costBasisRaw
        : undefined;
    result[modelName] = {
      inputTokens: readTokenCount(entry, ["inputTokens", "input_tokens"]),
      outputTokens: readTokenCount(entry, ["outputTokens", "output_tokens"]),
      cacheReadTokens: readTokenCount(entry, [
        "cacheReadInputTokens",
        "cache_read_input_tokens",
        "cache_read_tokens",
      ]),
      cacheCreationTokens: readTokenCount(entry, [
        "cacheCreationInputTokens",
        "cache_creation_input_tokens",
        "cache_creation_tokens",
      ]),
      ...(costUsd !== undefined && { costUsd }),
      ...(thinkingTokens > 0 && { thinkingTokens }),
      ...(costBasis !== undefined && { costBasis }),
    };
  }

  return Object.keys(result).length > 0 ? result : null;
}

export function accumulateThreadCost(current: number, delta?: number): number {
  if (delta === undefined || !Number.isFinite(delta)) {
    return current;
  }
  return current + delta;
}

export function formatCostUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

export function estimateContextTokens(usage: ParsedUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
}

/** Activity / billing badge: ↑ input, ↓ output, ⊙ cache (read + write tokens). */
export function formatUsageBadge(usage: ParsedUsage): string {
  const parts = [`↑${formatTokenCount(usage.inputTokens)}`, `↓${formatTokenCount(usage.outputTokens)}`];
  if (usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0) {
    parts.push(`⊙${formatTokenCount(usage.cacheReadTokens + usage.cacheCreationTokens)}`);
  }
  return parts.join(" ");
}

export function formatRoleModelLabel(role: string, modelId?: string): string {
  const roleLabels: Record<string, string> = {
    main: "主代理",
    explore: "探索",
    architect: "架构",
    coder: "编码",
    reviewer: "审查",
    tester: "测试",
    thinking: "思考",
  };
  const base = roleLabels[role] ?? role;
  if (!modelId?.trim()) {
    return base;
  }
  const shortModel = shortenModelId(modelId.trim());
  return `${base} · ${shortModel}`;
}

export function shortenModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  if (slash >= 0) {
    return modelId.slice(slash + 1);
  }
  return modelId.length > 28 ? `${modelId.slice(0, 25)}…` : modelId;
}

function extractModelId(record: Record<string, unknown>): string | undefined {
  if (typeof record.model === "string" && record.model.trim()) {
    return record.model.trim();
  }
  if (isRecord(record.modelUsage)) {
    const keys = Object.keys(record.modelUsage);
    if (keys.length === 1) {
      return keys[0];
    }
  }
  return undefined;
}

function readTokenCount(usage: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

/** Reads provider-reported reasoning token counts from OpenAI/LongCat usage details. */
export function readReasoningTokens(usage: Record<string, unknown>): number {
  const topLevelThinking = readTokenCount(usage, ["thinkingTokens", "thinking_tokens"]);
  if (topLevelThinking > 0) {
    return topLevelThinking;
  }
  for (const key of [
    "completion_tokens_details",
    "completionTokensDetails",
    "output_tokens_details",
    "outputTokensDetails",
  ]) {
    const details = usage[key];
    if (!isRecord(details)) {
      continue;
    }
    const count = readTokenCount(details, ["reasoning_tokens", "reasoningTokens"]);
    if (count > 0) {
      return count;
    }
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
