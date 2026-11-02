import type { OpenAIAccountImageQuota, OpenAIAccountQuota } from "./openai-account";

/** Freshness/cooldown for quota reads triggered by opening an account view. */
export const CODEX_QUOTA_REFRESH_MS = 60_000;

export function nextImageQuotaResetCheckAt(quota?: OpenAIAccountImageQuota): number | undefined {
  if (quota?.status !== "available" || !quota.resetAt) return undefined;
  const resetAt = Date.parse(quota.resetAt);
  return Number.isFinite(resetAt) && resetAt > quota.fetchedAt ? resetAt : undefined;
}

/** A snapshot read after a window's reset already covers that reset. */
export function hasUnrefreshedCodexQuotaReset(quota: OpenAIAccountQuota, now = Date.now()): boolean {
  return [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].some((window) => {
    if (!window || !Number.isFinite(window.resetAt) || window.resetAt <= 0) return false;
    const resetAt = window.resetAt * 1_000;
    return quota.fetchedAt < resetAt && resetAt <= now;
  });
}
