import { expect, test } from "bun:test";
import { ThreadUsageAccumulator } from "../src/main/thread-usage-accumulator";

const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };

test("ThreadUsageAccumulator tracks four billing metrics", () => {
  const accumulator = new ThreadUsageAccumulator();
  const delta = { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

  accumulator.recordUsage({
    threadId: "t1",
    role: "coder",
    delta,
    sourceReportedCostUsd: 0.5,
    actualRates: haikuRates,
    plannerRates: sonnetRates,
    modelId: "haiku",
    requestKey: "sdk:coder:100000:10000:0:0:haiku",
    plannerModelLabel: "sonnet · Anthropic",
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.sourceReportedCostUsd).toBe(0.5);
  expect(billing?.plannerTokenCostUsd).toBeCloseTo(0.45);
  expect(billing?.ecoCostUsd).toBeCloseTo(0.12);
  expect(billing?.savedUsd).toBeCloseTo(0.33);
  expect(billing?.totalTokens.input).toBe(100_000);
});

test("ThreadUsageAccumulator deduplicates by requestKey", () => {
  const accumulator = new ThreadUsageAccumulator();
  const input = {
    threadId: "t1",
    role: "main" as const,
    delta: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 },
    sourceReportedCostUsd: 0.01,
    actualRates: sonnetRates,
    plannerRates: sonnetRates,
    requestKey: "dup-key",
  };
  accumulator.recordUsage(input);
  accumulator.recordUsage(input);
  const billing = accumulator.getSnapshot("t1");
  expect(billing?.sourceReportedCostUsd).toBe(0.01);
  expect(billing?.totalTokens.input).toBe(1000);
});

test("ThreadUsageAccumulator serialize and restore round-trip", () => {
  const accumulator = new ThreadUsageAccumulator();
  const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  accumulator.recordUsage({
    threadId: "t1",
    role: "main",
    delta: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0 },
    actualRates: sonnetRates,
    plannerRates: sonnetRates,
    requestKey: "run:1",
    plannerModelLabel: "opus · Anthropic",
  });

  const serialized = accumulator.serializeState("t1");
  expect(serialized).not.toBeUndefined();

  const fresh = new ThreadUsageAccumulator();
  fresh.restoreState("t1", serialized!);
  const billing = fresh.getSnapshot("t1");
  expect(billing?.sourceReportedCostUsd).toBe(0);
  expect(billing?.totalTokens.input).toBe(1000);
  expect(billing?.plannerModelLabel).toBe("opus · Anthropic");
});

test("restoring mixed planner/main usage merges both aliases and preserves totals", () => {
  const accumulator = new ThreadUsageAccumulator();
  for (const [role, inputTokens] of [
    ["planner", 10],
    ["main", 20],
  ] as const) {
    accumulator.recordUsage({
      threadId: "old",
      role,
      delta: { inputTokens, outputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3 },
      actualRates: sonnetRates,
      plannerRates: sonnetRates,
      modelId: "same-model",
      requestKey: role,
    });
  }
  const serialized = accumulator.serializeState("old")!;
  const original = JSON.stringify(serialized);
  const restored = new ThreadUsageAccumulator();
  restored.restoreState("old", serialized);
  const billing = restored.getSnapshot("old")!;
  expect(billing.totalTokens).toEqual({ input: 30, output: 2, cacheRead: 4, cacheCreation: 6 });
  expect(billing.byRole?.main).toMatchObject({
    inputTokens: 30,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheCreationTokens: 6,
  });
  expect(billing.byRole?.planner).toBeUndefined();
  expect(billing.byModel?.[0]?.roles).toEqual(["main"]);
  expect(restored.serializeState("old")?.byRole.planner).toBeUndefined();
  expect(JSON.stringify(serialized)).toBe(original);
});

