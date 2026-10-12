import {
  expandModelLookupCandidates,
  lookupModelCostInCatalog,
  type ModelsDevCatalog,
  type ModelsDevModelEntry,
  type ModelsDevProviderEntry,
} from "./models-dev-pricing";
import { normalizeOverlappingCacheContextUsage, type ParsedUsage } from "./usage";

const MODEL_ALIASES: Record<string, string[]> = {
  sonnet: ["claude-sonnet"],
  opus: ["claude-opus"],
  haiku: ["claude-haiku"],
};

export const DEFAULT_CONTEXT_LIMIT = 200_000;
export const DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT = 262_144;
export const GLOBAL_CONTEXT_WINDOW_LIMIT_MIN = 32_768;
export const GLOBAL_CONTEXT_WINDOW_LIMIT_MAX = 1_048_576;
export const GLOBAL_CONTEXT_WINDOW_LIMIT_STEP = 1_024;
export const GLOBAL_CONTEXT_WINDOW_LIMIT_PRESETS = [131_072, 262_144, 524_288, 1_048_576] as const;

export type GlobalContextWindowLimit = number;

export function isGlobalContextWindowLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= GLOBAL_CONTEXT_WINDOW_LIMIT_MIN &&
    value <= GLOBAL_CONTEXT_WINDOW_LIMIT_MAX
  );
}

export function normalizeGlobalContextWindowLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GLOBAL_CONTEXT_WINDOW_LIMIT;
  }
  const snapped = Math.round(value / GLOBAL_CONTEXT_WINDOW_LIMIT_STEP) * GLOBAL_CONTEXT_WINDOW_LIMIT_STEP;
  return Math.min(GLOBAL_CONTEXT_WINDOW_LIMIT_MAX, Math.max(GLOBAL_CONTEXT_WINDOW_LIMIT_MIN, snapped));
}

export function resolveEffectiveContextLimit(
  modelContextLimit: number,
  globalContextWindowLimit: number,
): number {
  const modelLimit =
    Number.isFinite(modelContextLimit) && modelContextLimit > 0
      ? Math.floor(modelContextLimit)
      : DEFAULT_CONTEXT_LIMIT;
  const globalLimit = normalizeGlobalContextWindowLimit(globalContextWindowLimit);
  return Math.min(modelLimit, globalLimit);
}

/** Aligns with Claude Code default for unknown / gateway model ids. */
export const DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS = 32_768;
export const DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT = "dynamic";
export const GLOBAL_MAX_OUTPUT_TOKEN_MIN = 8_192;
export const GLOBAL_MAX_OUTPUT_TOKEN_MAX = 262_144;
export const GLOBAL_MAX_OUTPUT_TOKEN_STEP = 256;
export const GLOBAL_MAX_OUTPUT_TOKEN_PRESETS = [
  8_192,
  16_384,
  DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS,
  65_536,
  131_072,
  262_144,
] as const;

export type GlobalMaxOutputTokens = number | typeof DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT;

export function isGlobalMaxOutputTokens(value: unknown): value is GlobalMaxOutputTokens {
  return (
    value === "dynamic" ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= GLOBAL_MAX_OUTPUT_TOKEN_MIN &&
      value <= GLOBAL_MAX_OUTPUT_TOKEN_MAX)
  );
}

export function normalizeGlobalMaxOutputTokens(value: unknown): GlobalMaxOutputTokens {
  if (value === "dynamic") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GLOBAL_MAX_OUTPUT_LIMIT;
  }
  const snapped = Math.round(value / GLOBAL_MAX_OUTPUT_TOKEN_STEP) * GLOBAL_MAX_OUTPUT_TOKEN_STEP;
  return Math.min(GLOBAL_MAX_OUTPUT_TOKEN_MAX, Math.max(GLOBAL_MAX_OUTPUT_TOKEN_MIN, snapped));
}

/**
 * Hard ceiling for request `max_tokens` / gateway max output.
 * applied = min(model manual|catalog, global). Before a prompt exists, dynamic
 * advertises the window's output ceiling to SDKs; Gateway subtracts the final
 * request input at dispatch time.
 * also min(applied, contextTokens - 1) when context is known.
 */
