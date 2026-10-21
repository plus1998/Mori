import { expect, test } from "bun:test";
import { createModelAlias } from "../src/main/anthropic-proxy";
import {
  manualSpecToRates,
  resolvePublicModelId,
  resolveRatesForRoute,
  resolveRuntimeRoutesFromSettings,
  resolveUsageRoute,
} from "../src/main/billing-resolver";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import type { ModelSettingsSnapshot } from "../src/shared/ipc";

test("resolvePublicModelId maps SDK alias to upstream model id", () => {
  const provider = createProvider();
  const routes = [
    { role: "main" as const, provider, modelId: "claude-opus-4-7" },
    { role: "coder" as const, provider, modelId: "claude-haiku-4-5" },
  ];
  const alias = createModelAlias("main", provider.id, "claude-opus-4-7");
  expect(resolvePublicModelId("main", alias, routes)).toBe("claude-opus-4-7");
  expect(resolvePublicModelId("main", undefined, routes)).toBe("claude-opus-4-7");
});

test("resolveUsageRoute maps eco alias to route", () => {
  const provider = createProvider();
  const routes = [
    { role: "main" as const, provider, modelId: "sonnet" },
    { role: "coder" as const, provider, modelId: "haiku" },
  ];
  const alias = createModelAlias("coder", provider.id, "haiku");
  const resolved = resolveUsageRoute("main", alias, routes);
  expect(resolved?.role).toBe("coder");
  expect(resolved?.modelId).toBe("haiku");
});

test("resolveUsageRoute prefers role route when SDK reports planner model id for eco role", () => {
  const provider = createProvider();
  const routes = [
    { role: "main" as const, provider, modelId: "claude-opus-4-7" },
    { role: "coder" as const, provider, modelId: "claude-haiku-4-5" },
  ];
  const resolved = resolveUsageRoute("coder", "claude-opus-4-7", routes);
  expect(resolved?.role).toBe("coder");
  expect(resolved?.modelId).toBe("claude-haiku-4-5");
});

test("resolveUsageRoute unique model id still resolves correctly", () => {
  const provider = createProvider();
  const routes = [
    { role: "main" as const, provider, modelId: "claude-opus-4-7" },
    { role: "coder" as const, provider, modelId: "claude-haiku-4-5" },
  ];
  const resolved = resolveUsageRoute("coder", "claude-haiku-4-5", routes);
  expect(resolved?.role).toBe("coder");
  expect(resolved?.modelId).toBe("claude-haiku-4-5");
});

test("resolveUsageRoute maps unique explore model when SDK result role is planner", () => {
  const provider = createProvider();
  const routes = [
    { role: "main" as const, provider, modelId: "claude-opus-4-7" },
    { role: "explore" as const, provider, modelId: "claude-haiku-4-5" },
  ];
  const resolved = resolveUsageRoute("main", "claude-haiku-4-5", routes);
  expect(resolved?.role).toBe("explore");
  expect(resolved?.modelId).toBe("claude-haiku-4-5");
});

test("resolveUsageRoute maps explore eco alias when SDK result role is planner", () => {
  const provider = createProvider();
  const routes = [
    { role: "main" as const, provider, modelId: "claude-opus-4-7" },
    { role: "explore" as const, provider, modelId: "claude-haiku-4-5" },
  ];
  const alias = createModelAlias("explore", provider.id, "claude-haiku-4-5");
  const resolved = resolveUsageRoute("main", alias, routes);
  expect(resolved?.role).toBe("explore");
  expect(resolved?.modelId).toBe("claude-haiku-4-5");
});

test("resolveUsageRoute preserves models.dev mapping for billing", () => {
  const provider = createProvider();
  const routes = [
    { role: "main" as const, provider, modelId: "vendor-model" },
    {
      role: "coder" as const,
      provider,
      modelId: "custom-alias",
      modelsDevMapping: { providerKey: "anthropic", modelId: "claude-haiku-4-5" },
    },
  ];
  const alias = createModelAlias("coder", provider.id, "custom-alias");
  const resolved = resolveUsageRoute("main", alias, routes);
  expect(resolved?.role).toBe("coder");
  expect(resolved?.modelsDevMapping).toEqual({
    providerKey: "anthropic",
    modelId: "claude-haiku-4-5",
  });
});

test("manualSpecToRates returns rates when input and output are set", () => {
  expect(
    manualSpecToRates({
      inputPerM: 3,
      outputPerM: 15,
      cacheReadPerM: 0.3,
    }),
  ).toEqual({
    input: 3,
    output: 15,
    cacheRead: 0.3,
  });
});

