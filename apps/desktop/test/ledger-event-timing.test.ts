import { expect, test } from "bun:test";
import type { ThreadUsageLedgerEventView } from "../src/shared/ipc";
import {
  attachPeerGatewayTimingToLedgerEventViews,
  attachSpanTimingToLedgerEventViews,
  isLedgerEventViewSpanTimingCandidate,
  MIN_TIMING_MS_FOR_RATE,
  resolveLedgerEventTiming,
} from "../src/shared/ledger-event-timing";
import type { ThreadRunProjectionRequestSpan } from "../src/shared/conversation-v2-projection";

const T0 = "2026-01-01T00:00:00.000Z";
const T_FIRST = "2026-01-01T00:00:02.000Z";
const T_END = "2026-01-01T00:00:07.000Z";

function makeView(
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
    observedAt: T0,
    ...overrides,
  };
}

function makeSpan(
  requestId: string,
  overrides: Partial<ThreadRunProjectionRequestSpan> = {},
): ThreadRunProjectionRequestSpan {
  return {
    requestId,
    status: "completed",
    startedAt: T0,
    firstTokenAt: T_FIRST,
    endedAt: T_END,
    ...overrides,
  };
}

test("attachSpanTimingToLedgerEventViews attaches span timing to a sole SDK row match", () => {
  const views = [
    makeView({
      id: "sdk_1",
      source: "sdk",
      outputTokens: 120,
      logicalRequestId: "req_1",
    }),
  ];
  const spans = [makeSpan("req_1")];
  const attached = attachSpanTimingToLedgerEventViews(views, spans);
  expect(attached).toHaveLength(1);
  expect(attached[0]?.spanStartedAt).toBe(T0);
  expect(attached[0]?.spanFirstTokenAt).toBe(T_FIRST);
  expect(attached[0]?.spanEndedAt).toBe(T_END);
});

test("attachSpanTimingToLedgerEventViews matches proxy requestKey segments to span requestId", () => {
  const views = [
    makeView({
      id: "sdk_2",
      source: "sdk",
      requestKey: "proxy:main:haiku:req_2:stamp",
    }),
  ];
  const attached = attachSpanTimingToLedgerEventViews(views, [makeSpan("req_2")]);
  expect(attached[0]?.spanStartedAt).toBe(T0);
});

test("attachSpanTimingToLedgerEventViews leaves rows with gateway timing untouched", () => {
  const views = [
    makeView({
      id: "proxy_1",
      source: "proxy",
      ttftMs: 120,
      generationMs: 5000,
      logicalRequestId: "req_3",
    }),
  ];
  const attached = attachSpanTimingToLedgerEventViews(views, [makeSpan("req_3")]);
  expect(attached[0]).toEqual(views[0]);
  expect(attached[0]?.spanStartedAt).toBeUndefined();
});

test("attachSpanTimingToLedgerEventViews skips a span matched by more than one row", () => {
  const views = [
    makeView({ id: "sdk_a", source: "sdk", logicalRequestId: "req_4" }),
    makeView({ id: "sdk_b", source: "sdk", logicalRequestId: "req_4" }),
  ];
  const attached = attachSpanTimingToLedgerEventViews(views, [makeSpan("req_4")]);
  expect(attached[0]?.spanStartedAt).toBeUndefined();
  expect(attached[1]?.spanStartedAt).toBeUndefined();
});

test("attachSpanTimingToLedgerEventViews skips a row that matches two spans", () => {
  const views = [
    makeView({ id: "sdk_c", source: "sdk", logicalRequestId: "req_5" }),
  ];
  const attached = attachSpanTimingToLedgerEventViews(views, [
    makeSpan("req_5"),
    makeSpan("pre-req_5"),
  ]);
  expect(attached[0]?.spanStartedAt).toBeUndefined();
});

test("attachSpanTimingToLedgerEventViews keeps unmatched rows unchanged", () => {
  const views = [makeView({ id: "sdk_d", source: "sdk", requestKey: "sdk:main:other" })];
  const attached = attachSpanTimingToLedgerEventViews(views, [makeSpan("req_6")]);
  expect(attached[0]).toEqual(views[0]);
});

