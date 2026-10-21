import { expect, test } from "bun:test";
import type { ModelPricingLookup, ParsedUsage } from "@eco/runtime";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import { ThreadUsageAccumulator } from "../src/main/thread-usage-accumulator";
import {
  resolveSdkRunBillingModels,
  resolveSingleUsageBillingArtifacts,
  type UsageBillingPricingRoute,
} from "../src/main/usage-billing-artifacts";
import {
  buildSyntheticSdkPrimaryRequestKey,
  recordLegacySdkRunBilling,
  recordLegacySingleUsageBilling,
  resolveSyntheticSdkPrimaryFill,
} from "../src/main/usage-legacy-billing";

const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };

function usage(inputTokens = 10_000): ParsedUsage {
  return { inputTokens, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

const provider: ProviderConfigSecret = {
  id: "provider_test",
  name: "Test Provider",
  baseUrl: "https://api.example.test",
  requestPath: "/v1/messages",
  version: "v1",
  apiCompat: "anthropic",
  defaultModel: "sonnet",
  enabled: true,
  hasApiKey: true,
  apiKeyPreview: "sk-...",
  apiKey: "sk-test",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const routes: RuntimeRoute[] = [
  { role: "main", provider, modelId: "sonnet", apiCompat: "anthropic" },
  { role: "coder", provider, modelId: "haiku", apiCompat: "anthropic" },
];

async function lookupPricing(route: UsageBillingPricingRoute): Promise<ModelPricingLookup> {
  return {
    providerKey: "test",
    modelId: route.modelId,
    rates: route.modelId === "haiku" ? haikuRates : sonnetRates,
    displayName: route.modelId === "haiku" ? "Claude Haiku" : "Claude Sonnet",
  };
}

test("recordLegacySingleUsageBilling keeps proxy primary when synthetic fill is disabled", async () => {
  const accumulator = new ThreadUsageAccumulator();
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_legacy_proxy_only",
    role: "coder",
    source: "proxy",
    usage: usage(2_000),
    runtimeRoutes: routes,
    lookupPricing,
    agentId: "agent_coder",
    requestKey: "proxy:coder:req_1",
  });

  const result = recordLegacySingleUsageBilling(accumulator, {
    threadId: "thr_legacy_proxy_only",
    artifacts,
    agentId: "agent_coder",
    reconciliationOnly: true,
    fillSdkPrimaryForSubagent: false,
  });

  expect(result.filledSdkPrimary).toBe(false);
  expect(result.syntheticSdkPrimaryDecision).toEqual({
    fill: false,
    reason: "not_requested",
  });
  expect(result.snapshot.primarySource).toBe("proxy");
  expect(result.snapshot.sourceBreakdown?.sdk).toBeUndefined();
});

test("recordLegacySingleUsageBilling does not let a vision-only proxy source replace SDK primary", async () => {
  const accumulator = new ThreadUsageAccumulator();
  const visionArtifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_legacy_vision",
    role: "vision",
    source: "proxy",
    usage: usage(147_000),
    runtimeRoutes: routes,
    lookupPricing,
    agentId: "vision:thr_legacy_vision:1",
    requestKey: "proxy:vision:req_1",
  });
  recordLegacySingleUsageBilling(accumulator, {
    threadId: "thr_legacy_vision",
    artifacts: visionArtifacts,
    agentId: "vision:thr_legacy_vision:1",
    reconciliationOnly: true,
    fillSdkPrimaryForSubagent: false,
  });

  const mainArtifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_legacy_vision",
    role: "main",
    source: "sdk",
    usage: usage(403),
    runtimeRoutes: routes,
    lookupPricing,
    requestKey: "sdk:main:req_1",
  });
  const result = recordLegacySingleUsageBilling(accumulator, {
    threadId: "thr_legacy_vision",
    artifacts: mainArtifacts,
  });

  expect(result.snapshot.primarySource).toBe("sdk");
  expect(result.snapshot.totalTokens.input).toBe(403);
  expect(result.snapshot.sourceBreakdown?.proxy?.byRole?.vision?.inputTokens).toBe(147_000);
});

