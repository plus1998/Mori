import { expect, test } from "bun:test";
import type { ModelPricingLookup } from "@eco/runtime";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import {
  resolveSingleUsageBillingOrchestration,
  type SingleUsageBillingRequest,
} from "../src/main/single-usage-billing-orchestration";
import type { UsageBillingPricingRoute } from "../src/main/usage-billing-artifacts";

const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };

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
  {
    role: "main",
    provider,
    modelId: "sonnet",
    apiCompat: "anthropic",
  },
  {
    role: "coder",
    provider,
    modelId: "haiku",
    apiCompat: "anthropic",
  },
];

function request(input: Partial<SingleUsageBillingRequest> = {}): SingleUsageBillingRequest {
  return {
    threadId: "thr_single",
    role: "coder",
    source: "proxy",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
    },
    modelId: "haiku",
    requestKey: "proxy:coder:haiku:req_1:100:20:3:4",
    ...input,
  };
}

async function lookupPricing(route: UsageBillingPricingRoute): Promise<ModelPricingLookup> {
  return {
    providerKey: "test",
    modelId: route.modelId,
    rates: route.modelId === "haiku" ? haikuRates : sonnetRates,
    displayName: route.modelId === "haiku" ? "Claude Haiku" : "Claude Sonnet",
  };
}

test("resolveSingleUsageBillingOrchestration skips zero token records without reported cost", async () => {
  const resolved = await resolveSingleUsageBillingOrchestration({
    request: request({
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      source: "sdk",
    }),
    runtimeRoutes: routes,
    lookupPricing,
  });

  expect(resolved).toBeNull();
});

test("resolveSingleUsageBillingOrchestration keeps cost-only sdk records", async () => {
  const resolved = await resolveSingleUsageBillingOrchestration({
    request: request({
      source: "sdk",
      role: "main",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      sourceReportedCostUsd: 0.01,
      updateContext: false,
      requestKey: "sdk:main:0:0:0:0:1",
    }),
    runtimeRoutes: routes,
    lookupPricing,
  });

  expect(resolved).not.toBeNull();
  expect(resolved?.effectsInput.updateContext).toBe(false);
  expect(resolved?.effectsInput.sourceReportedCostUsd).toBe(0.01);
  expect(resolved?.requestBillingLog.sourceReportedCostUsd).toBe(0.01);
});

test("resolveSingleUsageBillingOrchestration passthrough reasoningTokens to ledger", async () => {
  const resolved = await resolveSingleUsageBillingOrchestration({
    request: request({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 34,
      },
    }),
    runtimeRoutes: routes,
    lookupPricing,
  });

  expect(resolved?.effectsInput.artifacts.ledgerEvent.reasoningTokens).toBe(34);
});

test("resolveSingleUsageBillingOrchestration builds effects input with default context update", async () => {
  const resolved = await resolveSingleUsageBillingOrchestration({
    request: request({
      agentId: "agent_coder_1",
      runAttemptId: "attempt_1",
      plannerAgentId: "planner_attempt_1",
      parentToolUseId: "toolu_parent",
      reconciliationOnly: true,
      fillSdkPrimaryForSubagent: true,
    }),
    runtimeRoutes: routes,
    lookupPricing,
  });

  expect(resolved?.effectsInput).toMatchObject({
    threadId: "thr_single",
    updateContext: true,
    agentId: "agent_coder_1",
    reconciliationOnly: true,
    fillSdkPrimaryForSubagent: true,
  });
  expect(resolved?.effectsInput.artifacts).toMatchObject({
    source: "proxy",
    billingRole: "coder",
    requestKey: "proxy:coder:haiku:req_1:100:20:3:4",
    resolvedModelId: "haiku",
    contextUpdate: {
      role: "coder",
      modelId: "haiku",
      providerBaseUrl: "https://api.example.test",
    },
  });
});

test("resolveSingleUsageBillingOrchestration lets explicit updateContext override source default", async () => {
  const resolved = await resolveSingleUsageBillingOrchestration({
    request: request({
      source: "sdk",
      messageId: "msg_1",
      updateContext: false,
    }),
    runtimeRoutes: routes,
    lookupPricing,
  });

  expect(resolved?.effectsInput.updateContext).toBe(false);
  expect(resolved?.effectsInput.messageId).toBe("msg_1");
});

test("resolveSingleUsageBillingOrchestration updates planner context for proxy usage", async () => {
  const resolved = await resolveSingleUsageBillingOrchestration({
    request: request({
      role: "main",
      modelId: "llama-local",
      apiCompat: "anthropic",
    }),
    runtimeRoutes: routes,
    lookupPricing,
  });

  expect(resolved?.effectsInput.updateContext).toBe(true);
});
