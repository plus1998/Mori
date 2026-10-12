import { expect, test } from "bun:test";
import { createModelAlias } from "../src/main/anthropic-proxy";
import type { ModelsDevPricingCache } from "../src/main/models-dev-pricing-cache";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import {
  buildDriverRoutes,
  buildDriverRoutesFromRuntime,
  resolveContextTokensByRole,
  resolveThreadRuntimeConfig,
  roleRoutesFromRuntime,
} from "../src/main/thread-runtime-routes";
import type { AgentRole, RoleRouteConfig } from "../src/shared/ipc";

function provider(id: string, enabled = true): ProviderConfigSecret {
  return {
    id,
    name: `Provider ${id}`,
    baseUrl: `https://${id}.example.test`,
    requestPath: "/v1/messages",
    version: "v1",
    apiCompat: "anthropic",
    defaultModel: "claude-test",
    enabled,
    hasApiKey: true,
    apiKeyPreview: "sk-...",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    apiKey: "secret",
  };
}

function routes(providerId = "p1"): RoleRouteConfig[] {
  const roles: AgentRole[] = ["planner", "explore", "architect", "coder", "reviewer", "tester"];
  return roles.map((role) => ({
    role,
    providerId,
    modelId: `${role}-model`,
    apiCompat: "anthropic",
    ...(role === "planner" ? { thinkingEffort: "high" as const } : {}),
  }));
}

test("resolveThreadRuntimeConfig validates full role routes and keeps route metadata", () => {
  const resolved = resolveThreadRuntimeConfig(
    {
      providers: [],
      routeProfiles: [],
      agentTemplates: [],
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    },
    [provider("p1")],
    routes(),
  );

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.routes).toHaveLength(6);
  expect(resolved.routes[0]).toMatchObject({
    role: "planner",
    modelId: "planner-model",
    apiCompat: "anthropic",
    thinkingEffort: "high",
  });
  expect(roleRoutesFromRuntime(resolved.routes)[0]).toMatchObject({
    role: "planner",
    providerId: "p1",
    modelId: "planner-model",
    thinkingEffort: "high",
  });
});

test("resolveThreadRuntimeConfig reports missing providers and disabled providers", () => {
  expect(
    resolveThreadRuntimeConfig(
      {
        providers: [],
        routeProfiles: [],
        agentTemplates: [],
        mainAgentConfigs: [],
        mainAgentPrompts: [],
        subagentOrchestrations: [],
      },
      [],
      routes(),
    ).ok,
  ).toBe(false);
  expect(
    resolveThreadRuntimeConfig(
      {
        providers: [],
        routeProfiles: [],
        agentTemplates: [],
        mainAgentConfigs: [],
        mainAgentPrompts: [],
        subagentOrchestrations: [],
      },
      [provider("p1", false)],
      routes(),
    ),
  ).toEqual({
    ok: false,
    reason: 'Provider "Provider p1" for planner is disabled.',
  });
});

test("resolveThreadRuntimeConfig accepts partial routes for generic orchestrations", () => {
  const resolved = resolveThreadRuntimeConfig(
    {
      providers: [],
      routeProfiles: [],
      agentTemplates: [],
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    },
    [provider("p1")],
    [{ role: "planner", providerId: "p1", modelId: "research-model" }],
    { requireCompleteCodingRoutes: false },
  );

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.routes).toHaveLength(1);
  expect(resolved.routes[0]?.role).toBe("planner");

  expect(
    resolveThreadRuntimeConfig(
      {
        providers: [],
        routeProfiles: [],
        agentTemplates: [],
        mainAgentConfigs: [],
        mainAgentPrompts: [],
        subagentOrchestrations: [],
      },
      [provider("p1")],
      [],
      { requireCompleteCodingRoutes: false },
    ),
  ).toEqual({
    ok: false,
    reason: "At least one model route is required for this orchestration.",
  });
});

test("resolveThreadRuntimeConfig preserves dynamic runtime roles for generic orchestrations", () => {
  const resolved = resolveThreadRuntimeConfig(
    {
      providers: [],
      routeProfiles: [],
      agentTemplates: [],
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    },
    [provider("p1")],
    [
      { role: "planner", providerId: "p1", modelId: "main-model" },
      { role: "researcher", providerId: "p1", modelId: "research-model" },
    ],
    { requireCompleteCodingRoutes: false },
  );

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.routes.map((route) => route.role)).toEqual(["planner", "researcher"]);
  expect(roleRoutesFromRuntime(resolved.routes).map((route) => route.role)).toEqual([
    "planner",
    "researcher",
  ]);
  expect(buildDriverRoutesFromRuntime(resolved.routes)[1]).toMatchObject({
    role: "researcher",
    upstreamModelId: "research-model",
    primary: {
      modelId: createModelAlias("researcher", "p1", "research-model"),
    },
  });
});

