import { expect, test } from "bun:test";
import { CodexQuotaRefreshPolicy, readQuotaRetryAt } from "../src/main/codex-quota-refresh-policy";
import {
  CODEX_QUOTA_REFRESH_MS,
  hasUnrefreshedCodexQuotaReset,
  nextCodexQuotaResetCheckAt,
} from "../src/shared/codex-quota-refresh";
import type { OpenAIAccountQuota } from "../src/shared/openai-account";

const start = 1_800_000_000_000;
function quota(fetchedAt = start): OpenAIAccountQuota {
  return {
    fetchedAt,
    planType: "plus",
    email: "",
    resetCreditsAvailable: 0,
    rateLimit: {
      allowed: false,
      limitReached: true,
      primaryWindow: {
        usedPercent: 100,
        limitWindowSeconds: 18000,
        resetAfterSeconds: 60,
        resetAt: (start + 60_000) / 1000,
      },
      secondaryWindow: null,
    },
  };
}

test("all automatic entry points share a five-minute freshness limit; manual refresh bypasses it", () => {
  let now = start;
  const policy = new CodexQuotaRefreshPolicy(() => now);
  const cached = quota();
  policy.begin("a", "auth");
  policy.succeed("a", "auth");
  for (const reason of ["usage", "switch"] as const)
    expect(policy.check("a", "auth", cached, reason)).toBe("cached");
  now += 60_000;
  expect(policy.check("a", "auth", cached, "reset")).toBe("skip");
  expect(policy.check("a", "auth", cached, "manual")).toBe("query");
  now = start + CODEX_QUOTA_REFRESH_MS;
  for (const reason of ["usage", "switch", "reset"] as const)
    expect(policy.check("a", "auth", cached, reason)).toBe("query");
  expect(policy.check("b", "auth", undefined, "usage")).toBe("query");
});

test("automatic failures back off for 5, 15, then 30 minutes, while explicit requests can retry", () => {
  let now = start;
  const policy = new CodexQuotaRefreshPolicy(() => now);
  for (const delay of [5, 15, 30, 30]) {
    policy.begin("a", "auth");
    policy.fail("a", "auth", new Error("503 offline"));
    expect(policy.state("a", "auth")?.retryAt).toBe(now + delay * 60_000);
    expect(() => policy.check("a", "auth", undefined, "usage")).toThrow("503 offline");
    expect(policy.check("a", "auth", undefined, "manual")).toBe("query");
    now += delay * 60_000;
    expect(policy.check("a", "auth", undefined, "usage")).toBe("query");
  }
  policy.succeed("a", "auth");
  expect(policy.state("a", "auth")?.error).toBeUndefined();
});

test("authentication failure stops automatic requests until credentials change or a manual request succeeds", () => {
  let now = start;
  const policy = new CodexQuotaRefreshPolicy(() => now);
  policy.fail("a", "old", new Error("401 unauthorized"));
  now += 24 * 60 * 60_000;
  expect(() => policy.check("a", "old", undefined, "usage")).toThrow("401");
  expect(policy.check("a", "old", undefined, "manual")).toBe("query");
  expect(policy.check("a", "new", undefined, "usage")).toBe("query");
  expect(policy.state("a", "new")).toBeUndefined();
});

test("explicit upstream Retry-After also blocks manual refresh", () => {
  let now = start;
  const policy = new CodexQuotaRefreshPolicy(() => now);
  const error = Object.assign(new Error("429 limited"), { data: { headers: { "retry-after": "600" } } });
  policy.fail("a", "auth", error);
  expect(() => policy.check("a", "auth", undefined, "manual")).toThrow("429");
  now += 600_000;
  expect(policy.check("a", "auth", undefined, "manual")).toBe("query");
  expect(readQuotaRetryAt(new Error("Retry-After: 120"), start)).toBe(start + 120_000);
  expect(readQuotaRetryAt({ data: { retryAfter: new Date(start + 60_000).toUTCString() } }, start)).toBe(
    start + 60_000,
  );
});

test("reset checks never invent resets, and a post-reset snapshot covers that window", () => {
  for (const resetAt of [0, -1, NaN, Infinity]) {
    const cached = quota();
    cached.rateLimit.primaryWindow!.resetAt = resetAt;
    expect(hasUnrefreshedCodexQuotaReset(cached, start + 60_000)).toBe(false);
  }
  expect(hasUnrefreshedCodexQuotaReset(quota(), start + 59_999)).toBe(false);
  expect(hasUnrefreshedCodexQuotaReset(quota(), start + 60_000)).toBe(true);
  expect(hasUnrefreshedCodexQuotaReset(quota(start + 60_000), start + 60_000)).toBe(false);
  const policy = new CodexQuotaRefreshPolicy(() => start + 60_000);
  expect(policy.check("a", "auth", undefined, "reset")).toBe("skip");
});

test("visible reset watchers wait for cooldown/backoff and stop once reset is confirmed", () => {
  const cached = quota();
  expect(nextCodexQuotaResetCheckAt(cached)).toBe(start + CODEX_QUOTA_REFRESH_MS);
  expect(
    nextCodexQuotaResetCheckAt(cached, { attemptedAt: start + 60_000, retryAt: start + 15 * 60_000 }),
  ).toBe(start + 15 * 60_000);
  expect(nextCodexQuotaResetCheckAt(cached, { attemptedAt: start, authRequired: true })).toBeUndefined();
  expect(nextCodexQuotaResetCheckAt(quota(start + 60_000))).toBeUndefined();
});
