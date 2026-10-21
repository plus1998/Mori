import { expect, test } from "bun:test";
import type { CodexTurnTokenUsageBreakdown } from "@eco/runtime";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import { resolveBuiltInOpenAiDefaultRates } from "../src/main/built-in-openai-pricing";
import { normalizeCodexAppServerUsage } from "../src/main/codex-app-server-usage-billing";
import { resolveSingleUsageBillingArtifacts } from "../src/main/usage-billing-artifacts";
import { buildThreadUsageLedgerEventView } from "../src/main/usage-ledger-view";

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

test("GPT-6 model variants use their own public rates and unknown models stay unresolved", () => {
  expect(resolveBuiltInOpenAiDefaultRates("gpt-6-luna-max")).toEqual({
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
  });
  expect(resolveBuiltInOpenAiDefaultRates("gpt-6-sol-xhigh")).toMatchObject({
    input: 2,
    output: 10,
    cacheRead: 0.2,
  });
  expect(resolveBuiltInOpenAiDefaultRates("gpt-6.1-sol")).toMatchObject({
    input: 2,
    output: 10,
    cacheRead: 0.1,
  });
  expect(resolveBuiltInOpenAiDefaultRates("gpt-6-astra-high")).toMatchObject({
    input: 10,
    output: 50,
    cacheRead: 1,
  });
  expect(resolveBuiltInOpenAiDefaultRates("gpt-6-unknown")).toBeNull();
  expect(resolveBuiltInOpenAiDefaultRates("gpt-6-lunatic")).toBeNull();
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