test("isLedgerEventViewSpanTimingCandidate requires both gateway fields absent", () => {
  expect(isLedgerEventViewSpanTimingCandidate({})).toBe(true);
  expect(isLedgerEventViewSpanTimingCandidate({ ttftMs: 10 })).toBe(false);
  expect(isLedgerEventViewSpanTimingCandidate({ generationMs: 100 })).toBe(false);
});

test("attachPeerGatewayTimingToLedgerEventViews transfers gateway timing across an exact logicalRequestId", () => {
  const views = [
    makeView({ id: "pi_1", source: "pi", logicalRequestId: "req_peer" }),
    makeView({
      id: "proxy_1",
      source: "proxy",
      logicalRequestId: "req_peer",
      ttftMs: 380,
      generationMs: 6699,
    }),
  ];
  const attached = attachPeerGatewayTimingToLedgerEventViews(views);
  expect(attached[0]?.ttftMs).toBe(380);
  expect(attached[0]?.generationMs).toBe(6699);
  expect(attached[1]).toEqual(views[1]);
});

test("attachPeerGatewayTimingToLedgerEventViews leaves rows without a logicalRequestId unchanged", () => {
  const views = [
    makeView({ id: "pi_2", source: "pi", requestKey: "usage:main:10:5" }),
    makeView({ id: "proxy_2", source: "proxy", logicalRequestId: "req_x", ttftMs: 100 }),
  ];
  const attached = attachPeerGatewayTimingToLedgerEventViews(views);
  expect(attached[0]).toEqual(views[0]);
  expect(attached[1]).toEqual(views[1]);
});

test("attachPeerGatewayTimingToLedgerEventViews fails closed on conflicting peer measurements", () => {
  const views = [
    makeView({ id: "pi_3", source: "pi", logicalRequestId: "req_conflict" }),
    makeView({ id: "proxy_a", source: "proxy", logicalRequestId: "req_conflict", ttftMs: 100 }),
    makeView({ id: "proxy_b", source: "proxy", logicalRequestId: "req_conflict", ttftMs: 999 }),
  ];
  const attached = attachPeerGatewayTimingToLedgerEventViews(views);
  expect(attached[0]?.ttftMs).toBeUndefined();
});

test("attachPeerGatewayTimingToLedgerEventViews keeps rows that already carry gateway timing", () => {
  const views = [
    makeView({ id: "proxy_c", source: "proxy", logicalRequestId: "req_own", ttftMs: 50, generationMs: 1000 }),
    makeView({ id: "proxy_d", source: "proxy", logicalRequestId: "req_own", ttftMs: 50, generationMs: 1000 }),
  ];
  const attached = attachPeerGatewayTimingToLedgerEventViews(views);
  expect(attached[0]).toEqual(views[0]);
  expect(attached[1]).toEqual(views[1]);
});

test("peer timing + span timing chain: pi row gets gateway values, span is not consulted for it", () => {
  const views = [
    makeView({ id: "pi_4", source: "pi", logicalRequestId: "req_4", outputTokens: 283 }),
    makeView({ id: "proxy_4", source: "proxy", logicalRequestId: "req_4", ttftMs: 380, generationMs: 6699 }),
  ];
  const spans = [makeSpan("req_4")];
  const attached = attachSpanTimingToLedgerEventViews(
    attachPeerGatewayTimingToLedgerEventViews(views),
    spans,
  );
  const timing = resolveLedgerEventTiming(attached[0]!);
  expect(timing.ttftMs).toBe(380);
  expect(timing.rateTps).toBe((283 * 1000) / 6699);
  expect(attached[0]?.spanStartedAt).toBeUndefined();
});

test("resolveLedgerEventTiming prefers gateway ttft and generationMs", () => {
  const timing = resolveLedgerEventTiming({
    outputTokens: 500,
    ttftMs: 120,
    generationMs: 5000,
    spanStartedAt: T0,
    spanFirstTokenAt: T_FIRST,
    spanEndedAt: T_END,
  });
  expect(timing.ttftMs).toBe(120);
  expect(timing.rateTps).toBe(100);
});

