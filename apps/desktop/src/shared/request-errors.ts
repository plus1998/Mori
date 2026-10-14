export function isQuotaOrRateLimitFailure(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("429") ||
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("overloaded") ||
    normalized.includes("too many requests") ||
    normalized.includes("insufficient_quota") ||
    (normalized.includes("billing") && normalized.includes("limit"))
  );
}

/** @deprecated Prefer `isAcpProviderExhaustionMessage` from `@eco/runtime` — kept as a desktop alias. */
export { isAcpProviderExhaustionMessage as isRetriableProviderExhaustionMessage } from "@eco/runtime/acp-provider-exhaustion";
