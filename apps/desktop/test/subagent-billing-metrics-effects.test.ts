import { expect, test } from "bun:test";
import type { ParsedUsage } from "@eco/runtime";
import {
  buildSubagentContextObservationInput,
  resolveSubagentBillingMetricsContext,
  type UsageContextSnapshot,
} from "../src/main/subagent-billing-metrics-effects";

const usage: ParsedUsage = {
  inputTokens: 1_000,
  outputTokens: 300,
  cacheReadTokens: 200,
  cacheCreationTokens: 50,
};

function snapshotWithInstance(): UsageContextSnapshot {
  return {
    occupied: 12_000,
    limit: 100_000,
    ratio: 0.12,
    occupancyPct: 12,
    limitsResolved: true,
    roles: [],
    instances: [
      {
        agentId: "agent_coder",
        role: "coder",
        occupied: 8_765,
        limit: 64_000,
        occupancyPct: 14,
        limitsResolved: true,
        segments: [],
        updatedAt: 1,
      },
    ],
  };
}

test("resolveSubagentBillingMetricsContext uses the matching instance snapshot", () => {
  expect(
    resolveSubagentBillingMetricsContext({
      role: "coder",
      agentId: "agent_coder",
      snapshot: snapshotWithInstance(),
      fallbackUsage: usage,
    }),
  ).toEqual({
    role: "coder",
    agentId: "agent_coder",
    contextOccupied: 8_765,
    contextLimit: 64_000,
  });
});

test("resolveSubagentBillingMetricsContext supports any resolved agent role and skips missing agents", () => {
  expect(
    resolveSubagentBillingMetricsContext({
      role: "main",
      agentId: "agent_planner",
      snapshot: snapshotWithInstance(),
      fallbackUsage: usage,
    }),
  ).toEqual({
    role: "main",
    agentId: "agent_planner",
    contextOccupied: 1_250,
  });
  expect(
    resolveSubagentBillingMetricsContext({
      role: "coder",
      snapshot: snapshotWithInstance(),
      fallbackUsage: usage,
    }),
  ).toBeUndefined();
});

test("resolveSubagentBillingMetricsContext falls back to input and cache occupancy", () => {
  expect(
    resolveSubagentBillingMetricsContext({
      role: "coder",
      agentId: "agent_coder",
      snapshot: undefined,
      fallbackUsage: usage,
    }),
  ).toEqual({
    role: "coder",
    agentId: "agent_coder",
    contextOccupied: 1_250,
  });
});

test("buildSubagentContextObservationInput maps context and optional fields", () => {
  const context = resolveSubagentBillingMetricsContext({
    role: "coder",
    agentId: "agent_coder",
    snapshot: snapshotWithInstance(),
    fallbackUsage: usage,
  });
  expect(context).toBeDefined();

  const observation = buildSubagentContextObservationInput(context!, {
    parentToolUseId: "toolu_parent",
    modelId: "claude-haiku",
    requestKey: "sdk-result:event_1",
  });
  expect(observation).toEqual({
    role: "coder",
    agentId: "agent_coder",
    parentToolUseId: "toolu_parent",
    contextOccupied: 8_765,
    contextLimit: 64_000,
    modelId: "claude-haiku",
    requestKey: "sdk-result:event_1",
  });
});
