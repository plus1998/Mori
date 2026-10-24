import type { OpenAIAccountQuota } from "./openai-account";

/** Minimum interval shared by all automatic quota requests for one account. */
export const CODEX_QUOTA_REFRESH_MS = 5 * 60_000;

/** A snapshot read after a window's reset already covers that reset. */
export function hasUnrefreshedCodexQuotaReset(quota: OpenAIAccountQuota, now = Date.now()): boolean {
  return [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].some((window) => {
    if (!window || !Number.isFinite(window.resetAt) || window.resetAt <= 0) return false;
    const resetAt = window.resetAt * 1_000;
    return quota.fetchedAt < resetAt && resetAt <= now;
  });
}

/** One wake-up for an unconfirmed reset, respecting the same cooldown as the main process. */
export function nextCodexQuotaResetCheckAt(
  quota: OpenAIAccountQuota,
  state?: import("./openai-account").OpenAIAccountQuotaRefreshState,
): number | undefined {
  if (state?.authRequired) return undefined;
  const resetTimes = [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].flatMap((window) =>
    window &&
    Number.isFinite(window.resetAt) &&
    window.resetAt > 0 &&
    window.resetAt * 1_000 > quota.fetchedAt
      ? [window.resetAt * 1_000]
      : [],
  );
  if (!resetTimes.length) return undefined;
  return Math.max(
    Math.min(...resetTimes),
    quota.fetchedAt + CODEX_QUOTA_REFRESH_MS,
    (state?.attemptedAt ?? 0) + CODEX_QUOTA_REFRESH_MS,
    state?.retryAt ?? 0,
  );
}
