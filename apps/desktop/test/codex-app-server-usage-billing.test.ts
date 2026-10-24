import { expect, test } from "bun:test";
import type { CodexTurnTokenUsageBreakdown } from "@eco/runtime";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import {
  buildCodexAppServerBillingRequests,
  normalizeCodexAppServerUsage,
} from "../src/main/codex-app-server-usage-billing";
import { parseOpenAiApiPricing, resolveOpenAiApiRates } from "../src/main/openai-api-pricing";
import { resolveSingleUsageBillingArtifacts } from "../src/main/usage-billing-artifacts";
import { buildThreadUsageLedgerEventView } from "../src/main/usage-ledger-view";
import { PRICING_MARKDOWN } from "./openai-api-pricing-fixture";

test("Codex input buckets are disjoint even with a low cache hit rate", () => {
  expect(
    normalizeCodexAppServerUsage({
      inputTokens: 1_000,
      cachedInputTokens: 100,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      totalTokens: 1_050,
    }),
  ).toEqual({
    inputTokens: 900,
    outputTokens: 50,
    cacheReadTokens: 100,
    cacheCreationTokens: 0,
    reasoningTokens: 20,
  });
});

test("Codex invalid cached input fails instead of silently clamping tokens", () => {
  expect(() =>
    normalizeCodexAppServerUsage({
      inputTokens: 100,
      cachedInputTokens: 101,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 100,
    }),
  ).toThrow("cachedInputTokens must be a subset of inputTokens");
});

test("Codex Luna turn usage stays consistent through ledger, totals and event display", async () => {
  // Regression counts: each entry is a turn's model-request sum, not its context window.
  const turns: CodexTurnTokenUsageBreakdown[] = [
    {
      inputTokens: 366_053,
      cachedInputTokens: 321_024,
      outputTokens: 4_495,
      reasoningOutputTokens: 2_461,
      totalTokens: 370_548,
    },
    {
      inputTokens: 1_164_378,
      cachedInputTokens: 1_117_696,
      outputTokens: 8_461,
      reasoningOutputTokens: 5_553,
      totalTokens: 1_172_839,
    },
  ];
  const artifacts = await Promise.all(
    turns.map((turn, index) =>
      resolveSingleUsageBillingArtifacts({
        threadId: "thr_codex_luna_billing",
        role: "main",
        source: "codex",
        providerId: "openai",
        modelId: "gpt-6-luna",
        usage: normalizeCodexAppServerUsage(turn),
        runtimeRoutes: [],
        lookupPricing: async () => null,
        codexPlannerModelId: "gpt-6-luna",
        // This regression fixture represents sums of multiple short requests.
        lookupCodexApiRates: async () =>
          parseOpenAiApiPricing(PRICING_MARKDOWN)["gpt-6-luna"]?.shortContext ?? null,
        requestKey: `codex-turn-usage:thread:turn-${index}`,
        plannerAgentId: `main:attempt-${index}`,
      }),
    ),
  );
  const events = artifacts.map((entry) => entry.ledgerEvent);
  const views = events.map(buildThreadUsageLedgerEventView);
  expect(views[0]).toMatchObject({
    inputTokens: 45_029,
    cacheReadTokens: 321_024,
    outputTokens: 4_495,
    reasoningTokens: 2_461,
    pricingResolved: true,
  });
  expect(views[0]?.ecoCostUsd).toBeCloseTo(0.00996064, 8);
  expect(views[1]?.ecoCostUsd).toBeCloseTo(0.02007566, 8);
  const projection = projectBillingFromUsageLedger({ events });
  expect(projection.unresolvedEventCount).toBe(0);
  expect(projection.snapshot?.totalTokens).toEqual({
    input: 91_711,
    output: 12_956,
    cacheRead: 1_438_720,
    cacheCreation: 0,
  });
  expect(projection.snapshot?.ecoCostUsd).toBeCloseTo(0.0300363, 8);
  expect(1_438_720 / (91_711 + 1_438_720)).toBeCloseTo(0.9401, 4);
});

test("unknown direct OpenAI models cannot produce a resolved Astra estimate", async () => {
  const result = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_unknown_codex_model",
    role: "main",
    source: "codex",
    providerId: "openai",
    modelId: "gpt-6-unknown",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    runtimeRoutes: [],
    lookupPricing: async () => null,
  });
  expect(result.requestBilling.pricingResolved).toBe(false);
  expect(result.actualRates).toBeNull();
});

test("request-level pricing does not turn a sum of short requests into a long-context charge", async () => {
  const one = {
    inputTokens: 200_000,
    cachedInputTokens: 100_000,
    outputTokens: 1000,
    reasoningOutputTokens: 0,
    totalTokens: 201_000,
  };
  const two = { ...one, inputTokens: 300_000, totalTokens: 301_000 };
  const total = {
    inputTokens: 500_000,
    cachedInputTokens: 200_000,
    outputTokens: 2000,
    reasoningOutputTokens: 0,
    totalTokens: 502_000,
  };
  const prices = parseOpenAiApiPricing(PRICING_MARKDOWN);
  const requests = buildCodexAppServerBillingRequests({
    usage: total,
    requests: [one, two],
    requestKey: "turn",
  });
  const artifacts = await Promise.all(
    requests.map(async (request) =>
      resolveSingleUsageBillingArtifacts({
        threadId: "thr_tier",
        role: "main",
        source: "codex",
        providerId: "openai",
        modelId: "gpt-6.1-sol",
        codexPlannerModelId: "gpt-6.1-sol",
        usage: request.usage,
        runtimeRoutes: [],
        lookupPricing: async () => null,
        lookupCodexApiRates: async (id, usage) =>
          resolveOpenAiApiRates(prices[id], usage, request.codexUsageIsAggregate),
        requestKey: request.requestKey,
      }),
    ),
  );
  expect(artifacts[0]?.actualRates?.input).toBe(2);
  expect(artifacts[1]?.actualRates?.input).toBe(4);
  expect(artifacts.reduce((sum, result) => sum + result.requestBilling.ecoCostUsd, 0)).toBeCloseTo(1.055, 6);
  expect(requests.map((request) => request.requestKey)).toEqual(["turn:request:0", "turn:request:1"]);
  const [aggregate] = buildCodexAppServerBillingRequests({ usage: total, requestKey: "turn" });
  if (!aggregate) throw new Error("Missing aggregate request");
  expect(
    resolveOpenAiApiRates(prices["gpt-6.1-sol"], aggregate.usage, aggregate.codexUsageIsAggregate),
  ).toBeNull();
  expect(() =>
    buildCodexAppServerBillingRequests({ usage: total, requests: [one], requestKey: "turn" }),
  ).toThrow(/does not match/);
});