export function resolveAppliedMaxOutputTokens(input: {
  modelMaxOutputTokens?: number;
  globalMaxOutputTokens?: GlobalMaxOutputTokens;
  contextTokens?: number;
}): number {
  const setting = normalizeGlobalMaxOutputTokens(
    input.globalMaxOutputTokens ?? DEFAULT_GLOBAL_MAX_OUTPUT_TOKENS,
  );
  const globalCap = setting === "dynamic" ? resolveDynamicMaxOutputTokens(input.contextTokens, 0) : setting;
  const modelConfigured =
    input.modelMaxOutputTokens !== undefined &&
    Number.isFinite(input.modelMaxOutputTokens) &&
    input.modelMaxOutputTokens > 0;
  const modelOut = modelConfigured ? Math.floor(input.modelMaxOutputTokens as number) : globalCap;
  let applied = Math.min(modelOut, globalCap);
  if (input.contextTokens !== undefined && Number.isFinite(input.contextTokens) && input.contextTokens > 1) {
    applied = Math.min(applied, Math.max(1, Math.floor(input.contextTokens) - 1));
  }
  return Math.max(1, applied);
}

/** Claude Code autocompact buffer (reserved headroom before compaction). */
export const DEFAULT_AUTOCOMPACT_BUFFER = 33_000;

const MAX_OUTPUT_RESERVE_CAP = 20_000;

/** Per-request remaining window. Never send an overflowing prompt with a fabricated one-token output. */
export function resolveDynamicMaxOutputTokens(
  contextTokens: number | undefined,
  inputTokens: number,
): number {
  if (contextTokens === undefined || !Number.isSafeInteger(contextTokens) || contextTokens < 2) {
    throw new Error("Dynamic max output requires a resolved context window.");
  }
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) {
    throw new Error("Dynamic max output requires a valid current input token count.");
  }
  const remaining = contextTokens - inputTokens - 1;
  if (remaining < 1) {
    throw new Error(
      `Context window exhausted: window=${contextTokens}, input=${inputTokens}, reserve=1. Compact the input before retrying.`,
    );
  }
  return remaining;
}

/**
 * Effective context window for autocompact threshold (Claude Code style).
 * Deducts autocompact buffer and output reservation from catalog limit.
 * UI displays the nominal catalog limit; use this for compaction decisions only.
 */
export function effectiveContextLimit(catalogLimit: number, maxOutputTokens?: number): number {
  const outputReserve = Math.min(maxOutputTokens ?? MAX_OUTPUT_RESERVE_CAP, MAX_OUTPUT_RESERVE_CAP);
  return Math.max(catalogLimit - DEFAULT_AUTOCOMPACT_BUFFER - outputReserve, catalogLimit * 0.5);
}

export interface ModelContextLimits {
  contextTokens: number;
  maxOutputTokens?: number;
}

export interface ModelLimitsLookup {
  providerKey: string;
  modelId: string;
  limits: ModelContextLimits;
  displayName?: string;
}

export function extractLimitsFromModelEntry(entry: ModelsDevModelEntry): ModelContextLimits | null {
  const limit = entry.limit;
  if (!limit || typeof limit.context !== "number" || limit.context <= 0) {
    return null;
  }
  return {
    contextTokens: limit.context,
    ...(typeof limit.output === "number" && limit.output > 0 && { maxOutputTokens: limit.output }),
  };
}

export function lookupModelLimitsInCatalog(
  catalog: ModelsDevCatalog,
  providerHint: string | null,
  modelId: string,
): ModelLimitsLookup | null {
  const pricing = lookupModelCostInCatalog(catalog, providerHint, modelId);
  if (!pricing) {
    return lookupLimitsOnly(catalog, providerHint, modelId);
  }

  const provider = catalog[pricing.providerKey];
  const entry = provider ? findModelEntry(provider, pricing.modelId) : undefined;
  const limits = entry ? extractLimitsFromModelEntry(entry) : null;
  if (!limits) {
    return lookupLimitsOnly(catalog, providerHint, modelId);
  }

  return {
    providerKey: pricing.providerKey,
    modelId: pricing.modelId,
    limits,
    ...(pricing.displayName && { displayName: pricing.displayName }),
  };
}

function lookupLimitsOnly(
  catalog: ModelsDevCatalog,
  providerHint: string | null,
  modelId: string,
): ModelLimitsLookup | null {
  const candidates = expandModelLookupCandidates(modelId, providerHint);
  if (candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    const match = lookupLimitsForCandidate(catalog, providerHint, candidate);
    if (match) {
      return match;
    }
  }

  if (providerHint) {
    for (const candidate of expandModelLookupCandidates(modelId, null)) {
      const match = lookupLimitsForCandidate(catalog, null, candidate);
      if (match) {
        return match;
      }
    }
  }

  return null;
}

