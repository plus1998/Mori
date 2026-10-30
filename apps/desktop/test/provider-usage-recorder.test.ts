import { expect, test } from "bun:test";
import type { AccountUsageRecord } from "../src/main/account-usage-store";
import { recordProviderUsage } from "../src/main/provider-usage-recorder";
import type { UsageBillingPricingLookup } from "../src/main/usage-billing-artifacts";

const record: AccountUsageRecord = {
  kind: "custom_provider",
  accountId: "provider",
  eventId: "physical-response",
  modelId: "model",
  observedAt: 100,
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadTokens: 200_000,
  cacheCreationTokens: 100_000,
};
function fixture(lookupPricing: UsageBillingPricingLookup) {
  const records = new Map<string, AccountUsageRecord>();
  const costs = new Map<string, number>();
  const failures: unknown[] = [];
  const pricingFailures: unknown[] = [];
  return {
    records,
    costs,
    failures,
    pricingFailures,
    services: {
      store: {
        append(value: AccountUsageRecord) {
          if (records.has(value.eventId)) return false;
          records.set(value.eventId, value);
          return true;
        },
        setEstimatedCost(value: Pick<AccountUsageRecord, "eventId">, cost: number) {
          costs.set(value.eventId, cost);
        },
      },
      lookupPricing,
      recordingFailed: (_record: AccountUsageRecord, error: unknown) => {
        failures.push(error);
      },
      pricingFailed: (_record: AccountUsageRecord, error: unknown) => {
        pricingFailures.push(error);
      },
    },
  };
}

test("tokens persist before asynchronous pricing and duplicate physical usage resolves once", async () => {
  let release: (() => void) | undefined;
  let lookups = 0;
  const deferred = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async () => {
    lookups++;
    await deferred;
    return {
      providerKey: "vendor",
      modelId: "model",
      rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.5 },
    };
  });
  const route = { provider: { baseUrl: "https://vendor.invalid" }, modelId: "model" };
  const pending = recordProviderUsage(f.services, record, route);
  expect(f.records.size).toBe(1);
  expect(f.costs.size).toBe(0);
  await recordProviderUsage(f.services, record, route);
  expect(lookups).toBe(1);
  release?.();
  await pending;
  expect(f.costs.get(record.eventId)).toBeCloseTo(2.17);
});

test("manual prices and multiplier apply; missing cache rates remain unpriced", async () => {
  const f = fixture(async () => null);
  const provider = { baseUrl: "https://vendor.invalid" };
  await recordProviderUsage(f.services, record, {
    provider,
    modelId: "model",
    manualSpec: { inputPerM: 1, outputPerM: 2 },
  });
  expect(f.costs.size).toBe(0);
  await recordProviderUsage(
    f.services,
    { ...record, eventId: "priced" },
    {
      provider,
      modelId: "model",
      manualSpec: {
        inputPerM: 1,
        outputPerM: 2,
        cacheReadPerM: 0.1,
        cacheWritePerM: 1.5,
        priceMultiplier: 2,
      },
    },
  );
  expect(f.costs.get("priced")).toBeCloseTo(4.34);
});

test("lookup failure preserves tokens and write failure is reported without failing the request", async () => {
  const f = fixture(async () => {
    throw new Error("catalog unavailable");
  });
  await recordProviderUsage(f.services, record, {
    provider: { baseUrl: "https://vendor.invalid" },
    modelId: "model",
  });
  expect(f.records.size).toBe(1);
  expect(f.costs.size).toBe(0);
  expect(f.pricingFailures).toHaveLength(1);
  f.services.store.append = () => {
    throw new Error("disk full");
  };
  await recordProviderUsage(f.services, { ...record, eventId: "failed" });
  expect(f.failures).toHaveLength(1);
});
