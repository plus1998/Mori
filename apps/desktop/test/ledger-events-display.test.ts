import { expect, test } from "bun:test";
import type { ThreadUsageLedgerEventView } from "../src/shared/ipc";
import {
  partitionLedgerEventsForDisplay,
  resolveLedgerEventBillingRole,
  sumLedgerEventTokens,
} from "../src/shared/ledger-events-display";

function makeEvent(
  overrides: Partial<ThreadUsageLedgerEventView> & Pick<ThreadUsageLedgerEventView, "id" | "source">,
): ThreadUsageLedgerEventView {
  return {
    role: "main",
    routeRole: "main",
    billingRole: "main",
    attributionStatus: "attributed",
    usageKind: "request_final",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    observedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("partitionLedgerEventsForDisplay splits primary proxy from shadow sources", () => {
  const events = [
    makeEvent({ id: "p1", source: "proxy", inputTokens: 5000 }),
    makeEvent({ id: "s1", source: "sdk", inputTokens: 5000 }),
    makeEvent({ id: "s2", source: "sdk", inputTokens: 2000 }),
    makeEvent({ id: "p2", source: "proxy", inputTokens: 3000 }),
  ];
  const { primaryEvents, shadowEvents } = partitionLedgerEventsForDisplay(events, "proxy");
  expect(primaryEvents.map((event) => event.id)).toEqual(["p1", "p2"]);
  expect(shadowEvents.map((event) => event.id)).toEqual(["s1", "s2"]);
  expect(sumLedgerEventTokens(primaryEvents).total).toBe(8200);
});

test("partitionLedgerEventsForDisplay collapses duplicate same-source requestKey rows", () => {
  const events = [
    makeEvent({ id: "pi_1", source: "pi", requestKey: "usage:main:3177:281:0:0:eco-planner-abc" }),
    makeEvent({ id: "pi_2", source: "pi", requestKey: "usage:main:3177:281:0:0:eco-planner-abc" }),
    makeEvent({ id: "proxy_1", source: "proxy", requestKey: "proxy:main:qwen:resp_1:3177:281:0:0" }),
  ];
  const { primaryEvents, shadowEvents } = partitionLedgerEventsForDisplay(events, "pi");
  expect(primaryEvents.map((event) => event.id)).toEqual(["pi_1"]);
  expect(shadowEvents.map((event) => event.id)).toEqual(["proxy_1"]);
});

test("partitionLedgerEventsForDisplay keeps observations that differ in source or role", () => {
  const events = [
    makeEvent({ id: "pi_1", source: "pi" }),
    makeEvent({ id: "sdk_1", source: "sdk" }),
    makeEvent({ id: "pi_coder", source: "pi", role: "coder", routeRole: "coder", billingRole: "coder" }),
  ];
  const { primaryEvents, shadowEvents } = partitionLedgerEventsForDisplay(events, "pi");
  expect(primaryEvents.map((event) => event.id)).toEqual(["pi_1", "pi_coder"]);
  expect(shadowEvents.map((event) => event.id)).toEqual(["sdk_1"]);
});

test("resolveLedgerEventBillingRole prefers billingRole over routeRole", () => {
  expect(
    resolveLedgerEventBillingRole(
      makeEvent({
        id: "e1",
        source: "proxy",
        role: "coder",
        routeRole: "explore",
        billingRole: "coder",
      }),
    ),
  ).toBe("coder");
});
