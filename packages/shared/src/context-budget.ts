export type InputTokenCountPrecision = "heuristic" | "provider_exact" | "tokenizer_exact";

/** Fixed output ceiling when the upstream cannot count the final input. */
export const DYNAMIC_OUTPUT_FALLBACK_TOKENS = 32_768;

/** Final-wire counting and native preflight must agree on the space reserved by Gateway. */
export function contextInputReserve(window: number, precision: InputTokenCountPrecision): number {
  if (!Number.isSafeInteger(window) || window < 2) throw new Error("Invalid model context window.");
  return precision === "heuristic" ? Math.max(8_192, Math.ceil(window / 10)) : 1_024;
}

/**
 * Codex estimates before the next request is serialized. Keep a separate allowance
 * for estimator disagreement and one tool result, rather than compacting exactly
 * at Gateway's rejection boundary. Gateway still checks every final wire request.
 */
export function gatewayAutoCompactTokenLimit(window: number, toolOutputTokens = 10_000): number {
  if (!Number.isSafeInteger(toolOutputTokens) || toolOutputTokens < 0) {
    throw new Error("Invalid tool output token allowance.");
  }
  const estimatorAllowance = Math.max(4_096, Math.ceil(window / 20));
  const limit =
    window - contextInputReserve(window, "provider_exact") - estimatorAllowance - toolOutputTokens;
  if (limit < 1) throw new Error("Model context window cannot accommodate the Gateway compaction budget.");
  return limit;
}
