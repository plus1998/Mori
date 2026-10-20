import { expect, test } from "bun:test";
import type { ThreadBillingSnapshot } from "../src/shared/ipc";
import {
  buildFallbackContextSnapshot,
  buildThreadUsageSummary,
  contextCardPlaceholderKey,
  shouldShowBillingUsagePanel,
  shouldShowContextUsagePanel,
  shouldShowThreadUsagePanels,
} from "../src/shared/thread-usage-summary";

test("shouldShowThreadUsagePanels includes awaiting_plan and terminal statuses", () => {
  expect(shouldShowThreadUsagePanels("awaiting_plan")).toBe(true);
  expect(shouldShowThreadUsagePanels("completed")).toBe(true);
  expect(shouldShowThreadUsagePanels("idle")).toBe(true);
});

test("buildFallbackContextSnapshot uses planner usage when no /context cache", () => {
  const context = buildFallbackContextSnapshot({
    plannerUsage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 42_000,
      contextLimit: 200_000,
      occupancyPct: 21,
    },
  });
  expect(context?.occupied).toBe(42_000);
  expect(context?.segments.length).toBeGreaterThan(0);
});

test("buildThreadUsageSummary always includes context when tokens known", () => {
  const summary = buildThreadUsageSummary({
    usageByRole: {
      planner: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 12_000,
        contextLimit: 200_000,
        occupancyPct: 6,
      },
      coder: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 80_000,
        contextLimit: 100_000,
        occupancyPct: 80,
        modelId: "coder-model",
      },
    },
  });
  expect(summary.context?.occupied).toBe(12_000);
  expect(summary.context?.displayRole).toBe("planner");
  expect(summary.context?.roles?.find((role) => role.role === "coder")?.occupied).toBe(80_000);
});

test("buildThreadUsageSummary preserves dynamic orchestration context roles", () => {
  const summary = buildThreadUsageSummary({
    usageByRole: {
      researcher: {
        inputTokens: 20,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 50_000,
        contextLimit: 100_000,
        occupancyPct: 50,
        modelId: "research-model",
      },
    },
  });

  expect(summary.context?.displayRole).toBe("researcher");
  expect(summary.context?.roles?.[0]).toMatchObject({
    role: "researcher",
    occupied: 50_000,
    modelId: "research-model",
  });
});

test("contextCardPlaceholderKey selects localized hints for each state", () => {
  expect(contextCardPlaceholderKey("awaiting_plan")).toBe("context.emptyHint.planning");
  expect(contextCardPlaceholderKey("running")).toBe("context.emptyHint.accumulating");
  expect(contextCardPlaceholderKey("completed")).toBe("context.emptyHint.noData");
  expect(contextCardPlaceholderKey()).toBe("context.empty");
});

test("shouldShowContextUsagePanel and billing panel honor hostUiFeatures", () => {
  expect(shouldShowContextUsagePanel("running")).toBe(true);
  expect(shouldShowContextUsagePanel("running", { contextUsage: "hide", billing: "show" })).toBe(false);
  expect(shouldShowBillingUsagePanel("running", { contextUsage: "show", billing: "hide" })).toBe(false);
  expect(shouldShowBillingUsagePanel("running", { contextUsage: "hide", billing: "hide" })).toBe(false);
});

test("buildThreadUsageSummary omits hidden context and billing instead of fabricating them", () => {
  const summary = buildThreadUsageSummary({
    hostUiFeatures: { contextUsage: "hide", billing: "hide" },
    billing: {
      plannerTokenCostUsd: 1,
      ecoCostUsd: 1,
      savedUsd: 0,
      savedPct: 0,
      pricingResolved: true,
      sourceReportedCostUsd: 1,
      totalTokens: { input: 10, output: 10, cacheRead: 0, cacheCreation: 0 },
    } as ThreadBillingSnapshot,
    usageByRole: {
      planner: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextTokens: 12_000,
        contextLimit: 200_000,
        occupancyPct: 6,
      },
    },
  });
  expect(summary.context).toBeUndefined();
  expect(summary.billing).toBeUndefined();
});
