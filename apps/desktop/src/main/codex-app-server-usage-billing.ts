import type { CodexTurnTokenUsageBreakdown, ParsedUsage } from "@eco/runtime";

/** Codex includes cached input in inputTokens; Eco's billing buckets are disjoint. */
export function normalizeCodexAppServerUsage(usage: CodexTurnTokenUsageBreakdown): ParsedUsage {
  if (
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.cachedInputTokens) ||
    usage.inputTokens < 0 ||
    usage.cachedInputTokens < 0 ||
    usage.cachedInputTokens > usage.inputTokens
  ) {
    throw new Error("Invalid Codex input usage: cachedInputTokens must be a subset of inputTokens.");
  }
  return {
    inputTokens: usage.inputTokens - usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cachedInputTokens,
    cacheCreationTokens: 0,
    ...(usage.reasoningOutputTokens > 0 ? { reasoningTokens: usage.reasoningOutputTokens } : {}),
  };
}