test("resolveThreadRuntimeConfig still requires full coding routes by default", () => {
  expect(
    resolveThreadRuntimeConfig(
      {
        providers: [],
        routeProfiles: [],
        agentTemplates: [],
        mainAgentConfigs: [],
        mainAgentPrompts: [],
        subagentOrchestrations: [],
      },
      [provider("p1")],
      [{ role: "planner", providerId: "p1", modelId: "planner-model" }],
    ),
  ).toEqual({
    ok: false,
    reason: "Configure a explore route before starting a coding thread.",
  });
});

test("buildDriverRoutes and buildDriverRoutesFromRuntime both expose eco aliases to the SDK", () => {
  const resolved = resolveThreadRuntimeConfig(
    {
      providers: [],
      routeProfiles: [],
      agentTemplates: [],
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    },
    [provider("p1")],
    routes(),
  );
  if (!resolved.ok) {
    throw new Error("expected runtime config");
  }
  const runtimeRoute = resolved.routes[0]!;
  const expectedAlias = createModelAlias(runtimeRoute.role, runtimeRoute.provider.id, runtimeRoute.modelId);
  const proxyRoutes = resolved.routes.map((route) => ({
    ...route,
    aliasModelId: createModelAlias(route.role, route.provider.id, route.modelId),
  }));

  expect(buildDriverRoutes(proxyRoutes)[0]?.primary.modelId).toBe(expectedAlias);
  expect(buildDriverRoutesFromRuntime(resolved.routes)[0]?.primary.modelId).toBe(expectedAlias);
  expect(buildDriverRoutesFromRuntime(resolved.routes, { planner: 1_000_000 })[0]?.primary.modelId).toBe(
    `${expectedAlias}[1m]`,
  );
  expect(buildDriverRoutesFromRuntime(resolved.routes)[0]?.upstreamModelId).toBe("planner-model");
});

test("buildDriverRoutes copies contextTokens onto primary.contextWindow", () => {
  const resolved = resolveThreadRuntimeConfig(
    {
      providers: [],
      routeProfiles: [],
      agentTemplates: [],
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    },
    [provider("p1")],
    routes(),
  );
  if (!resolved.ok) {
    throw new Error("expected runtime config");
  }
  const proxyRoutes = resolved.routes.map((route) => ({
    ...route,
    aliasModelId: createModelAlias(route.role, route.provider.id, route.modelId),
    contextTokens: route.role === "planner" ? 262_144 : 128_000,
    maxOutputTokens: route.role === "planner" ? 128_000 : 64_000,
  }));
  const driverRoutes = buildDriverRoutes(proxyRoutes);
  expect(driverRoutes[0]?.primary.contextWindow).toBe(262_144);
  expect(driverRoutes[0]?.maxOutputTokens).toBe(128_000);
  expect(driverRoutes.find((route) => route.role === "coder")?.maxOutputTokens).toBe(64_000);
  expect(driverRoutes.find((route) => route.role === "coder")?.primary.contextWindow).toBe(128_000);
});

test("resolveContextTokensByRole caps catalog windows to the global limit", async () => {
  const cache = {
    resolveContextLimit: async () => ({ limit: 1_000_000, limitsResolved: true }),
  } as ModelsDevPricingCache;
  const resolved = resolveThreadRuntimeConfig(
    {
      providers: [],
      routeProfiles: [],
      agentTemplates: [],
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    },
    [provider("p1")],
    routes(),
  );
  if (!resolved.ok) {
    throw new Error("expected runtime config");
  }
  const byRole = await resolveContextTokensByRole(resolved.routes, cache, 262_144);
  expect(byRole.planner).toBe(262_144);
  expect(byRole.coder).toBe(262_144);
});

test("resolveContextTokensByRole keeps a model window smaller than the global cap", async () => {
  const cache = {
    resolveContextLimit: async () => ({ limit: 128_000, limitsResolved: true }),
  } as ModelsDevPricingCache;
  const resolved = resolveThreadRuntimeConfig(
    {
      providers: [],
      routeProfiles: [],
      agentTemplates: [],
      mainAgentConfigs: [],
      mainAgentPrompts: [],
      subagentOrchestrations: [],
    },
    [provider("p1")],
    routes(),
  );
  if (!resolved.ok) {
    throw new Error("expected runtime config");
  }
  const byRole = await resolveContextTokensByRole(resolved.routes, cache, 262_144);
  expect(byRole.planner).toBe(128_000);
});
