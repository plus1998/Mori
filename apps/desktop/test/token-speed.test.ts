import { expect, test } from "bun:test";
import {
  attachOutputTokensToRequestSpans,
  formatTokenSpeedRate,
  formatTokenSpeedSeconds,
  formatTokenSpeedStats,
  isTokenSpeedEligibleSpan,
  isTokenSpeedSpanActive,
  resolveLenientRequestSpan,
  resolveTokenSpeedSegments,
} from "../src/renderer/token-speed";
import {
  DEFAULT_TOKEN_SPEED_PREFERENCES,
  normalizeTokenSpeedPreferences,
} from "../src/renderer/token-speed-preferences";

const T0 = Date.parse("2025-01-01T00:00:00.000Z");

function isoAt(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

test("token speed preference defaults to hidden and migrates the legacy boolean", () => {
  expect(DEFAULT_TOKEN_SPEED_PREFERENCES.mode).toBe("hidden");
  expect(normalizeTokenSpeedPreferences(undefined)).toEqual({ mode: "hidden" });
  expect(normalizeTokenSpeedPreferences(null)).toEqual({ mode: "hidden" });
  expect(normalizeTokenSpeedPreferences({ mode: "bogus" })).toEqual({ mode: "hidden" });
  // Legacy boolean migration
  expect(normalizeTokenSpeedPreferences({ showTokenSpeed: true })).toEqual({ mode: "detailed" });
  expect(normalizeTokenSpeedPreferences({ showTokenSpeed: false })).toEqual({ mode: "hidden" });
  // New mode field wins over legacy when both present
  expect(normalizeTokenSpeedPreferences({ mode: "throughput", showTokenSpeed: false })).toEqual({
    mode: "throughput",
  });
});

test("display segments follow the selected mode", () => {
  const stats = {
    ttftMs: 1_200,
    totalTps: 46,
    prefillTps: 7_200,
    decodeTps: 61,
    tokenSource: "usage" as const,
  };
  expect(resolveTokenSpeedSegments(stats, "hidden").map((s) => s.key)).toEqual([]);
  expect(resolveTokenSpeedSegments(stats, "throughput").map((s) => s.key)).toEqual(["ttft", "total"]);
  expect(resolveTokenSpeedSegments(stats, "detailed").map((s) => s.key)).toEqual([
    "ttft",
    "total",
    "prefill",
    "decode",
  ]);
  // Detailed degrades gracefully when prefill/decode are unavailable
  expect(
    resolveTokenSpeedSegments({ ttftMs: 1_200, totalTps: 46, tokenSource: "usage" }, "detailed").map(
      (s) => s.key,
    ),
  ).toEqual(["ttft", "total"]);
  // Waiting prefix appears while open
  expect(
    resolveTokenSpeedSegments({ waitingMs: 3_200, tokenSource: "usage" }, "throughput").map((s) => s.key),
  ).toEqual(["waiting"]);
});

test("active streaming span publishes live total throughput after 1s", () => {
  const span = {
    status: "streaming" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(800),
  };
  const early = formatTokenSpeedStats(span, "hello world", T0 + 500);
  expect(early.totalTps).toBeUndefined();
  const later = formatTokenSpeedStats(span, "hello world this is a longer streamed answer", T0 + 2_000);
  expect(later.active).toBe(true);
  expect(later.totalTps).toBeGreaterThan(0);
});

test("span active detection only covers open request states", () => {
  expect(isTokenSpeedSpanActive({ requestId: "r", status: "waiting_first_token", startedAt: isoAt(0) })).toBe(
    true,
  );
  expect(isTokenSpeedSpanActive({ requestId: "r", status: "streaming", startedAt: isoAt(0) })).toBe(true);
  expect(isTokenSpeedSpanActive({ requestId: "r", status: "completed", startedAt: isoAt(0) })).toBe(false);
});

test("thinking-labeled spans remain eligible when badge binds via narrative item", () => {
  expect(
    isTokenSpeedEligibleSpan({ requestId: "r", role: "thinking", status: "completed", startedAt: isoAt(0) }),
  ).toBe(true);
});

test("gateway ttftMs and generationMs on span drive closed-span timing", () => {
  const span = {
    requestId: "r",
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(1_000),
    endedAt: isoAt(13_000),
    outputTokens: 546,
    reasoningTokens: 276,
    ttftMs: 940,
    generationMs: 12_000,
  };
  const stats = formatTokenSpeedStats(span, "Hello", T0 + 999_999);
  expect(stats.tokenSource).toBe("usage");
  expect(stats.ttftMs).toBe(940);
  // new-api style: full completion tokens (546, incl. reasoning) over generationMs.
  expect(stats.decodeTps).toBeCloseTo(546 / 12, 5);
});

test("waiting span reports elapsed wait and no ttft/rate", () => {
  const span = { requestId: "r", status: "waiting_first_token" as const, startedAt: isoAt(0) };
  const stats = formatTokenSpeedStats(span, "hello", T0 + 3_200);
  expect(stats.active).toBe(true);
  expect(stats.waitingMs).toBe(3_200);
  expect(stats.ttftMs).toBeUndefined();
  expect(stats.rateTps).toBeUndefined();
  expect(stats.tokenSource).toBe("estimate");
});

test("streaming span reports ttft but withholds live decode rate", () => {
  const span = {
    requestId: "r",
    status: "streaming" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(1_200),
  };
  const text = "aaaa bbbb cccc"; // 14 ascii chars -> 4 estimated tokens
  const stats = formatTokenSpeedStats(span, text, T0 + 5_200);
  expect(stats.active).toBe(true);
  expect(stats.waitingMs).toBeUndefined();
  expect(stats.ttftMs).toBe(1_200);
  expect(stats.streamedTokens).toBe(4);
  expect(stats.tokenSource).toBe("estimate");
  // Live rate omitted — partial windows + text estimates spike wildly.
  expect(stats.rateTps).toBeUndefined();
});

test("completed span without first token stays inactive with no timing", () => {
  const span = { requestId: "r", status: "completed" as const, startedAt: isoAt(0) };
  const stats = formatTokenSpeedStats(span, "hi", T0 + 500);
  expect(stats.active).toBe(false);
  expect(stats.waitingMs).toBeUndefined();
  expect(stats.ttftMs).toBeUndefined();
  expect(stats.tokenSource).toBe("estimate");
});

test("completed span without gateway timing keeps ttft but reports no rate", () => {
  const span = {
    requestId: "r",
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(1_200),
    endedAt: isoAt(4_200),
  };
  const text = "aaaa bbbb cccc"; // 14 ascii chars -> 4 estimated tokens
  const stats = formatTokenSpeedStats(span, text, T0 + 999_999);
  expect(stats.active).toBe(false);
  expect(stats.ttftMs).toBe(1_200);
  expect(stats.tokenSource).toBe("estimate");
  // No gateway decode window — rate is withheld.
  expect(stats.decodeTps).toBeUndefined();
});

test("gateway generationMs drives closed-span rate from provider usage", () => {
  const span = {
    requestId: "r",
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(1_000),
    endedAt: isoAt(4_000),
    outputTokens: 100,
    generationMs: 3_000,
  };
  const text = "x".repeat(400);
  const stats = formatTokenSpeedStats(span, text, T0 + 999_999);
  expect(stats.tokenSource).toBe("usage");
  expect(stats.streamedTokens).toBe(100);
  expect(stats.decodeTps).toBeCloseTo(100 / 3, 5);
});

test("withholds tok/s when gateway generation window is too short to measure", () => {
  const span = {
    requestId: "r",
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(1_000),
    endedAt: isoAt(1_040),
    outputTokens: 500,
    generationMs: 40,
  };
  const stats = formatTokenSpeedStats(span, "x".repeat(2000), T0 + 999_999);
  expect(stats.ttftMs).toBe(1_000);
  expect(stats.decodeTps).toBeUndefined();
});

test("gateway generationMs path uses provider completion tokens for tool-call invocations", () => {
  const span = {
    requestId: "r",
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(500),
    endedAt: isoAt(2_500),
    outputTokens: 480,
    generationMs: 2_000,
  };
  const visible = "Sure, I'll read that file for you.";
  const stats = formatTokenSpeedStats(span, visible, T0 + 999_999);
  expect(stats.tokenSource).toBe("usage");
  expect(stats.decodeTps).toBeCloseTo(240, 0);
});

test("reasoning tokens count toward the gateway rate (full completion tokens)", () => {
  const span = {
    requestId: "r",
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(9_000),
    endedAt: isoAt(11_000),
    outputTokens: 500,
    reasoningTokens: 497,
    generationMs: 1_000,
  };
  const visible = "Hello world"; // ~3 estimated tokens
  const stats = formatTokenSpeedStats(span, visible, T0 + 999_999);
  expect(stats.streamedTokens).toBe(500);
  expect(stats.tokenSource).toBe("usage");
  expect(stats.decodeTps).toBeCloseTo(500, 0);
});

test("without reasoning_tokens, completion tokens drive gateway rate", () => {
  const span = {
    requestId: "r",
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(9_000),
    endedAt: isoAt(11_000),
    outputTokens: 500,
    generationMs: 2_000,
  };
  const visible = "Hello world"; // ~3 estimated tokens
  const stats = formatTokenSpeedStats(span, visible, T0 + 999_999);
  expect(stats.tokenSource).toBe("usage");
  expect(stats.decodeTps).toBeCloseTo(250, 0);
});

test("attachOutputTokensToRequestSpans joins by providerRequestId and proxy requestKey", () => {
  const spans = [
    {
      requestId: "logical-1",
      status: "completed" as const,
      startedAt: isoAt(0),
      providerRequestId: "prov-9",
    },
    {
      requestId: "req_abc",
      status: "completed" as const,
      startedAt: isoAt(1_000),
    },
  ];
  const attached = attachOutputTokensToRequestSpans(spans, [
    { outputTokens: 40, providerRequestId: "prov-9" },
    { outputTokens: 12, requestKey: "proxy:main:model:req_abc:1:2:0:0" },
    { outputTokens: 99, providerRequestId: "unrelated" },
  ]);
  expect(attached[0]?.outputTokens).toBe(40);
  expect(attached[1]?.outputTokens).toBe(12);
});

test("attachOutputTokensToRequestSpans joins reasoning_tokens from ledger", () => {
  const spans = [
    {
      requestId: "req_abc",
      status: "completed" as const,
      startedAt: isoAt(0),
    },
  ];
  const attached = attachOutputTokensToRequestSpans(spans, [
    { outputTokens: 550, reasoningTokens: 129, requestKey: "proxy:main:model:req_abc:1:2:0:0" },
  ]);
  expect(attached[0]?.outputTokens).toBe(550);
  expect(attached[0]?.reasoningTokens).toBe(129);
});

test("formatters round to sensible precision", () => {
  expect(formatTokenSpeedSeconds(3_240)).toBe("3.2");
  expect(formatTokenSpeedSeconds(12_400)).toBe("12");
  expect(formatTokenSpeedRate(45.6)).toBe("45.6");
  expect(formatTokenSpeedRate(123.4)).toBe("123");
});

// Real recorded case (qwen via buffering new-api proxy): headers and the first
// token arrived together after 25.5s, collapsing the prefill window to ~2ms.
// Prefill must be withheld; decode/total must stay correct.
test("buffering proxy (headers ~= first token) withholds prefill, keeps decode", () => {
  const span = {
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(25_512),
    outputTokens: 81,
    ttftMs: 25_512,
    generationMs: 1_330,
    firstHeadersMs: 25_510,
    firstTokenMs: 25_512,
    inputTokens: 9_850,
  };
  const stats = formatTokenSpeedStats(span, "text");
  expect(stats.prefillTps).toBeUndefined();
  expect(stats.netMs).toBe(25_510);
  // decode window = 1330 - (25512-25512) = 1330
  expect(stats.decodeTps!).toBeCloseTo((81 * 1000) / 1_330, 1);
  expect(stats.totalTps!).toBeCloseTo((81 * 1000) / (25_512 + 1_330), 1);
});

test("late headers in the second half of the wait withhold prefill", () => {
  const span = {
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(26_300),
    outputTokens: 100,
    ttftMs: 26_300,
    generationMs: 2_000,
    firstHeadersMs: 26_000,
    firstTokenMs: 26_300,
    inputTokens: 5_000,
  };
  const stats = formatTokenSpeedStats(span, "text");
  // gap is 300ms (>= 100ms) but headers landed late: 26000*2 > 26300
  expect(stats.prefillTps).toBeUndefined();
});

test("healthy early-headers timing publishes prefill", () => {
  const span = {
    status: "completed" as const,
    startedAt: isoAt(0),
    firstTokenAt: isoAt(1_413),
    outputTokens: 1_166,
    reasoningTokens: 371,
    ttftMs: 495,
    generationMs: 23_163,
    firstHeadersMs: 494,
    firstTokenMs: 1_413,
    inputTokens: 44,
  };
  const stats = formatTokenSpeedStats(span, "text");
  expect(stats.prefillTps!).toBeCloseTo((44 * 1000) / (1_413 - 494), 1);
  expect(stats.decodeTps).toBeDefined();
});

test("lenient span resolution prefers the most recent span before the item, matching role first", () => {
  const spans = [
    { requestId: "a", role: "main", status: "completed" as const, startedAt: isoAt(0) },
    { requestId: "b", role: "coder", status: "completed" as const, startedAt: isoAt(2_000) },
    { requestId: "c", role: "coder", status: "completed" as const, startedAt: isoAt(8_000) },
    { requestId: "t", role: "thinking", status: "completed" as const, startedAt: isoAt(9_500) },
  ];
  // item starts at 9s, role coder -> picks span c (most recent coder startedAt <= 9s)
  expect(resolveLenientRequestSpan({ at: isoAt(9_000), role: "coder" }, spans)?.requestId).toBe("c");
  // item role planner -> picks span a (only planner)
  expect(resolveLenientRequestSpan({ at: isoAt(9_000), role: "main" }, spans)?.requestId).toBe("a");
  // no role -> most recent overall startedAt <= item.at
  expect(resolveLenientRequestSpan({ at: isoAt(10_000) }, spans)?.requestId).toBe("t");
  // item before any span -> undefined
  expect(resolveLenientRequestSpan({ at: isoAt(-1_000) }, spans)).toBeUndefined();
  // empty spans -> undefined
  expect(resolveLenientRequestSpan({ at: isoAt(9_000) }, [])).toBeUndefined();
});
