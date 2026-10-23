import { expect, test } from "bun:test";
import type { ParsedUsage } from "@eco/runtime";
import { readUsageLedgerComputedBilling } from "../src/main/usage-ledger-cost-metadata";
import { createAccountUsagePricingLookup } from "../src/main/account-usage-pricing";
import { lookupRoutePricingHints, type RuntimeRoute } from "../src/main/billing-resolver";
import type { ModelsDevPricingCache } from "../src/main/models-dev-pricing-cache";
import type { ModelSettingsSnapshot } from "../src/shared/ipc";
import {
  resolveSdkRunBillingModels,
  resolveSdkStreamPartialBillingArtifacts,
  resolveSingleUsageBillingArtifacts,
} from "../src/main/usage-billing-artifacts";

const usage: ParsedUsage = {
  inputTokens: 300_000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};
const route: RuntimeRoute = {
  role: "main",
  modelId: "selected-model",
  apiCompat: "openai",
  provider: {
    id: "eco-coding-chatgpt",
    name: "ChatGPT",
    baseUrl: "https://api.openai.com",
    authMethod: "chatgpt_subscription",
  } as RuntimeRoute["provider"],
  manualSpec: { inputPerM: 999, outputPerM: 999 },
};

test("OAuth pricing only uses the official cache, including unknown prices; ordinary providers keep their lookup", async () => {
  let otherCalls = 0;
  const seen: unknown[] = [];
  const lookup = createAccountUsagePricingLookup({
    lookupChatGptApiRates: async (...args) => {
      seen.push(args);
      return args[0] === "free" ? { input: 0, output: 0 } : null;
    },
    lookupOtherPricing: async () => {
      otherCalls++;
      return null;
    },
  });
  expect(await lookup(route, usage)).toBeNull();
  expect(await lookup({ ...route, modelId: "free" }, usage)).toMatchObject({
    rates: { input: 0, output: 0 },
  });
  expect(otherCalls).toBe(0);
  expect(seen).toEqual([
    ["selected-model", usage, false],
    ["free", usage, false],
  ]);
  await lookup({ ...route, provider: { baseUrl: "https://other.test" } }, usage);
  expect(otherCalls).toBe(1);
});

test("proxy requests price the reported OAuth model and never use stale manual prices", async () => {
  const seen: unknown[] = [];
  const lookup = createAccountUsagePricingLookup({
    lookupChatGptApiRates: async (...args) => {
      seen.push(args);
      return args[0] === "reported-model" ? { input: 4, output: 15 } : null;
    },
    lookupOtherPricing: async () => {
      throw new Error("unexpected network pricing");
    },
  });
  const result = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_test",
    role: "main",
    source: "proxy",
    modelId: "reported-model",
    usage,
    runtimeRoutes: [route],
    lookupPricing: lookup,
  });
  expect(seen).toEqual([
    ["reported-model", usage, false],
    ["selected-model", usage, false],
  ]);
  expect(result.actualRates).toEqual({ input: 4, output: 15 });
  expect(result.plannerRates).toBeNull();
  const unknown = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_test",
    role: "main",
    source: "proxy",
    modelId: "unknown",
    usage,
    runtimeRoutes: [route],
    lookupPricing: lookup,
  });
  expect(unknown.actualRates).toBeNull();
});

test("SDK partial and run totals retain aggregate semantics and do not substitute manual prices", async () => {
  const aggregates: boolean[] = [];
  const lookup = createAccountUsagePricingLookup({
    lookupChatGptApiRates: async (_model, _usage, aggregate) => {
      aggregates.push(aggregate);
      return null;
    },
    lookupOtherPricing: async () => {
      throw new Error("unexpected fallback");
    },
  });
  const partial = await resolveSdkStreamPartialBillingArtifacts({
    threadId: "thr_test",
    eventId: "event_test",
    role: "main",
    usage,
    runtimeRoutes: [route],
    lookupPricing: lookup,
  });
  expect(readUsageLedgerComputedBilling(partial.ledgerEvent.metadata)?.ecoCostUsd).toBe(0);
  const run = await resolveSdkRunBillingModels({
    role: "main",
    models: [{ modelId: "selected-model", usage }],
    runtimeRoutes: [route],
    lookupPricing: lookup,
  });
  expect(run.models[0]?.actualRates).toBeNull();
  expect(run.plannerRates).toBeNull();
  expect(aggregates).toEqual([true, true, true, true]);
});

test("OAuth price hints use cached official prices and never models.dev or manual overrides", async () => {
  const cache = {
    lookupForRoute: async () => {
      throw new Error("unexpected models.dev lookup");
    },
  } as unknown as ModelsDevPricingCache;
  const selected = [
    { role: route.role, providerId: route.provider.id, modelId: route.modelId, manualSpec: route.manualSpec },
  ];
  const hints = await lookupRoutePricingHints(
    cache,
    {} as ModelSettingsSnapshot,
    [route.provider],
    selected,
    async () => ({ providerKey: "openai", modelId: route.modelId, rates: { input: 2, output: 10 } }),
  );
  expect(hints[0]).toMatchObject({ pricingResolved: true, rates: { inputPerM: 2, outputPerM: 10 } });
  const unknown = await lookupRoutePricingHints(
    cache,
    {} as ModelSettingsSnapshot,
    [route.provider],
    selected,
    async () => null,
  );
  expect(unknown[0]?.pricingResolved).toBe(false);
  expect(unknown[0]?.rates).toBeUndefined();
});
