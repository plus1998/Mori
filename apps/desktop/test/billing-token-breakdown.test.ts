import { expect, test } from "bun:test";
import {
  type BillingAgentRow,
  buildAgentViewRows,
  buildBillingTokenBreakdown,
} from "../src/shared/billing-token-breakdown";
import type { ThreadBillingSnapshot } from "../src/shared/ipc";

function makeBilling(byRole: NonNullable<ThreadBillingSnapshot["byRole"]>): ThreadBillingSnapshot {
  const total = Object.values(byRole).reduce(
    (acc, entry) => ({
      input: acc.input + entry.inputTokens,
      output: acc.output + entry.outputTokens,
      cacheRead: acc.cacheRead + entry.cacheReadTokens,
      cacheCreation: acc.cacheCreation + entry.cacheCreationTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  );

  return {
    totalTokens: total,
    sourceReportedCostUsd: 0,
    plannerTokenCostUsd: 0,
    ecoCostUsd: Object.values(byRole).reduce((sum, entry) => sum + entry.ecoCostUsd, 0),
    savedUsd: 0,
    savedPct: 0,
    pricingResolved: true,
    byRole,
  };
}

test("buildBillingTokenBreakdown returns agent rows in AGENT_ROLES order", () => {
  const breakdown = buildBillingTokenBreakdown(
    makeBilling({
      coder: {
        inputTokens: 5000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ecoCostUsd: 0.05,
        modelId: "claude-haiku-4-5",
      },
      main: {
        inputTokens: 10000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ecoCostUsd: 0.1,
        modelId: "claude-opus-4-7",
      },
    }),
  );

  expect(breakdown?.byAgent.map((row) => row.role)).toEqual(["main", "coder"]);
  expect(breakdown?.byAgent[0]?.label).toBe("主代理 · 主");
  expect(breakdown?.byAgent[1]?.label).toBe("编码 · 主");
  expect(breakdown?.byAgent[0]?.tokenBadge).toBe("↑10k ↓1k");
});

test("buildBillingTokenBreakdown merges roles that share the same model", () => {
  const breakdown = buildBillingTokenBreakdown(
    makeBilling({
      explore: {
        inputTokens: 3000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ecoCostUsd: 0.02,
        modelId: "claude-haiku-4-5",
      },
      coder: {
        inputTokens: 7000,
        outputTokens: 700,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ecoCostUsd: 0.04,
        modelId: "claude-haiku-4-5",
      },
    }),
  );

  expect(breakdown?.byModel).toHaveLength(1);
  expect(breakdown?.byModel[0]?.roles).toEqual(["explore", "coder"]);
  expect(breakdown?.byModel[0]?.inputTokens).toBe(10000);
  expect(breakdown?.byModel[0]?.ecoCostUsd).toBeCloseTo(0.06);
});

test("buildBillingTokenBreakdown uses readable model display names", () => {
  const breakdown = buildBillingTokenBreakdown(
    makeBilling({
      coder: {
        inputTokens: 3000,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ecoCostUsd: 0.02,
        modelId: "deepseek-ai/deepseek-r1-distill-qwen-32b-instruct",
      },
    }),
  );

  expect(breakdown?.byModel[0]?.label).toBe("Deepseek R1 Distill Qwen 32b Instruct");
});

test("buildBillingTokenBreakdown includes dynamic orchestration roles", () => {
  const breakdown = buildBillingTokenBreakdown(
    makeBilling({
      researcher: {
        inputTokens: 4000,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ecoCostUsd: 0.03,
        modelId: "research-model",
      },
      main: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ecoCostUsd: 0.01,
        modelId: "planner-model",
      },
    }),
  );

  expect(breakdown?.byAgent.map((row) => row.role)).toEqual(["main", "researcher"]);
  expect(breakdown?.byAgent.find((row) => row.role === "researcher")?.tokenBadge).toBe("↑4k ↓400");
  expect(breakdown?.byModel.flatMap((row) => row.roles)).toContain("researcher");
});

test("buildBillingTokenBreakdown does not supplement roles from non-primary sources", () => {
  const billing = makeBilling({});
  billing.primarySource = "sdk";
  billing.byRole = {};
  billing.sourceBreakdown = {
    sdk: {
      source: "sdk",
      totalTokens: { input: 4000, output: 400, cacheRead: 0, cacheCreation: 0 },
      plannerTokenCostUsd: 0,
      ecoCostUsd: 0.03,
      pricingResolved: true,
      byRole: {
        researcher: {
          inputTokens: 4000,
          outputTokens: 400,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          ecoCostUsd: 0.03,
          modelId: "research-model",
        },
      },
    },
  };

  const breakdown = buildBillingTokenBreakdown(billing);
  expect(breakdown).toBeNull();
});

test("buildBillingTokenBreakdown passes reportedCostUsd on model rows when present", () => {
  const billing = makeBilling({
    main: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.02,
      modelId: "sonnet",
    },
  });
  billing.byModel = [
    {
      modelId: "sonnet",
      roles: ["main"],
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.02,
      reportedCostUsd: 0.019,
    },
  ];

  const breakdown = buildBillingTokenBreakdown(billing);
  expect(breakdown?.byModel[0]?.reportedCostUsd).toBeCloseTo(0.019);
});