test("manualSpecToRates preserves zero prices as free", () => {
  expect(
    manualSpecToRates({
      inputPerM: 0,
      outputPerM: 0,
      cacheReadPerM: 0,
      cacheWritePerM: 0,
    }),
  ).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("resolveRatesForRoute prefers manual spec when input and output are set", () => {
  const lookup = {
    providerKey: "anthropic",
    modelId: "claude-sonnet-4",
    rates: { input: 1, output: 2, cacheRead: 0.1 },
  };
  expect(resolveRatesForRoute(lookup, { inputPerM: 9, outputPerM: 9 })).toEqual({
    input: 9,
    output: 9,
    cacheRead: 0.1,
  });
});

test("resolveRatesForRoute applies price multiplier to catalog rates", () => {
  const lookup = {
    providerKey: "anthropic",
    modelId: "claude-sonnet-4",
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  const result = resolveRatesForRoute(lookup, { priceMultiplier: 1.2 });
  expect(result?.input).toBeCloseTo(3.6);
  expect(result?.output).toBeCloseTo(18);
  expect(result?.cacheRead).toBeCloseTo(0.36);
  expect(result?.cacheWrite).toBeCloseTo(4.5);
});

test("resolveRatesForRoute treats price multiplier zero as free", () => {
  const lookup = {
    providerKey: "anthropic",
    modelId: "claude-sonnet-4",
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  expect(resolveRatesForRoute(lookup, { priceMultiplier: 0 })).toEqual({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("resolveRatesForRoute applies multiplier after manual absolute prices", () => {
  const lookup = {
    providerKey: "anthropic",
    modelId: "claude-sonnet-4",
    rates: { input: 1, output: 2, cacheRead: 0.1 },
  };
  expect(
    resolveRatesForRoute(lookup, {
      inputPerM: 5,
      outputPerM: 10,
      priceMultiplier: 2,
    }),
  ).toEqual({
    input: 10,
    output: 20,
    cacheRead: 0.2,
  });
});

test("resolveRatesForRoute uses manual cache fields when set", () => {
  const lookup = {
    providerKey: "anthropic",
    modelId: "claude-sonnet-4",
    rates: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 },
  };
  expect(
    resolveRatesForRoute(lookup, {
      inputPerM: 9,
      outputPerM: 9,
      cacheWritePerM: 4,
    }),
  ).toEqual({
    input: 9,
    output: 9,
    cacheRead: 0.1,
    cacheWrite: 4,
  });
});

test("resolveRatesForRoute falls back to manual spec", () => {
  expect(resolveRatesForRoute(null, { inputPerM: 4, outputPerM: 8 })).toEqual({
    input: 4,
    output: 8,
  });
});

test("resolveRuntimeRoutesFromSettings returns empty routes without override", () => {
  const provider = createProvider();
  const settings: ModelSettingsSnapshot = {
    providers: [
      {
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        requestPath: provider.requestPath,
        version: "v1",
        apiCompat: provider.apiCompat,
        defaultModel: provider.defaultModel,
        enabled: provider.enabled,
        hasApiKey: provider.hasApiKey,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      },
    ],
    routeProfiles: [],
    agentTemplates: [],
    mainAgentConfigs: [],
    mainAgentPrompts: [],
    subagentOrchestrations: [],
  };
  expect(resolveRuntimeRoutesFromSettings(settings, [provider])).toEqual([]);
});

test("resolveRuntimeRoutesFromSettings preserves manualSpec and modelsDevMapping", () => {
  const provider = createProvider();
  const settings: ModelSettingsSnapshot = {
    providers: [],
    routeProfiles: [],
    agentTemplates: [],
    mainAgentConfigs: [],
    mainAgentPrompts: [],
    subagentOrchestrations: [],
  };
  const routes = resolveRuntimeRoutesFromSettings(
    settings,
    [provider],
    [
      {
        role: "main",
        providerId: provider.id,
        modelId: "vendor-model",
        modelsDevMapping: { providerKey: "anthropic", modelId: "claude-sonnet-4" },
        manualSpec: { inputPerM: 3, outputPerM: 15, contextTokens: 200_000 },
      },
    ],
  );
  expect(routes).toHaveLength(1);
  expect(routes[0]?.modelsDevMapping).toEqual({
    providerKey: "anthropic",
    modelId: "claude-sonnet-4",
  });
  expect(routes[0]?.manualSpec).toEqual({
    inputPerM: 3,
    outputPerM: 15,
    contextTokens: 200_000,
  });
});

function createProvider(): ProviderConfigSecret {
  return {
    id: "anthropic-compatible",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    requestPath: "",
    version: "v1",
    apiCompat: "anthropic",
    defaultModel: "sonnet",
    enabled: true,
    hasApiKey: true,
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
    apiKey: "secret",
  };
}
