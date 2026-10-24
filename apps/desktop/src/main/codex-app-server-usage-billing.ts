import type { CodexTurnTokenUsageBreakdown, ParsedUsage } from "@eco/runtime";

/** Partition complete request details while preserving a conservative aggregate for older events. */
export function buildCodexAppServerBillingRequests(input: {
  usage: CodexTurnTokenUsageBreakdown;
  requests?: readonly CodexTurnTokenUsageBreakdown[];
  requestKey: string;
}): Array<{ usage: ParsedUsage; requestKey: string; codexUsageIsAggregate: boolean }> {
  if (!input.requests?.length) {
    return [
      {
        usage: normalizeCodexAppServerUsage(input.usage),
        requestKey: input.requestKey,
        codexUsageIsAggregate: true,
      },
    ];
  }
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ] as const) {
    if (input.requests.reduce((sum, request) => sum + request[key], 0) !== input.usage[key]) {
      throw new Error(`Codex per-request usage does not match turn total: ${key}`);
    }
  }
  return input.requests.map((usage, index) => ({
    usage: normalizeCodexAppServerUsage(usage),
    requestKey: `${input.requestKey}:request:${index}`,
    codexUsageIsAggregate: false,
  }));
}

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
