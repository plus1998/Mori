import { describe, expect, test } from "bun:test";
import { parseCursorUsageSummary } from "../src/main/cursor-account-quota";

describe("Cursor account quota", () => {
  const billingCycleEnd = "2026-12-16T15:49:23.441Z";

  test("uses reported percentages for a free account without treating a zero API limit as available", () => {
    const result = parseCursorUsageSummary(JSON.stringify({
      billingCycleEnd,
      membershipType: "free",
      individualUsage: {
        plan: { limit: 0, remaining: 0, totalPercentUsed: 52, autoPercentUsed: 100, apiPercentUsed: 0 },
      },
    }));
    expect(result).toEqual({
      ok: true,
      quota: {
        planType: "free",
        fetchedAt: expect.any(Number),
        resetAt: Date.parse(billingCycleEnd),
        buckets: [{ kind: "total", usedPercent: 52 }, { kind: "auto", usedPercent: 100 }],
      },
    });
  });

  test("keeps zero usage for a paid account and omits unreported buckets", () => {
    const result = parseCursorUsageSummary(JSON.stringify({
      membershipType: "pro",
      individualUsage: { plan: { autoPercentUsed: 4.5, apiPercentUsed: 0 } },
    }));
    expect(result).toEqual({
      ok: true,
      quota: {
        planType: "pro",
        fetchedAt: expect.any(Number),
        buckets: [{ kind: "auto", usedPercent: 4.5 }, { kind: "api", usedPercent: 0 }],
      },
    });
  });

  test("reports missing quota and invalid responses explicitly", () => {
    expect(parseCursorUsageSummary('{"membershipType":"enterprise","teamUsage":{}}'))
      .toEqual({ ok: false, code: "quotaUnavailable" });
    expect(parseCursorUsageSummary('<html>Sign in</html>'))
      .toEqual({ ok: false, code: "quotaInvalidResponse" });
    expect(parseCursorUsageSummary('{"membershipType":"pro","individualUsage":{"plan":{"totalPercentUsed":-1}}}'))
      .toEqual({ ok: false, code: "quotaInvalidResponse" });
  });
});
