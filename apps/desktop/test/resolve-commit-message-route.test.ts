import { expect, test } from "bun:test";
import type { RoutePricingHint, RuntimeRoleRouteConfig } from "../src/shared/ipc";
import {
  commitRoutePriceScore,
  resolveCommitMessageRoute,
  resolveDefaultCommitMessageRole,
} from "../src/shared/resolve-commit-message-route";

const routes: RuntimeRoleRouteConfig[] = [
  { role: "explore", providerId: "p1", modelId: "haiku" },
  { role: "coder", providerId: "p1", modelId: "sonnet" },
  { role: "main", providerId: "p1", modelId: "opus" },
];

const hints: RoutePricingHint[] = [
  {
    role: "explore",
    modelId: "haiku",
    providerName: "P",
    rates: { inputPerM: 1, outputPerM: 2 },
    pricingResolved: true,
  },
  {
    role: "coder",
    modelId: "sonnet",
    providerName: "P",
    rates: { inputPerM: 3, outputPerM: 15 },
    pricingResolved: true,
  },
];

const enabled = new Set(["explore", "coder"] as const);

test("resolveDefaultCommitMessageRole picks cheapest sub-agent", () => {
  expect(resolveDefaultCommitMessageRole(routes, hints, enabled)).toBe("explore");
});

test("resolveDefaultCommitMessageRole tie-breaks with explore priority", () => {
  const tiedHints: RoutePricingHint[] = [
    { ...hints[0]!, rates: { inputPerM: 1, outputPerM: 1 }, pricingResolved: true },
    {
      role: "coder",
      modelId: "sonnet",
      providerName: "P",
      rates: { inputPerM: 1, outputPerM: 1 },
      pricingResolved: true,
    },
  ];
  expect(resolveDefaultCommitMessageRole(routes, tiedHints, enabled)).toBe("explore");
});

test("resolveCommitMessageRoute honors saved role", () => {
  const route = resolveCommitMessageRoute(routes, hints, enabled, "coder");
  expect(route?.role).toBe("coder");
});

test("resolveCommitMessageRoute falls back when saved role missing", () => {
  const route = resolveCommitMessageRoute(routes, hints, enabled, "tester");
  expect(route?.role).toBe("explore");
});

test("commitRoutePriceScore returns infinity without rates", () => {
  expect(commitRoutePriceScore(undefined)).toBe(Number.POSITIVE_INFINITY);
});