test("ThreadUsageAccumulator recordRunUsage bills cache at models.dev rates", () => {
  const accumulator = new ThreadUsageAccumulator();
  accumulator.recordRunUsage({
    threadId: "t1",
    role: "main",
    requestKey: "sdk-result:run-1",
    models: [
      {
        modelId: "claude-sonnet-4-6",
        usage: {
          inputTokens: 39,
          outputTokens: 904,
          cacheReadTokens: 230_827,
          cacheCreationTokens: 53_995,
        },
        actualRates: sonnetRates,
        plannerRates: sonnetRates,
      },
    ],
    sourceReportedCostUsd: 0.18,
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.totalTokens.cacheRead).toBe(230_827);
  expect(billing?.ecoCostBreakdown?.cacheReadUsd).toBeCloseTo(0.0692481, 4);
  expect(billing?.sourceReportedCostUsd).toBe(0.18);
});

test("ThreadUsageAccumulator recordRunUsage attributes per-model role", () => {
  const accumulator = new ThreadUsageAccumulator();
  const delta = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

  accumulator.recordRunUsage({
    threadId: "t1",
    role: "main",
    requestKey: "sdk-result:run-explore",
    models: [
      {
        role: "explore",
        modelId: "claude-haiku-4-5",
        usage: delta,
        actualRates: haikuRates,
        plannerRates: sonnetRates,
      },
    ],
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.byRole?.explore?.inputTokens).toBe(10_000);
  expect(billing?.byRole?.main).toBeUndefined();
  expect(billing?.ecoCostUsd).toBeCloseTo(0.012, 4);
  expect(billing?.plannerTokenCostUsd).toBeCloseTo(0.045, 4);
});

test("ThreadUsageAccumulator preserves dynamic orchestration roles", () => {
  const accumulator = new ThreadUsageAccumulator();
  const delta = { inputTokens: 12_000, outputTokens: 1_200, cacheReadTokens: 0, cacheCreationTokens: 0 };

  accumulator.recordRunUsage({
    threadId: "t1",
    role: "researcher",
    source: "sdk",
    requestKey: "sdk-result:dynamic-researcher",
    models: [
      {
        role: "source_verifier",
        modelId: "research-model",
        usage: delta,
        actualRates: haikuRates,
        plannerRates: sonnetRates,
      },
    ],
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.byRole?.source_verifier?.inputTokens).toBe(12_000);
  expect(billing?.byModel?.[0]?.roles).toEqual(["source_verifier"]);
});

test("ThreadUsageAccumulator keeps separate source totals for proxy and sdk", () => {
  const accumulator = new ThreadUsageAccumulator();
  const delta = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

  accumulator.recordUsage({
    threadId: "t1",
    role: "coder",
    source: "proxy",
    delta,
    actualRates: haikuRates,
    plannerRates: sonnetRates,
    modelId: "haiku",
    requestKey: "proxy:1",
  });
  accumulator.recordRunUsage({
    threadId: "t1",
    role: "coder",
    source: "sdk",
    requestKey: "sdk:1",
    models: [
      {
        role: "coder",
        modelId: "haiku",
        usage: delta,
        actualRates: haikuRates,
        plannerRates: sonnetRates,
        sdkCostUsd: 0.19,
      },
    ],
    sourceReportedCostUsd: 0.19,
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.primarySource).toBe("proxy");
  expect(billing?.totalTokens.input).toBe(10_000);
  expect(billing?.sourceBreakdown?.sdk?.reportedCostUsd).toBeCloseTo(0.19);
  expect(billing?.sourceBreakdown?.proxy?.ecoCostUsd).toBeCloseTo(0.012);
});

test("ThreadUsageAccumulator byModel keeps two models under one role", () => {
  const accumulator = new ThreadUsageAccumulator();

  accumulator.recordRunUsage({
    threadId: "t1",
    role: "main",
    source: "sdk",
    requestKey: "sdk:multi-model",
    models: [
      {
        role: "main",
        modelId: "sonnet",
        usage: { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
        actualRates: sonnetRates,
        plannerRates: sonnetRates,
      },
      {
        role: "main",
        modelId: "haiku",
        usage: { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
        actualRates: haikuRates,
        plannerRates: sonnetRates,
      },
    ],
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.byRole?.main?.modelId).toBe("haiku");
  expect(billing?.byModel?.map((entry) => entry.modelId).sort()).toEqual(["haiku", "sonnet"]);
  expect(billing?.byModel?.find((entry) => entry.modelId === "sonnet")?.ecoCostUsd).toBeCloseTo(0.045);
  expect(billing?.byModel?.find((entry) => entry.modelId === "haiku")?.ecoCostUsd).toBeCloseTo(0.024);
});
