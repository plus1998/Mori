import type { OpenAIAccountQuota, OpenAIAccountQuotaWindow } from "../shared/openai-account";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Native notifications are sparse: preserve untouched windows and full-read metadata. */
export function mergeCodexQuotaUpdate(
  cached: OpenAIAccountQuota,
  params: unknown,
  now = Date.now(),
): OpenAIAccountQuota | undefined {
  const payload = record(params);
  const buckets = record(payload?.rateLimitsByLimitId);
  const limits = record(buckets ? buckets.codex : payload?.rateLimits);
  if (!limits || (limits.limitId != null && limits.limitId !== "codex")) return undefined;
  const window = (value: unknown, previous: OpenAIAccountQuotaWindow | null): OpenAIAccountQuotaWindow | null => {
    if (value == null) return previous;
    const data = record(value);
    if (!data || typeof data.usedPercent !== "number" || !Number.isFinite(data.usedPercent) ||
        data.usedPercent < 0 || data.usedPercent > 100) throw new Error("Codex 额度通知的使用比例无效。");
    const duration = data.windowDurationMins ?? (previous ? previous.limitWindowSeconds / 60 : undefined);
    const resetAt = data.resetsAt ?? previous?.resetAt;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 ||
        typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0)
      throw new Error("Codex 额度通知缺少有效的窗口或重置时间。");
    if (previous && previous.usedPercent === data.usedPercent &&
        previous.limitWindowSeconds === duration * 60 && previous.resetAt === resetAt) return previous;
    return {
      usedPercent: data.usedPercent,
      limitWindowSeconds: duration * 60,
      resetAt,
      resetAfterSeconds: Math.max(0, Math.ceil(resetAt - now / 1_000)),
    };
  };
  if (limits.primary == null && limits.secondary == null) return undefined;
  const primaryWindow = window(limits.primary, cached.rateLimit.primaryWindow);
  const secondaryWindow = window(limits.secondary, cached.rateLimit.secondaryWindow);
  const limitReached = Boolean(limits.rateLimitReachedType) ||
    [primaryWindow, secondaryWindow].some((entry) => entry !== null && entry.usedPercent >= 100);
  return {
    ...cached,
    rateLimit: { allowed: !limitReached, limitReached, primaryWindow, secondaryWindow },
    fetchedAt: now,
  };
}
