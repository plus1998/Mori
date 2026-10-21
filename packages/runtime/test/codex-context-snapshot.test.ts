import { expect, test } from "bun:test";
import { buildCodexGatewayModelAlias } from "../src/codex-config-sync.js";
import {
  buildCodexThreadUsageSummary,
  CODEX_CONTEXT_ESTIMATE_LABEL,
  parseCodexThreadTokenUsage,
  resolveCodexContextFromNotification,
  resolveCodexContextSnapshot,
} from "../src/codex-context-snapshot.js";
import { DEFAULT_CONTEXT_LIMIT } from "../src/models-dev-limits.js";

const MAIN_ATTRIBUTION = {
  ecoThreadId: "thr_eco_main",
  billingRole: "main" as const,
};

const SUB_ATTRIBUTION = {
  ecoThreadId: "thr_eco_main",
  billingRole: "explore" as const,
  parentEcoThreadId: "thr_eco_main",
  isSubagentThread: true,
  agentId: "agent_explore_1",
};

function tokenUsagePayload(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thr_codex_main",
    turnId: "turn_001",
    tokenUsage: {
      last: {
        cachedInputTokens: 640,
        inputTokens: 12_400,
        outputTokens: 1_200,
        reasoningOutputTokens: 0,
        totalTokens: 48_000,
      },
      total: {
        cachedInputTokens: 640,
        inputTokens: 52_000,
        outputTokens: 8_400,
        reasoningOutputTokens: 0,
        totalTokens: 60_400,
      },
      modelContextWindow: 200_000,
    },
    ...overrides,
  };
}

test("parseCodexThreadTokenUsage accepts camelCase Codex payload", () => {
  const parsed = parseCodexThreadTokenUsage(tokenUsagePayload().tokenUsage);
  expect(parsed?.last.totalTokens).toBe(48_000);
  expect(parsed?.modelContextWindow).toBe(200_000);
});

test("resolveCodexContextSnapshot maps last.totalTokens to occupied and percentage", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload(),
    attribution: MAIN_ATTRIBUTION,
  });

  expect(resolved).not.toBeNull();
  expect(resolved?.contextOccupied).toBe(48_000);
  expect(resolved?.context.occupied).toBe(48_000);
  expect(resolved?.context.limit).toBe(200_000);
  expect(resolved?.context.occupancyPct).toBe(24);
  expect(resolved?.context.limitsResolved).toBe(true);
  expect(resolved?.estimateLabel).toBe(CODEX_CONTEXT_ESTIMATE_LABEL);
  expect(resolved?.context.isEstimate).toBe(true);
  expect(resolved?.context.segments).toEqual([]);
});

test("resolveCodexContextSnapshot unwraps provider-scoped Codex gateway aliases", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload(),
    attribution: MAIN_ATTRIBUTION,
    modelId: buildCodexGatewayModelAlias("custom-provider", "vendor-model"),
  });

  expect(resolved?.context.modelId).toBe("vendor-model");
  expect(resolved?.context.roles?.[0]?.modelId).toBe("vendor-model");
});

test("resolveCodexContextSnapshot unwraps V1 route aliases", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload(),
    attribution: MAIN_ATTRIBUTION,
    modelId: buildCodexGatewayModelAlias("custom.__provider", "vendor/model.__v1", "anthropic"),
  });

  expect(resolved?.context.modelId).toBe("vendor/model.__v1");
  expect(resolved?.context.roles?.[0]?.modelId).toBe("vendor/model.__v1");
});

test("resolveCodexContextSnapshot rejects malformed reserved V1 aliases", () => {
  expect(() =>
    resolveCodexContextSnapshot({
      params: tokenUsagePayload(),
      attribution: MAIN_ATTRIBUTION,
      modelId: "eco_route_v1.bad",
    }),
  ).toThrow("Invalid Codex gateway model alias");
});

test("resolveCodexContextSnapshot does not fabricate breakdown segments", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload(),
    attribution: MAIN_ATTRIBUTION,
  });

  expect(resolved?.context.segments).toEqual([]);
  expect(resolved?.context.roles?.[0]?.segments).toEqual([]);
});

test("resolveCodexContextSnapshot falls back to default limit without modelContextWindow", () => {
  const payload = tokenUsagePayload();
  const tokenUsage = { ...(payload.tokenUsage as Record<string, unknown>) };
  delete tokenUsage.modelContextWindow;

  const resolved = resolveCodexContextSnapshot({
    params: { ...payload, tokenUsage },
    attribution: MAIN_ATTRIBUTION,
  });

  expect(resolved?.context.limit).toBe(DEFAULT_CONTEXT_LIMIT);
  expect(resolved?.context.limitsResolved).toBe(false);
});