test("resolveLedgerEventTiming falls back to span timing for SDK rows", () => {
  const timing = resolveLedgerEventTiming({
    outputTokens: 500,
    spanStartedAt: T0,
    spanFirstTokenAt: T_FIRST,
    spanEndedAt: T_END,
  });
  expect(timing.ttftMs).toBe(2000);
  expect(timing.rateTps).toBe(100);
});

test("resolveLedgerEventTiming withholds the rate for sub-minimum windows", () => {
  expect(MIN_TIMING_MS_FOR_RATE).toBe(50);
  const shortWindow = resolveLedgerEventTiming({
    outputTokens: 100,
    ttftMs: 80,
    generationMs: 49,
  });
  expect(shortWindow.ttftMs).toBe(80);
  expect(shortWindow.rateTps).toBeUndefined();
  const atMinimum = resolveLedgerEventTiming({
    outputTokens: 100,
    generationMs: MIN_TIMING_MS_FOR_RATE,
  });
  expect(atMinimum.rateTps).toBe(2000);
});

test("resolveLedgerEventTiming withholds the rate while the span is still open", () => {
  const timing = resolveLedgerEventTiming({
    outputTokens: 500,
    spanStartedAt: T0,
    spanFirstTokenAt: T_FIRST,
  });
  expect(timing.ttftMs).toBe(2000);
  expect(timing.rateTps).toBeUndefined();
});

test("resolveLedgerEventTiming returns nothing without any timing source", () => {
  expect(resolveLedgerEventTiming({ outputTokens: 500 })).toEqual({});
  expect(resolveLedgerEventTiming({ outputTokens: 0, ttftMs: 100, generationMs: 1000 })).toEqual({
    ttftMs: 100,
  });
});

test("resolveLedgerEventTiming publishes total throughput and strict decode", () => {
  // ttft 2s, generation 5s, output 100 → total = 100/7s
  const timing = resolveLedgerEventTiming({
    outputTokens: 100,
    inputTokens: 80,
    ttftMs: 2000,
    generationMs: 5000,
    firstHeadersMs: 500,
    firstTokenMs: 2000,
  });
  expect(timing.totalTps).toBeCloseTo((100 * 1000) / 7000, 3);
  // Strict decode: 5000 - (2000 - 2000) = 5000 (first token coincides with ttft)
  expect(timing.decodeTps).toBeCloseTo((100 * 1000) / 5000, 3);
  // Prefill window 500→2000 = 1500ms, reliable
  expect(timing.prefillTps).toBeCloseTo((80 * 1000) / 1500, 3);
});

test("strict decode excludes the pre-token wait when firstTokenMs lags ttft", () => {
  // generation window starts at first chunk (ttft 1000) but the first token
  // arrives at 3000: strict window = 5000 - (3000 - 1000) = 3000
  const timing = resolveLedgerEventTiming({
    outputTokens: 90,
    ttftMs: 1000,
    generationMs: 5000,
    firstTokenMs: 3000,
  });
  expect(timing.rateTps).toBeCloseTo((90 * 1000) / 5000, 3);
  expect(timing.decodeTps).toBeCloseTo((90 * 1000) / 3000, 3);
  expect(timing.totalTps).toBeCloseTo((90 * 1000) / 6000, 3);
});

test("buffering-proxy timing (headers ~= first token) withholds prefill but keeps totals", () => {
  const timing = resolveLedgerEventTiming({
    outputTokens: 81,
    inputTokens: 9850,
    ttftMs: 25512,
    generationMs: 1330,
    firstHeadersMs: 25510,
    firstTokenMs: 25512,
  });
  expect(timing.prefillTps).toBeUndefined();
  expect(timing.totalTps).toBeCloseTo((81 * 1000) / (25512 + 1330), 3);
  expect(timing.decodeTps).toBeCloseTo((81 * 1000) / 1330, 3);
});
