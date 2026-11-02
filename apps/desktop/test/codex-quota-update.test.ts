import { expect, test } from "bun:test";
import { mergeCodexQuotaUpdate } from "../src/main/codex-quota-update";
import type { OpenAIAccountQuota } from "../src/shared/openai-account";

const cached: OpenAIAccountQuota = {
  fetchedAt: 1_800_000_000_000, planType: "plus", email: "test@example.test", resetCreditsAvailable: 2,
  rateLimit: {
    allowed: true, limitReached: false,
    primaryWindow: { usedPercent: 20, limitWindowSeconds: 18_000, resetAt: 1_800_010_000, resetAfterSeconds: 10_000 },
    secondaryWindow: { usedPercent: 30, limitWindowSeconds: 604_800, resetAt: 1_800_020_000, resetAfterSeconds: 20_000 },
  },
};

test("sparse updates preserve omitted/null windows and metadata and can exhaust a window", () => {
  const merged = mergeCodexQuotaUpdate(cached, { rateLimits: {
    limitId: "codex", primary: { usedPercent: 100 }, secondary: null,
  } }, cached.fetchedAt);
  expect(merged?.rateLimit.primaryWindow?.usedPercent).toBe(100);
  expect(merged?.rateLimit.secondaryWindow).toEqual(cached.rateLimit.secondaryWindow);
  expect(merged?.rateLimit).toMatchObject({ allowed: false, limitReached: true });
  expect(merged?.fetchedAt).toBe(cached.fetchedAt);
  expect(merged?.resetCreditsAvailable).toBe(2);
});

test("unrelated buckets and empty notifications cannot erase ordinary quota", () => {
  for (const params of [null, {}, { rateLimits: { primary: null, secondary: null } },
    { rateLimits: { limitId: "premium", primary: { usedPercent: 100 } } },
    { rateLimitsByLimitId: { premium: { primary: { usedPercent: 100 } } } }]) {
    expect(mergeCodexQuotaUpdate(cached, params)).toBeUndefined();
  }
});

test("malformed percentages and window fields are rejected", () => {
  for (const usedPercent of [NaN, Infinity, -1, 101, "50"]) {
    expect(() => mergeCodexQuotaUpdate(cached, { rateLimits: { primary: { usedPercent } } })).toThrow("使用比例无效");
  }
  expect(() => mergeCodexQuotaUpdate(cached, { rateLimits: { primary: { usedPercent: 40, resetsAt: "bad" } } })).toThrow("重置时间");
});