test("buildBillingTokenBreakdown omits zero reportedCostUsd on model rows", () => {
  const billing = makeBilling({
    main: {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.02,
      modelId: "sonnet",
    },
  });
  billing.byModel = [
    {
      modelId: "sonnet",
      roles: ["main"],
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.02,
      reportedCostUsd: 0,
    },
  ];

  const breakdown = buildBillingTokenBreakdown(billing);
  expect(breakdown?.byModel[0]?.reportedCostUsd).toBeUndefined();
});

test("buildBillingTokenBreakdown prefers explicit byModel rows", () => {
  const billing = makeBilling({
    main: {
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.03,
      modelId: "last-model",
    },
  });
  billing.byModel = [
    {
      modelId: "sonnet",
      roles: ["main"],
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.02,
    },
    {
      modelId: "haiku",
      roles: ["main"],
      inputTokens: 2000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.01,
    },
  ];

  const breakdown = buildBillingTokenBreakdown(billing);
  expect(breakdown?.byModel.map((row) => row.modelId).sort()).toEqual(["haiku", "sonnet"]);
});

test("buildBillingTokenBreakdown uses primary byRole only when supplemental sources exist", () => {
  const billing = makeBilling({
    explore: {
      inputTokens: 3000,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      ecoCostUsd: 0.02,
      modelId: "claude-haiku-4-5",
    },
  });
  billing.primarySource = "proxy";
  billing.sourceBreakdown = {
    proxy: {
      source: "proxy",
      totalTokens: { input: 3000, output: 300, cacheRead: 0, cacheCreation: 0 },
      plannerTokenCostUsd: 0,
      ecoCostUsd: 0.02,
      pricingResolved: true,
      byRole: billing.byRole,
    },
    sdk: {
      source: "sdk",
      totalTokens: { input: 10000, output: 1000, cacheRead: 0, cacheCreation: 0 },
      plannerTokenCostUsd: 0.1,
      ecoCostUsd: 0.1,
      pricingResolved: true,
      byRole: {
        main: {
          inputTokens: 10000,
          outputTokens: 1000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          ecoCostUsd: 0.1,
          modelId: "claude-opus-4-7",
        },
      },
    },
  };

  const breakdown = buildBillingTokenBreakdown(billing);
  expect(breakdown?.byAgent.map((row) => row.role)).toEqual(["explore"]);
  expect(breakdown?.byModel.map((row) => row.modelId)).toEqual(["claude-haiku-4-5"]);
});

function makeAgentRow(role: string, overrides: Partial<BillingAgentRow> = {}): BillingAgentRow {
  return {
    role,
    label: `${role} · 主`,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ecoCostUsd: 0.01,
    tokenBadge: "↑1k ↓100",
    ...overrides,
  };
}

function makeSubagentUsage(
  role: string,
  overrides: Partial<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    ecoCostUsd: number;
  }> = {},
) {
  return {
    role,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ecoCostUsd: 0,
    ...overrides,
  };
}

test("buildAgentViewRows keeps roles without subagent rows as primary", () => {
  const rows = buildAgentViewRows([makeAgentRow("main")], []);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ role: "main", kind: "primary", inputTokens: 1000 });
});

test("buildAgentViewRows keeps role usage visible when subagent rows are all zero", () => {
  const rows = buildAgentViewRows(
    [makeAgentRow("explore", { inputTokens: 225000, outputTokens: 4000, ecoCostUsd: 0.2 })],
    [makeSubagentUsage("explore"), makeSubagentUsage("explore"), makeSubagentUsage("explore")],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    role: "explore",
    kind: "unattributed",
    inputTokens: 225000,
    outputTokens: 4000,
    ecoCostUsd: 0.2,
  });
});

test("buildAgentViewRows drops fully attributed role rows", () => {
  const rows = buildAgentViewRows(
    [makeAgentRow("explore", { inputTokens: 300, outputTokens: 30, ecoCostUsd: 0.03 })],
    [
      makeSubagentUsage("explore", { inputTokens: 100, outputTokens: 10, ecoCostUsd: 0.01 }),
      makeSubagentUsage("explore", { inputTokens: 200, outputTokens: 20, ecoCostUsd: 0.02 }),
    ],
  );
  expect(rows).toHaveLength(0);
});

test("buildAgentViewRows shows only the unattributed remainder for partially attributed roles", () => {
  const rows = buildAgentViewRows(
    [makeAgentRow("explore", { inputTokens: 500, outputTokens: 50, ecoCostUsd: 0.05 })],
    [makeSubagentUsage("explore", { inputTokens: 300, outputTokens: 20, ecoCostUsd: 0.02 })],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    role: "explore",
    kind: "unattributed",
    inputTokens: 200,
    outputTokens: 30,
  });
  expect(rows[0]?.ecoCostUsd).toBeCloseTo(0.03, 6);
});

test("buildBillingTokenBreakdown returns null for empty or zero usage", () => {
  expect(buildBillingTokenBreakdown(undefined)).toBeNull();
  expect(buildBillingTokenBreakdown(makeBilling({}))).toBeNull();
  expect(
    buildBillingTokenBreakdown(
      makeBilling({
        main: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          ecoCostUsd: 0,
        },
      }),
    ),
  ).toBeNull();
});
