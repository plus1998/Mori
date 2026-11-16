import type { ChatUsage, ResponsesStreamEvent, ResponsesUsage } from "@eco/openai-anthropic-bridge";

/** Mirrors `@eco/runtime` ParsedUsage — kept local to avoid pulling runtime into gateway typecheck. */
export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens?: number;
  totalCostUsd?: number;
  modelId?: string;
}

/**
 * Anthropic-compatible providers do not consistently include cache counters.
 * Missing or null cache counters are treated as zero so the full input_tokens
 * amount remains billable without applying an unreported cache discount.
 */
export function normalizeAnthropicUsage(usage: unknown, modelId?: string): ParsedUsage | null {
  if (!isRecord(usage)) {
    return null;
  }
  const inputTokens = readExactTokenCount(usage, "input_tokens", false);
  const outputTokens = readExactTokenCount(usage, "output_tokens", false);
  const cacheReadTokens = readExactTokenCount(usage, "cache_read_input_tokens", true, true);
  const cacheCreationTokens = readExactTokenCount(usage, "cache_creation_input_tokens", true, true);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheCreationTokens === undefined
  ) {
    return null;
  }
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    ...(modelId && { modelId }),
  };
}

function readExactTokenCount(
  usage: Record<string, unknown>,
  key: string,
  nullable: boolean,
  optional = false,
): number | undefined {
  if (!Object.hasOwn(usage, key)) {
    return optional ? 0 : undefined;
  }
  const value = usage[key];
  if (nullable && value === null) {
    return 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsageRecord(usage: Record<string, unknown>, modelId?: string): ParsedUsage | null {
  const inputTokens = readExactTokenField(usage, ["input_tokens", "inputTokens"]);
  const outputTokens = readExactTokenField(usage, ["output_tokens", "outputTokens"]);
  const cacheReadTokens = readExactTokenField(usage, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
  ]);
  const cacheCreationTokens = readExactTokenField(usage, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
  ]);

  if (
    !inputTokens.valid ||
    !inputTokens.present ||
    !outputTokens.valid ||
    !outputTokens.present ||
    !cacheReadTokens.valid ||
    !cacheCreationTokens.valid
  ) {
    return null;
  }

  if (
    inputTokens.value === 0 &&
    outputTokens.value === 0 &&
    cacheReadTokens.value === 0 &&
    cacheCreationTokens.value === 0
  ) {
    return null;
  }

  return {
    inputTokens: inputTokens.value,
    outputTokens: outputTokens.value,
    cacheReadTokens: cacheReadTokens.value,
    cacheCreationTokens: cacheCreationTokens.value,
    ...(modelId && { modelId }),
  };
}

/** Phase 0 stub: normalize gateway-visible usage to Eco ParsedUsage for later billing reconciliation. */
export function normalizeResponsesUsage(
  usage: ResponsesUsage | undefined,
  modelId?: string,
): ParsedUsage | null {
  if (!usage) {
    return null;
  }

  const record = usage as unknown as Record<string, unknown>;
  const parsed = parseUsageRecord(record, modelId);
  if (!parsed) {
    return null;
  }
  const explicitCacheRead = readExactTokenField(record, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
  ]);
  const explicitCacheCreation = readExactTokenField(record, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
  ]);
  const cacheBreakdown = readCacheBreakdown(usage.input_tokens_details);
  const totalTokens = readExactTokenField(record, ["total_tokens", "totalTokens"]);
  if (
    !explicitCacheRead.valid ||
    !explicitCacheCreation.valid ||
    !cacheBreakdown.valid ||
    !totalTokens.valid ||
    !totalTokens.present
  ) {
    return null;
  }
  const cacheResolution = resolveCacheTokenSemantics({
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    totalTokens: totalTokens.value,
    explicitCacheRead,
    explicitCacheCreation,
    cacheBreakdown,
  });
  if (!cacheResolution) return null;
  const reasoningTokens = readReasoningTokens(record);
  return {
    ...parsed,
    ...cacheResolution,
    ...(reasoningTokens > 0 && { reasoningTokens }),
  };
}

export function normalizeChatCompletionsUsage(
  usage: ChatUsage | undefined,
  modelId?: string,
): ParsedUsage | null {
  if (!usage) {
    return null;
  }

  const record = usage as unknown as Record<string, unknown>;
  const inputTokens = readExactTokenField(record, [
    "prompt_tokens",
    "promptTokens",
    "input_tokens",
    "inputTokens",
  ]);
  const outputTokens = readExactTokenField(record, [
    "completion_tokens",
    "completionTokens",
    "output_tokens",
    "outputTokens",
  ]);
  const explicitCacheRead = readExactTokenField(record, [
    "cache_read_input_tokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
  ]);
  const explicitCacheCreation = readExactTokenField(record, [
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
    "cache_creation_tokens",
  ]);
  const cacheBreakdown = readChatCacheBreakdown(usage.prompt_tokens_details, usage.input_tokens_details);
  const totalTokens = readExactTokenField(record, ["total_tokens", "totalTokens"]);
  if (
    !inputTokens.valid ||
    !inputTokens.present ||
    !outputTokens.valid ||
    !outputTokens.present ||
    !explicitCacheRead.valid ||
    !explicitCacheCreation.valid ||
    !cacheBreakdown.valid ||
    !totalTokens.valid ||
    !totalTokens.present
  ) {
    return null;
  }
  const cacheResolution = resolveCacheTokenSemantics({
    inputTokens: inputTokens.value,
    outputTokens: outputTokens.value,
    totalTokens: totalTokens.value,
    explicitCacheRead,
    explicitCacheCreation,
    cacheBreakdown,
  });
  if (!cacheResolution) return null;

  if (
    inputTokens.value === 0 &&
    outputTokens.value === 0 &&
    cacheResolution.cacheReadTokens === 0 &&
    cacheResolution.cacheCreationTokens === 0
  ) {
    return null;
  }

  const reasoningTokens = readReasoningTokens(record);
  return {
    inputTokens: cacheResolution.inputTokens,
    outputTokens: outputTokens.value,
    cacheReadTokens: cacheResolution.cacheReadTokens,
    cacheCreationTokens: cacheResolution.cacheCreationTokens,
    ...(reasoningTokens > 0 && { reasoningTokens }),
    ...(modelId && { modelId }),
  };
}

