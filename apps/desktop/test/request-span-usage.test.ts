import { expect, test } from "bun:test";
import {
  attachOutputTokensToRequestSpans,
  dedupeUsageLedgerRowsForSpanJoin,
} from "../src/shared/request-span-usage";

test("attachOutputTokensToRequestSpans collapses partial+final rows per invocation", () => {
  const spans = [{ requestId: "r1", status: "completed" as const, startedAt: "2025-01-01T00:00:00.000Z" }];
  const attached = attachOutputTokensToRequestSpans(spans, [
    { outputTokens: 40, reasoningTokens: 10, requestKey: "r1" },
    { outputTokens: 50, reasoningTokens: 5, requestKey: "r1" },
  ]);
  expect(attached[0]).toMatchObject({ outputTokens: 50, reasoningTokens: 10 });
});

test("native Codex request keys attach rollout timing to the turn span", () => {
  const spans = [
    { requestId: "turn_native", status: "completed" as const, startedAt: "2025-01-01T00:00:00.000Z" },
  ];
  const attached = attachOutputTokensToRequestSpans(spans, [
    {
      outputTokens: 308,
      requestKey: "codex-turn-usage:native:turn_native:usage:checkpoint",
      ttftMs: 17_879,
      generationMs: 5_304,
      source: "codex",
    },
  ]);
  expect(attached[0]).toMatchObject({
    outputTokens: 308,
    ttftMs: 17_879,
    generationMs: 5_304,
  });
});

test("attachOutputTokensToRequestSpans sums distinct provider invocations in a turn", () => {
  const spans = [
    {
      requestId: "logical-1",
      status: "completed" as const,
      startedAt: "2025-01-01T00:00:00.000Z",
    },
  ];
  const attached = attachOutputTokensToRequestSpans(spans, [
    {
      outputTokens: 100,
      reasoningTokens: 40,
      providerRequestId: "prov-a",
      logicalRequestId: "logical-1",
      ttftMs: 2_000,
      generationMs: 1_000,
      source: "codex",
    },
    {
      outputTokens: 80,
      reasoningTokens: 30,
      providerRequestId: "prov-b",
      logicalRequestId: "logical-1",
      ttftMs: 3_000,
      generationMs: 3_000,
      source: "codex",
    },
    {
      outputTokens: 50,
      reasoningTokens: 10,
      providerRequestId: "prov-a",
      logicalRequestId: "logical-1",
      ttftMs: 2_100,
      generationMs: 1_100,
      source: "codex",
    },
  ]);
  expect(attached[0]).toMatchObject({
    outputTokens: 180,
    reasoningTokens: 70,
    ttftMs: 5_100,
    generationMs: 4_100,
  });
});

test("dedupeUsageLedgerRowsForSpanJoin drops pi rows when proxy already billed the logical request", () => {
  const deduped = dedupeUsageLedgerRowsForSpanJoin([
    {
      outputTokens: 120,
      logicalRequestId: "req_a",
      ttftMs: 2_000,
      generationMs: 2_000,
      source: "proxy",
      providerRequestId: "msg_a",
    },
    {
      outputTokens: 120,
      logicalRequestId: "req_a",
      source: "pi",
    },
  ]);
  expect(deduped).toHaveLength(1);
  expect(deduped[0]?.source).toBe("proxy");
});

test("attachOutputTokensToRequestSpans avoids double-counting pi and proxy for one PI invocation", () => {
  const spans = [
    {
      requestId: "req_a",
      status: "completed" as const,
      startedAt: "2025-01-01T00:00:00.000Z",
    },
  ];
  const attached = attachOutputTokensToRequestSpans(spans, [
    {
      outputTokens: 500,
      reasoningTokens: 0,
      logicalRequestId: "req_a",
      ttftMs: 4_000,
      generationMs: 4_000,
      source: "proxy",
      providerRequestId: "msg_a",
    },
    {
      outputTokens: 500,
      logicalRequestId: "req_a",
      source: "pi",
    },
  ]);
  expect(attached[0]).toMatchObject({
    outputTokens: 500,
    ttftMs: 4_000,
    generationMs: 4_000,
  });
});
