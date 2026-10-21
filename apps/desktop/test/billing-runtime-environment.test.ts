import { expect, test } from "bun:test";
import type { ModelPricingLookup } from "@eco/runtime";
import type { RuntimeRoute } from "../src/main/billing-resolver";
import {
  createBillingRuntimeEnvironment,
  resolveBillingRuntimeContext,
} from "../src/main/billing-runtime-environment";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import type { UsageBillingPricingRoute } from "../src/main/usage-billing-artifacts";

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

const runtimeRoutes: RuntimeRoute[] = [
  {
    role: "main",
    provider,
    modelId: "sonnet",
    apiCompat: "anthropic",
  },
];

async function lookupPricing(route: UsageBillingPricingRoute): Promise<ModelPricingLookup> {
  return {
    providerKey: "test",
    modelId: route.modelId,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    displayName: route.modelId,
  };
}

test("resolveBillingRuntimeContext waits for pricing before resolving routes", async () => {
  const calls: string[] = [];
  let ready = false;
  const environment = createBillingRuntimeEnvironment({
    waitUntilReady: async () => {
      calls.push("ready");
      ready = true;
    },
    resolveRuntimeRoutes: (threadId) => {
      calls.push(`routes:${threadId}`);
      expect(ready).toBe(true);
      return runtimeRoutes;
    },
    lookupPricing,
  });

  const context = await resolveBillingRuntimeContext(environment, "thr_runtime");

  expect(calls).toEqual(["ready", "routes:thr_runtime"]);
  expect(context.runtimeRoutes).toBe(runtimeRoutes);
  expect(context.lookupPricing).toBe(lookupPricing);
});

test("resolveBillingRuntimeContext does not resolve routes when pricing readiness fails", async () => {
  let routeResolved = false;
  const environment = createBillingRuntimeEnvironment({
    waitUntilReady: async () => {
      throw new Error("pricing unavailable");
    },
    resolveRuntimeRoutes: () => {
      routeResolved = true;
      return runtimeRoutes;
    },
    lookupPricing,
  });

  await expect(resolveBillingRuntimeContext(environment, "thr_runtime")).rejects.toThrow(
    "pricing unavailable",
  );
  expect(routeResolved).toBe(false);
});
