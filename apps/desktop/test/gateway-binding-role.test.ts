import { expect, test } from "bun:test";
import type { ClaudeBridgeBindingRoute } from "../src/main/claude-bridge-binding";
import { resolveBindingRoleForRoutes } from "../src/main/gateway-request-lifecycle";
import type { ProviderConfigSecret } from "../src/main/provider-store";

function providerSecret(id: string): ProviderConfigSecret {
  return {
    id,
    name: id,
    baseUrl: "http://mock",
    requestPath: "",
    version: "v1",
    defaultModel: "shared-model",
    enabled: true,
    hasApiKey: true,
    apiKey: "sk",
    createdAt: "",
    updatedAt: "",
  };
}

function route(role: "coder" | "main", alias: string): ClaudeBridgeBindingRoute {
  return {
    role,
    provider: providerSecret("pa"),
    modelId: "shared-model",
    aliasModelId: alias,
    apiCompat: "anthropic",
  };
}

test("resolveBindingRoleForRoutes selects route by exact requested alias", () => {
  const routes = [route("coder", "alias-coder"), route("main", "alias-planner")];
  expect(
    resolveBindingRoleForRoutes(routes, {
      providerId: "pa",
      requestedModel: "alias-planner",
      upstreamModelId: "shared-model",
    }),
  ).toBe("main");
  expect(
    resolveBindingRoleForRoutes(routes, {
      providerId: "pa",
      requestedModel: "alias-coder",
      upstreamModelId: "shared-model",
    }),
  ).toBe("coder");
});

test("resolveBindingRoleForRoutes fail closed when concrete model matches multiple routes", () => {
  const routes = [route("coder", "alias-coder"), route("main", "alias-planner")];
  expect(
    resolveBindingRoleForRoutes(routes, {
      providerId: "pa",
      requestedModel: "wrong-alias",
      upstreamModelId: "shared-model",
    }),
  ).toBeUndefined();
  expect(
    resolveBindingRoleForRoutes(routes, {
      providerId: "pa",
      requestedModel: "",
      upstreamModelId: "shared-model",
    }),
  ).toBeUndefined();
});

test("resolveBindingRoleForRoutes fail closed when alias match is ambiguous", () => {
  const routes = [route("coder", "alias-dup"), route("main", "alias-dup")];
  expect(
    resolveBindingRoleForRoutes(routes, {
      providerId: "pa",
      requestedModel: "alias-dup",
      upstreamModelId: "shared-model",
    }),
  ).toBeUndefined();
});
