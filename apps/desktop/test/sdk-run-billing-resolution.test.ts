import { expect, test } from "bun:test";
import type { ModelPricingLookup, ParsedUsage } from "@eco/runtime";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import type { SdkUsageBillingBundle } from "../src/main/sdk-event-usage-billing";
import type { SdkRunBillingAttributionResolver } from "../src/main/sdk-run-billing-attribution";
import { resolveSdkRunBillingResolution } from "../src/main/sdk-run-billing-resolution";
import type { UsageBillingPricingRoute } from "../src/main/usage-billing-artifacts";
import type { AgentRole } from "../src/shared/ipc";

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

function bundle(input: Partial<SdkUsageBillingBundle> = {}): SdkUsageBillingBundle {
  return {
    models: [{ modelId: "haiku", usage: usage() }],
    contextUsage: usage(900),
    totalCostUsd: 0.05,
    authoritative: true,
    ...input,
  };
}

function resolver(
  input: { agentByRole?: Partial<Record<AgentRole, string>>; roleByAgent?: Record<string, AgentRole> } = {},
): SdkRunBillingAttributionResolver {
  return {
    resolveAgentId(_threadId, request) {
      if (request.subagentAgentId) {
        return request.subagentAgentId;
      }
      return input.agentByRole?.[request.role];
    },
    roleForAgentId(_threadId, agentId) {
      return input.roleByAgent?.[agentId];
    },
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

test("resolveSdkRunBillingResolution builds subagent observations and effects input", async () => {
  const resolved = await resolveSdkRunBillingResolution({
    threadId: "thr_sdk_run",
    role: "coder",
    requestKey: "sdk-result:evt_1",
    bundle: bundle(),
    runtimeRoutes: routes,
    lookupPricing,
    resolver: resolver({
      agentByRole: { coder: "agent_coder_1" },
      roleByAgent: { agent_coder_1: "coder" },
    }),
    usagePayload: {
      modelUsage: {
        haiku: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        },
      },
    },
    runAttemptId: "attempt_1",
    plannerAgentId: "planner_attempt_1",
    parentToolUseId: "toolu_parent",
  });

  expect(resolved.billingRole).toBe("coder");
  expect(resolved.resolvedSubagentId).toBe("agent_coder_1");
  expect(resolved.ledgerAgentId).toBe("agent_coder_1");
  expect(resolved.contextUsage).toEqual(usage());
  expect(resolved.observations).toEqual([
    {
      source: "sdk",
      role: "coder",
      agentId: "agent_coder_1",
      usage: usage(),
      requestKey: "sdk-result:evt_1",
      modelId: "haiku",
    },
  ]);
  expect(resolved.effectsInput).toMatchObject({
    threadId: "thr_sdk_run",
    role: "coder",
    requestKey: "sdk-result:evt_1",
    billingRole: "coder",
    contextUsage: usage(),
    updateContext: false,
    totalCostUsd: 0.05,
    plannerModelLabel: "Claude Sonnet · Test Provider",
    runAttemptId: "attempt_1",
    parentToolUseId: "toolu_parent",
    ledgerAgentId: "agent_coder_1",
    resolvedSubagentId: "agent_coder_1",
  });
  expect(resolved.effectsInput.contextUpdate).toBeUndefined();
});

test("resolveSdkRunBillingResolution attributes planner-only rows to planner agent", async () => {
  const plannerBundle = bundle({
    models: [{ modelId: "sonnet", usage: usage(200) }],
    contextUsage: usage(200),
  });

  const resolved = await resolveSdkRunBillingResolution({
    threadId: "thr_sdk_run",
    role: "main",
    requestKey: "sdk-result:evt_planner",
    bundle: plannerBundle,
    runtimeRoutes: routes,
    lookupPricing,
    resolver: resolver(),
    plannerAgentId: "planner_attempt_1",
  });

  expect(resolved.billingRole).toBe("main");
  expect(resolved.resolvedSubagentId).toBeUndefined();
  expect(resolved.ledgerAgentId).toBe("planner_attempt_1");
  expect(resolved.observations).toEqual([]);
  expect(resolved.effectsInput).toMatchObject({
    role: "main",
    billingRole: "main",
    ledgerAgentId: "planner_attempt_1",
    updateContext: false,
  });
  expect(resolved.effectsInput.contextUpdate).toBeUndefined();
});
