import { expect, test } from "bun:test";
import type { ModelPricingLookup, ParsedUsage } from "@eco/runtime";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import {
  resolveSdkStreamPartialBillingOrchestration,
  type SdkStreamPartialBillingRequest,
} from "../src/main/sdk-stream-partial-billing-orchestration";
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

function usage(inputTokens = 100): ParsedUsage {
  return {
    inputTokens,
    outputTokens: 20,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
  };
}

function request(input: Partial<SdkStreamPartialBillingRequest> = {}): SdkStreamPartialBillingRequest {
  return {
    threadId: "thr_stream",
    eventId: "evt_stream_1",
    role: "coder",
    usage: usage(),
    modelId: "haiku",
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    subagentAgentId: "agent_coder_1",
    parentToolUseId: "toolu_parent",
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

test("resolveSdkStreamPartialBillingOrchestration builds subagent effects input", async () => {
  const resolved = await resolveSdkStreamPartialBillingOrchestration({
    request: request(),
    runtimeRoutes: routes,
    lookupPricing,
  });

  expect(resolved.effectsInput).toMatchObject({
    threadId: "thr_stream",
    usage: usage(),
    subagentAgentId: "agent_coder_1",
    artifacts: {
      resolvedModelId: "haiku",
      contextUpdate: {
        role: "coder",
        modelId: "haiku",
        providerBaseUrl: "https://api.example.test",
      },
    },
  });
  expect(resolved.effectsInput.artifacts.ledgerEvent).toMatchObject({
    source: "sdk",
    usageKind: "request_partial",
    requestKey: "sdk-stream:evt_stream_1",
    agentId: "agent_coder_1",
    parentToolUseId: "toolu_parent",
    runAttemptId: "attempt_1",
  });
});

test("resolveSdkStreamPartialBillingOrchestration keeps audit-only partial without route", async () => {
  const {
    subagentAgentId: _subagentAgentId,
    parentToolUseId: _parentToolUseId,
    ...auditRequest
  } = request({
    role: "reviewer",
    modelId: "unknown-model",
  });
  const resolved = await resolveSdkStreamPartialBillingOrchestration({
    request: auditRequest,
    runtimeRoutes: [],
    lookupPricing,
  });

  expect(resolved.effectsInput.subagentAgentId).toBeUndefined();
  expect(resolved.effectsInput.artifacts.contextUpdate).toBeUndefined();
  expect(resolved.effectsInput.artifacts.ledgerEvent).toMatchObject({
    source: "sdk",
    usageKind: "request_partial",
    role: "reviewer",
    modelId: "unknown-model",
  });
});