test("buildCodexThreadUsageSummary maps ThreadUsageSnapshot fields from last usage", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload(),
    attribution: MAIN_ATTRIBUTION,
    modelId: "gpt-5.2",
  });
  expect(resolved).not.toBeNull();

  const summary = buildCodexThreadUsageSummary({
    context: resolved!.context,
    billingRole: "main",
    last: parseCodexThreadTokenUsage(tokenUsagePayload().tokenUsage)!.last,
  });

  expect(summary.contextTokens).toBe(48_000);
  expect(summary.usageByRole?.main).toEqual({
    inputTokens: 12_400,
    outputTokens: 1_200,
    cacheReadTokens: 640,
    cacheCreationTokens: 0,
    contextTokens: 48_000,
    contextLimit: 200_000,
    occupancyPct: 24,
    modelId: "gpt-5.2",
  });
});

test("resolveCodexContextSnapshot attributes sub-thread usage to billing role", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload({
      threadId: "thr_codex_child",
    }),
    attribution: SUB_ATTRIBUTION,
  });

  expect(resolved?.billingRole).toBe("explore");
  expect(resolved?.ecoThreadId).toBe("thr_eco_main");
  expect(resolved?.usageSummary.usageByRole?.explore?.contextTokens).toBe(48_000);
  expect(resolved?.context.modelId).toBeUndefined();
  expect(resolved?.usageSummary.usageByRole?.explore?.modelId).toBeUndefined();
});

test("resolveCodexContextFromNotification resolves eco thread id", () => {
  const resolved = resolveCodexContextFromNotification(tokenUsagePayload(), {
    resolveEcoThreadId: (codexThreadId) =>
      codexThreadId === "thr_codex_main" ? "thr_eco_main" : codexThreadId,
  });

  expect(resolved?.ecoThreadId).toBe("thr_eco_main");
  expect(resolved?.codexThreadId).toBe("thr_codex_main");
});

test("resolveCodexContextFromNotification ignores unmapped child codex threads", () => {
  const resolved = resolveCodexContextFromNotification(
    tokenUsagePayload({ threadId: "thr_codex_child_unmapped" }),
    {
      resolveEcoThreadId: (codexThreadId) => codexThreadId,
    },
  );
  expect(resolved).toBeNull();
});

test("resolveCodexContextSnapshot ignores non-schema categories instead of fabricating segments", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload({
      tokenUsage: {
        last: {
          cachedInputTokens: 0,
          inputTokens: 10_000,
          outputTokens: 500,
          reasoningOutputTokens: 0,
          totalTokens: 42_000,
        },
        total: {
          cachedInputTokens: 0,
          inputTokens: 10_000,
          outputTokens: 500,
          reasoningOutputTokens: 0,
          totalTokens: 42_000,
        },
        modelContextWindow: 200_000,
        categories: [
          { name: "system prompt", tokens: 5_000 },
          { name: "tools", tokens: 10_000 },
          { name: "messages", tokens: 27_000 },
        ],
      },
    }),
    attribution: MAIN_ATTRIBUTION,
  });

  expect(resolved?.context.isEstimate).toBe(true);
  expect(resolved?.estimateLabel).toBe(CODEX_CONTEXT_ESTIMATE_LABEL);
  expect(resolved?.context.segments).toEqual([]);
});

test("parseCodexThreadTokenUsage rejects non-schema and incomplete token breakdowns", () => {
  const payload = tokenUsagePayload();
  const tokenUsage = payload.tokenUsage as Record<string, unknown>;
  const last = { ...(tokenUsage.last as Record<string, unknown>) };
  delete last.reasoningOutputTokens;
  expect(parseCodexThreadTokenUsage({ ...tokenUsage, last })).toBeNull();

  expect(
    parseCodexThreadTokenUsage({
      last: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
        total_tokens: 2,
      },
      total: tokenUsage.total,
    }),
  ).toBeNull();
});

test("resolveCodexContextSnapshot never reads model identity from notification extras", () => {
  const resolved = resolveCodexContextSnapshot({
    params: tokenUsagePayload({ modelId: "invented-model" }),
    attribution: MAIN_ATTRIBUTION,
  });
  expect(resolved?.context.modelId).toBeUndefined();
});

test("resolveCodexContextSnapshot returns null when tokenUsage missing", () => {
  const resolved = resolveCodexContextSnapshot({
    params: { threadId: "thr_codex_main", turnId: "turn_001" },
    attribution: MAIN_ATTRIBUTION,
  });
  expect(resolved).toBeNull();
});
