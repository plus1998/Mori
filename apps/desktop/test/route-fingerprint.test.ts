import { expect, test } from "bun:test";
import type { RoleRouteConfig, RuntimeRoleRouteConfig } from "../src/shared/ipc";
import { computeRouteFingerprint, routesMatchFingerprint } from "../src/shared/route-fingerprint";

const sampleRoutes: RoleRouteConfig[] = [
  { role: "main", providerId: "p1", modelId: "model-a" },
  { role: "coder", providerId: "p2", modelId: "model-b" },
  { role: "reviewer", providerId: "p1", modelId: "model-c" },
];

test("computeRouteFingerprint is stable for the same routes", () => {
  const first = computeRouteFingerprint(sampleRoutes);
  const second = computeRouteFingerprint([...sampleRoutes].reverse());
  expect(first).toBe(second);
});

test("routesMatchFingerprint detects provider or model changes", () => {
  const fingerprint = computeRouteFingerprint(sampleRoutes);
  expect(routesMatchFingerprint(sampleRoutes, fingerprint)).toBe(true);
  expect(
    routesMatchFingerprint(
      sampleRoutes.map((route) => (route.role === "main" ? { ...route, providerId: "other" } : route)),
      fingerprint,
    ),
  ).toBe(false);
});

test("routesMatchFingerprint detects thinking effort changes", () => {
  const routes = sampleRoutes.map((route) =>
    route.role === "main" ? { ...route, thinkingEffort: "high" as const } : route,
  );
  const fingerprint = computeRouteFingerprint(routes);

  expect(
    routesMatchFingerprint(
      routes.map((route) =>
        route.role === "main" ? { ...route, thinkingEffort: "xhigh" as const } : route,
      ),
      fingerprint,
    ),
  ).toBe(false);
});

test("routesMatchFingerprint includes dynamic runtime roles", () => {
  const routes: RuntimeRoleRouteConfig[] = [
    { role: "main", providerId: "p1", modelId: "main" },
    { role: "researcher", providerId: "p1", modelId: "research-a" },
  ];
  const fingerprint = computeRouteFingerprint(routes);

  expect(routesMatchFingerprint([...routes].reverse(), fingerprint)).toBe(true);
  expect(
    routesMatchFingerprint(
      routes.map((route) => (route.role === "researcher" ? { ...route, modelId: "research-b" } : route)),
      fingerprint,
    ),
  ).toBe(false);
});
