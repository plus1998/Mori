/**
 * Parse Anthropic Messages SSE (message_start / message_delta / message_stop)
 * into cumulative ParsedUsage for gateway onUsage observers.
 */
import type { AnthropicStreamEvent } from "@eco/openai-anthropic-bridge";
import { normalizeAnthropicUsage, type ParsedUsage } from "./usage-normalize.js";

export type AnthropicStreamUsageRejectionReason =
  | "duplicate_message_start"
  | "invalid_message_start"
  | "invalid_message_start_usage"
  | "message_delta_before_start"
  | "invalid_message_delta_usage"
  | "missing_message_start"
  | "missing_message_delta_usage"
  | "missing_message_stop"
  | "missing_response_identity";

export interface AnthropicStreamUsageTracker {
  started: boolean;
  stopped: boolean;
  finalUsageSeen: boolean;
  responseId?: string;
  usage?: ParsedUsage;
  rejectionReason?: AnthropicStreamUsageRejectionReason;
}

export function newAnthropicStreamUsageTracker(): AnthropicStreamUsageTracker {
  return {
    started: false,
    stopped: false,
    finalUsageSeen: false,
  };
}

export function trackAnthropicStreamUsage(
  tracker: AnthropicStreamUsageTracker,
  event: AnthropicStreamEvent,
): void {
  if (tracker.rejectionReason) {
    if (event.type === "message_stop") {
      tracker.stopped = true;
    }
    return;
  }

  if (event.type === "message_start") {
    if (tracker.started) {
      tracker.rejectionReason = "duplicate_message_start";
      return;
    }
    tracker.started = true;
    const message = event.message;
    if (!message || typeof message !== "object") {
      tracker.rejectionReason = "invalid_message_start";
      return;
    }
    const modelId = readNonEmptyString(message.model);
    const responseId = readNonEmptyString(message.id);
    if (!modelId || !responseId) {
      tracker.rejectionReason = "invalid_message_start";
      return;
    }
    const usage = normalizeAnthropicUsage(message.usage, modelId);
    if (!usage) {
      tracker.rejectionReason = "invalid_message_start_usage";
      return;
    }
    tracker.responseId = responseId;
    tracker.usage = usage;
    return;
  }

  if (event.type === "message_delta") {
    if (!tracker.started || !tracker.usage) {
      tracker.rejectionReason = "message_delta_before_start";
      return;
    }
    const delta = parseAnthropicMessageDeltaUsage(event.usage);
    if (!delta) {
      tracker.rejectionReason = "invalid_message_delta_usage";
      return;
    }
    // Delta usage is a cumulative snapshot of the fields it reports. Some
    // compatible providers reclassify provisional input as cache reads or
    // writes, so a valid later count can be lower, including an explicit zero.
    tracker.usage = {
      ...tracker.usage,
      ...delta,
    };
    tracker.finalUsageSeen = true;
    return;
  }

  if (event.type === "message_stop") {
    tracker.stopped = true;
  }
}

export function resolveAnthropicStreamUsage(
  tracker: AnthropicStreamUsageTracker,
):
  | { status: "resolved"; usage: ParsedUsage; responseId: string }
  | { status: "rejected"; reason: AnthropicStreamUsageRejectionReason } {
  if (tracker.rejectionReason) {
    return { status: "rejected", reason: tracker.rejectionReason };
  }
  if (!tracker.started || !tracker.usage) {
    return { status: "rejected", reason: "missing_message_start" };
  }
  if (!tracker.finalUsageSeen) {
    return { status: "rejected", reason: "missing_message_delta_usage" };
  }
  if (!tracker.stopped) {
    return { status: "rejected", reason: "missing_message_stop" };
  }
  if (!tracker.responseId) {
    return { status: "rejected", reason: "missing_response_identity" };
  }
  return {
    status: "resolved",
    usage: tracker.usage,
    responseId: tracker.responseId,
  };
}

function parseAnthropicMessageDeltaUsage(usage: unknown): {
  outputTokens: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} | null {
  if (!isRecord(usage)) {
    return null;
  }
  const outputTokens = readExactNonNegativeInteger(usage.output_tokens);
  if (outputTokens === undefined) {
    return null;
  }
  const inputTokens = readOptionalCumulativeTokenCount(usage, "input_tokens");
  const cacheReadTokens = readOptionalCumulativeTokenCount(usage, "cache_read_input_tokens");
  const cacheCreationTokens = readOptionalCumulativeTokenCount(usage, "cache_creation_input_tokens");
  if (!inputTokens.valid || !cacheReadTokens.valid || !cacheCreationTokens.valid) {
    return null;
  }
  return {
    outputTokens,
    ...(inputTokens.value !== undefined && { inputTokens: inputTokens.value }),
    ...(cacheReadTokens.value !== undefined && { cacheReadTokens: cacheReadTokens.value }),
    ...(cacheCreationTokens.value !== undefined && {
      cacheCreationTokens: cacheCreationTokens.value,
    }),
  };
}

function readOptionalCumulativeTokenCount(
  usage: Record<string, unknown>,
  key: string,
): { valid: true; value?: number } | { valid: false } {
  if (!Object.hasOwn(usage, key) || usage[key] === null) {
    return { valid: true };
  }
  const value = readExactNonNegativeInteger(usage[key]);
  return value === undefined ? { valid: false } : { valid: true, value };
}

function readExactNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