test("recordLegacySingleUsageBilling fills synthetic SDK primary when explicitly requested", async () => {
  const accumulator = new ThreadUsageAccumulator();
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_legacy_single",
    role: "coder",
    source: "proxy",
    usage: usage(2_000),
    runtimeRoutes: routes,
    lookupPricing,
    agentId: "agent_coder",
    requestKey: "proxy:coder:req_1",
  });

  const result = recordLegacySingleUsageBilling(accumulator, {
    threadId: "thr_legacy_single",
    artifacts,
    agentId: "agent_coder",
    reconciliationOnly: true,
    fillSdkPrimaryForSubagent: true,
  });

  expect(result.filledSdkPrimary).toBe(true);
  expect(result.syntheticSdkPrimaryDecision).toEqual({
    fill: true,
    reason: "subagent_compatibility",
  });
  expect(result.snapshot.primarySource).toBe("proxy");
  expect(result.snapshot.sourceBreakdown?.proxy).toBeDefined();
  expect(result.snapshot.sourceBreakdown?.sdk).toBeDefined();
  expect(
    accumulator.hasSeenRequestKey(
      "thr_legacy_single",
      buildSyntheticSdkPrimaryRequestKey("proxy:coder:req_1"),
    ),
  ).toBe(true);
});

test("recordLegacySingleUsageBilling skips synthetic SDK primary outside subagent attribution", async () => {
  const accumulator = new ThreadUsageAccumulator();
  const artifacts = await resolveSingleUsageBillingArtifacts({
    threadId: "thr_legacy_no_fill",
    role: "main",
    source: "proxy",
    usage: usage(2_000),
    runtimeRoutes: routes,
    lookupPricing,
    requestKey: "proxy:main:req_1",
  });

  const result = recordLegacySingleUsageBilling(accumulator, {
    threadId: "thr_legacy_no_fill",
    artifacts,
    fillSdkPrimaryForSubagent: true,
  });

  expect(result.filledSdkPrimary).toBe(false);
  expect(result.syntheticSdkPrimaryDecision).toEqual({
    fill: false,
    reason: "non_subagent_role",
  });
  expect(result.snapshot.primarySource).toBe("proxy");
  expect(result.snapshot.sourceBreakdown?.sdk).toBeUndefined();
});

test("resolveSyntheticSdkPrimaryFill reports audit-friendly skip reasons", () => {
  expect(
    resolveSyntheticSdkPrimaryFill({
      requested: false,
      role: "coder",
      hasAgent: true,
      alreadySeen: false,
    }),
  ).toEqual({ fill: false, reason: "not_requested" });
  expect(
    resolveSyntheticSdkPrimaryFill({
      requested: true,
      role: "coder",
      hasAgent: false,
      alreadySeen: false,
    }),
  ).toEqual({ fill: false, reason: "missing_agent" });
  expect(
    resolveSyntheticSdkPrimaryFill({
      requested: true,
      role: "main",
      hasAgent: true,
      alreadySeen: false,
    }),
  ).toEqual({ fill: false, reason: "non_subagent_role" });
  expect(
    resolveSyntheticSdkPrimaryFill({
      requested: true,
      role: "coder",
      hasAgent: true,
      alreadySeen: true,
    }),
  ).toEqual({ fill: false, reason: "already_seen" });
});

test("recordLegacySdkRunBilling records SDK run totals through the legacy accumulator", async () => {
  const accumulator = new ThreadUsageAccumulator();
  const resolved = await resolveSdkRunBillingModels({
    role: "coder",
    models: [{ modelId: "haiku", usage: usage(3_000), sdkCostUsd: 0.125 }],
    runtimeRoutes: routes,
    lookupPricing,
  });

  const snapshot = recordLegacySdkRunBilling(accumulator, {
    threadId: "thr_legacy_sdk_run",
    role: "coder",
    requestKey: "sdk-result:evt_1",
    models: resolved.models,
    totalCostUsd: 0.125,
    plannerModelLabel: resolved.plannerModelLabel,
  });

  expect(snapshot.primarySource).toBe("sdk");
  expect(snapshot.sourceBreakdown?.sdk?.reportedCostUsd).toBe(0.125);
  expect(snapshot.byModel?.[0]).toMatchObject({
    modelId: "haiku",
    inputTokens: 3_000,
    outputTokens: 1_000,
  });
});