function resolveCacheTokenSemantics(input: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  explicitCacheRead: { present: boolean; value: number };
  explicitCacheCreation: { present: boolean; value: number };
  cacheBreakdown: {
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}): Pick<ParsedUsage, "inputTokens" | "cacheReadTokens" | "cacheCreationTokens"> | null {
  const detailsHaveTokens =
    input.cacheBreakdown.cacheReadTokens > 0 || input.cacheBreakdown.cacheCreationTokens > 0;
  const explicitHaveTokens = input.explicitCacheRead.value > 0 || input.explicitCacheCreation.value > 0;
  if (detailsHaveTokens && explicitHaveTokens) {
    return null;
  }

  const cacheReadTokens = detailsHaveTokens
    ? input.cacheBreakdown.cacheReadTokens
    : input.explicitCacheRead.value;
  const cacheCreationTokens = detailsHaveTokens
    ? input.cacheBreakdown.cacheCreationTokens
    : input.explicitCacheCreation.value;
  const cacheTokens = cacheReadTokens + cacheCreationTokens;
  const inclusiveTotal = input.inputTokens + input.outputTokens;
  if (detailsHaveTokens) {
    if (input.totalTokens !== inclusiveTotal || cacheTokens > input.inputTokens) {
      return null;
    }
    return {
      inputTokens: input.inputTokens - cacheTokens,
      cacheReadTokens,
      cacheCreationTokens,
    };
  }
  if (!explicitHaveTokens) {
    return input.totalTokens === inclusiveTotal
      ? { inputTokens: input.inputTokens, cacheReadTokens: 0, cacheCreationTokens: 0 }
      : null;
  }
  if (input.totalTokens === inclusiveTotal) {
    return cacheTokens <= input.inputTokens
      ? {
          inputTokens: input.inputTokens - cacheTokens,
          cacheReadTokens,
          cacheCreationTokens,
        }
      : null;
  }
  if (input.totalTokens === inclusiveTotal + cacheTokens) {
    return { inputTokens: input.inputTokens, cacheReadTokens, cacheCreationTokens };
  }
  return null;
}

function readExactTokenField(
  record: Record<string, unknown>,
  keys: readonly string[],
): { valid: boolean; present: boolean; value: number } {
  let resolved: number | undefined;
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      continue;
    }
    const value = readExactNonNegativeInteger(record[key]);
    if (value === undefined || (resolved !== undefined && resolved !== value)) {
      return { valid: false, present: true, value: 0 };
    }
    resolved = value;
  }
  return resolved === undefined
    ? { valid: true, present: false, value: 0 }
    : { valid: true, present: true, value: resolved };
}

function readCacheBreakdown(details: unknown): {
  valid: boolean;
  present: boolean;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  if (details === undefined || details === null) {
    return {
      valid: true,
      present: false,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
  if (!isRecord(details)) {
    return {
      valid: false,
      present: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
  const cacheRead = readExactTokenField(details, ["cached_tokens"]);
  const cacheCreation = readExactTokenField(details, ["cache_write_tokens"]);
  if (!cacheRead.valid || !cacheCreation.valid) {
    return {
      valid: false,
      present: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
  }
  return {
    valid: true,
    present: cacheRead.present || cacheCreation.present,
    cacheReadTokens: cacheRead.value,
    cacheCreationTokens: cacheCreation.value,
  };
}

function readChatCacheBreakdown(
  promptDetails: unknown,
  inputDetails: unknown,
): ReturnType<typeof readCacheBreakdown> {
  const prompt = readCacheBreakdown(promptDetails);
  const input = readCacheBreakdown(inputDetails);
  if (!prompt.valid || !input.valid) {
    return { valid: false, present: true, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  if (
    prompt.present &&
    input.present &&
    (prompt.cacheReadTokens !== input.cacheReadTokens ||
      prompt.cacheCreationTokens !== input.cacheCreationTokens)
  ) {
    return { valid: false, present: true, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  return prompt.present ? prompt : input;
}

function readExactNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readReasoningTokens(usage: Record<string, unknown>): number {
  for (const key of ["completion_tokens_details", "completionTokensDetails", "output_tokens_details", "outputTokensDetails"]) {
    const details = usage[key];
    if (!isRecord(details)) {
      continue;
    }
    const value = readExactNonNegativeInteger(details.reasoning_tokens ?? details.reasoningTokens);
    if (value !== undefined && value > 0) {
      return value;
    }
  }
  return 0;
}

export function extractUsageFromResponsesStreamEvent(
  event: ResponsesStreamEvent,
  modelId?: string,
): ParsedUsage | null {
  if (event.type !== "response.completed") {
    return null;
  }
  // Responses-compatible gateways occasionally put usage on the event instead
  // of under `response`. Accept both shapes; otherwise a billable completion
  // is silently treated as usage-less.
  const response = event.response as { usage?: unknown; model?: unknown } | undefined;
  const eventUsage = (event as unknown as { usage?: unknown }).usage;
  const usage = response?.usage ?? eventUsage;
  const responseModel = typeof response?.model === "string" ? response.model : undefined;
  return normalizeResponsesUsage(usage as ResponsesUsage | undefined, modelId ?? responseModel);
}
