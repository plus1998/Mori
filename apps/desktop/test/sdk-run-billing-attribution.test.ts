import { expect, test } from "bun:test";
import { computeRequestBilling, type ParsedUsage } from "@eco/runtime";
import {
  resolveSdkRunBillingAttribution,
  type SdkRunBillingAttributionResolver,
} from "../src/main/sdk-run-billing-attribution";
import type { ResolvedSdkRunBillingModel } from "../src/main/usage-billing-artifacts";
import type { AgentRole } from "../src/shared/ipc";

function usage(): ParsedUsage {
  return { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

function model(role: AgentRole | undefined, modelId: string): ResolvedSdkRunBillingModel {
  const modelUsage = usage();
  return {
    ...(role && { role }),
    modelId,
    usage: modelUsage,
    actualRates: null,
    plannerRates: null,
    computedBilling: computeRequestBilling(modelUsage, null, null),
  };
}

test("resolveSdkRunBillingAttribution resolves subagent from parent tool use", () => {
  const resolveInputs: Array<Parameters<SdkRunBillingAttributionResolver["resolveAgentId"]>[1]> = [];
  const resolver: SdkRunBillingAttributionResolver = {
    resolveAgentId: (_threadId, input) => {
      resolveInputs.push(input);
      return input.parentToolUseId === "tool_parent" ? "agent_coder" : undefined;
    },
    roleForAgentId: () => "coder",
  };

  const attribution = resolveSdkRunBillingAttribution({
    threadId: "thr_attr",
    role: "main",
    models: [model("coder", "haiku")],
    resolver,
    parentToolUseId: "tool_parent",
    plannerAgentId: "agent_planner",
  });

  expect(resolveInputs).toEqual([{ role: "coder", parentToolUseId: "tool_parent" }]);
  expect(attribution).toEqual({
    billingRole: "coder",
    allLedgerRowsArePlanner: false,
    resolvedSubagentId: "agent_coder",
    ledgerAgentId: "agent_coder",
  });
});

test("resolveSdkRunBillingAttribution uses explicit subagent and registry role", () => {
  let resolveCount = 0;
  const resolver: SdkRunBillingAttributionResolver = {
    resolveAgentId: () => {
      resolveCount += 1;
      return undefined;
    },
    roleForAgentId: () => "reviewer",
  };

  const attribution = resolveSdkRunBillingAttribution({
    threadId: "thr_attr",
    role: "coder",
    models: [model("coder", "haiku")],
    resolver,
    subagentAgentId: "agent_reviewer",
  });

  expect(resolveCount).toBe(0);
  expect(attribution).toMatchObject({
    billingRole: "reviewer",
    resolvedSubagentId: "agent_reviewer",
    ledgerAgentId: "agent_reviewer",
  });
});

test("resolveSdkRunBillingAttribution falls back to planner agent for planner-only rows", () => {
  const resolver: SdkRunBillingAttributionResolver = {
    resolveAgentId: () => undefined,
    roleForAgentId: () => undefined,
  };

  const attribution = resolveSdkRunBillingAttribution({
    threadId: "thr_attr",
    role: "main",
    models: [model("main", "sonnet"), model(undefined, "sonnet")],
    resolver,
    plannerAgentId: "agent_planner",
  });

  expect(attribution).toEqual({
    billingRole: "main",
    allLedgerRowsArePlanner: true,
    ledgerAgentId: "agent_planner",
  });
});

test("resolveSdkRunBillingAttribution uses registry role for resolved agents", () => {
  const resolver: SdkRunBillingAttributionResolver = {
    resolveAgentId: () => undefined,
    roleForAgentId: () => "main",
  };

  const attribution = resolveSdkRunBillingAttribution({
    threadId: "thr_attr",
    role: "coder",
    models: [model("coder", "haiku")],
    resolver,
    subagentAgentId: "agent_planner_like",
  });

  expect(attribution).toMatchObject({
    billingRole: "main",
    resolvedSubagentId: "agent_planner_like",
    ledgerAgentId: "agent_planner_like",
  });
});

test("resolveSdkRunBillingAttribution leaves non-planner unresolved usage unattributed", () => {
  const resolver: SdkRunBillingAttributionResolver = {
    resolveAgentId: () => undefined,
    roleForAgentId: () => undefined,
  };

  const attribution = resolveSdkRunBillingAttribution({
    threadId: "thr_attr",
    role: "coder",
    models: [model("coder", "haiku")],
    resolver,
    plannerAgentId: "agent_planner",
  });

  expect(attribution).toEqual({
    billingRole: "coder",
    allLedgerRowsArePlanner: false,
  });
});
