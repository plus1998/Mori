import type { OpenAIAccountQuota, OpenAIAccountQuotaWindow } from "../shared/openai-account";

/** Use the next reset, or wait for every exhausted window when usage is blocked. */
export function nextScheduledMessageQuotaReset(
  quota: OpenAIAccountQuota,
  now = Date.now(),
): string | undefined {
  const windows = [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].filter(
    (window): window is OpenAIAccountQuotaWindow =>
      window !== null &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 &&
      window.usedPercent <= 100,
  );
  const exhausted = windows.filter((window) => window.usedPercent === 100);
  const candidates = exhausted.length ? exhausted : windows;
  const resets = candidates.map((window) => {
    if (Number.isFinite(window.resetAt) && window.resetAt > 0) return window.resetAt * 1000;
    return Number.isFinite(quota.fetchedAt) &&
      Number.isFinite(window.resetAfterSeconds) &&
      window.resetAfterSeconds > 0
      ? quota.fetchedAt + window.resetAfterSeconds * 1000
      : NaN;
  });
  if (exhausted.length && resets.some((at) => !Number.isFinite(new Date(at).getTime()))) return undefined;
  const future = resets.filter((at) => at > now && Number.isFinite(new Date(at).getTime()));
  if (!future.length) return undefined;
  const at = exhausted.length ? Math.max(...future) : Math.min(...future);
  return new Date(at).toISOString();
}