function lookupLimitsForCandidate(
  catalog: ModelsDevCatalog,
  providerHint: string | null,
  trimmed: string,
): ModelLimitsLookup | null {
  if (providerHint && catalog[providerHint]) {
    const match = lookupLimitsInProvider(catalog[providerHint]!, trimmed);
    if (match) {
      return { providerKey: providerHint, ...match };
    }
  }

  for (const [providerKey, provider] of Object.entries(catalog)) {
    if (providerHint && providerKey !== providerHint) {
      continue;
    }
    const match = lookupLimitsInProvider(provider, trimmed);
    if (match) {
      return { providerKey, ...match };
    }
  }

  if (!providerHint) {
    for (const [providerKey, provider] of Object.entries(catalog)) {
      const match = lookupLimitsInProvider(provider, trimmed);
      if (match) {
        return { providerKey, ...match };
      }
    }
  }

  return null;
}

function lookupLimitsInProvider(
  provider: ModelsDevProviderEntry,
  modelId: string,
): Omit<ModelLimitsLookup, "providerKey"> | null {
  const match = matchLimitsFromProvider(provider, modelId);
  return match;
}

function matchLimitsFromProvider(
  provider: ModelsDevProviderEntry,
  modelId: string,
): Omit<ModelLimitsLookup, "providerKey"> | null {
  const exact = provider.models[modelId];
  if (exact) {
    return limitsFromEntry(exact);
  }

  const lower = modelId.toLowerCase();
  for (const entry of Object.values(provider.models)) {
    if (entry.id.toLowerCase() === lower) {
      const matched = limitsFromEntry(entry);
      if (matched) {
        return matched;
      }
    }
  }

  const aliasPrefixes = MODEL_ALIASES[lower];
  if (aliasPrefixes) {
    const candidates = Object.values(provider.models)
      .filter((entry) => aliasPrefixes.some((prefix) => entry.id.toLowerCase().includes(prefix)))
      .sort((a, b) => b.id.localeCompare(a.id));
    for (const entry of candidates) {
      const matched = limitsFromEntry(entry);
      if (matched) {
        return matched;
      }
    }
  }

  const fuzzy = Object.values(provider.models)
    .filter((entry) => entry.id.toLowerCase().includes(lower) || lower.includes(entry.id.toLowerCase()))
    .sort((a, b) => b.id.length - a.id.length);
  for (const entry of fuzzy) {
    const matched = limitsFromEntry(entry);
    if (matched) {
      return matched;
    }
  }

  return null;
}

function limitsFromEntry(entry: ModelsDevModelEntry): Omit<ModelLimitsLookup, "providerKey"> | null {
  const limits = extractLimitsFromModelEntry(entry);
  if (!limits) {
    return null;
  }
  return {
    modelId: entry.id,
    limits,
    ...(entry.name && { displayName: entry.name }),
  };
}

function findModelEntry(provider: ModelsDevProviderEntry, modelId: string): ModelsDevModelEntry | undefined {
  const exact = provider.models[modelId];
  if (exact) {
    return exact;
  }
  const lower = modelId.toLowerCase();
  for (const entry of Object.values(provider.models)) {
    if (entry.id.toLowerCase() === lower) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Context window fill for a single API turn (Claude Code / OpenCode style).
 * Uses input + cache tokens only — output does not count toward the context limit.
 */
export function computeWindowOccupancy(usage: ParsedUsage): number {
  const normalized = normalizeOverlappingCacheContextUsage(usage);
  return normalized.inputTokens + normalized.cacheReadTokens + normalized.cacheCreationTokens;
}

export function computeOccupancyRatio(
  occupied: number,
  limit: number,
  threshold = 0.85,
): { ratio: number; atThreshold: boolean } {
  if (limit <= 0) {
    return { ratio: 0, atThreshold: false };
  }
  const ratio = occupied / limit;
  return { ratio, atThreshold: ratio >= threshold };
}

export function occupancyPercent(occupied: number, limit: number): number {
  if (limit <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((occupied / limit) * 100));
}

/** Compact label for context window size (e.g. 200K, 1.0M). */
export function formatContextLimit(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }
  if (tokens < 1_000_000) {
    const rounded = tokens / 1000;
    return rounded >= 100 ? `${Math.round(rounded)}K` : `${rounded.toFixed(1)}K`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
