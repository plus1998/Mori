import { expect, test } from "bun:test";
import { computeRequestBilling, type ParsedUsage } from "@eco/runtime";
import { projectBillingFromUsageLedger } from "../src/main/billing-projector";
import type { AgentInstanceRecord } from "../src/main/usage-ledger";
import { buildSdkUsageLedgerEvents, buildSingleUsageLedgerEvent } from "../src/main/usage-ledger-adapters";

const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };

function billingFor(usage: ParsedUsage, actualRates = haikuRates) {
  return computeRequestBilling(usage, actualRates, sonnetRates);
}

test("projectBillingFromUsageLedger builds SDK primary without duplicating request total cost", () => {
  const sonnetUsage = {
    inputTokens: 10_000,
    outputTokens: 1_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const haikuUsage = { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const events = buildSdkUsageLedgerEvents({
    threadId: "thr_projector",
    role: "main",
    requestKey: "sdk-result:multi",
    totalCostUsd: 0.19,
    models: [
      {
        role: "main",
        modelId: "sonnet",
        usage: sonnetUsage,
        computedBilling: billingFor(sonnetUsage, sonnetRates),
      },
      {
        role: "coder",
        modelId: "haiku",
        usage: haikuUsage,
        computedBilling: billingFor(haikuUsage, haikuRates),
      },
    ],
  });

  const projection = projectBillingFromUsageLedger({ events, plannerModelLabel: "sonnet" });

  expect(projection.snapshot?.primarySource).toBe("sdk");
  expect(projection.snapshot?.totalTokens.input).toBe(30_000);
  expect(projection.snapshot?.sourceBreakdown?.sdk?.reportedCostUsd).toBe(0.19);
  expect(projection.snapshot?.byRole?.coder?.inputTokens).toBe(20_000);
  expect(projection.snapshot?.byModel?.map((entry) => entry.modelId).sort()).toEqual(["haiku", "sonnet"]);
  expect(projection.snapshot?.ecoCostUsd).toBeCloseTo(0.069, 4);
  expect(projection.snapshot?.plannerTokenCostUsd).toBeCloseTo(0.135, 4);
});

test("projectBillingFromUsageLedger projects agent subagent and run attempt totals", () => {
  const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const events = [
    buildSingleUsageLedgerEvent({
      threadId: "thr_projector",
      role: "coder",
      source: "proxy",
      sourceEventId: "proxy:coder:req_1",
      requestKey: "proxy:coder:req_1",
      usage,
      computedBilling: billingFor(usage),
      runAttemptId: "attempt_1",
      agentId: "agent_coder",
      parentToolUseId: "toolu_parent",
      modelId: "haiku",
      reportedCostUsd: 0.02,
    }),
  ];
  const agents: AgentInstanceRecord[] = [
    {
      threadId: "thr_projector",
      agentId: "agent_coder",
      role: "coder",
      kind: "subagent",
      status: "stopped",
      runAttemptId: "attempt_1",
      parentAgentId: "main:attempt_1",
      parentToolUseId: "toolu_parent",
      missionKey: "implement",
      todoId: "todo-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  ];

  const projection = projectBillingFromUsageLedger({ events, agents });

  expect(projection.byAgent.agent_coder?.inputTokens).toBe(10_000);
  expect(projection.byAgent.agent_coder?.parentToolUseId).toBe("toolu_parent");
  expect(projection.byAgent.agent_coder?.reportedCostUsd).toBe(0.02);
  expect(projection.byRunAttempt.attempt_1?.inputTokens).toBe(10_000);
  expect(projection.byRunAttempt.attempt_1?.reportedCostUsd).toBe(0.02);
  expect(projection.snapshot?.subagents?.[0]?.agentId).toBe("agent_coder");
  expect(projection.snapshot?.subagents?.[0]?.status).toBe("stopped");
  expect(projection.snapshot?.subagents?.[0]?.modelId).toBe("haiku");
});

test("projectBillingFromUsageLedger preserves existing subagent contextOccupied", () => {
  const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const events = [
    buildSingleUsageLedgerEvent({
      threadId: "thr_projector",
      role: "coder",
      source: "proxy",
      sourceEventId: "proxy:coder:req_1",
      requestKey: "proxy:coder:req_1",
      usage,
      computedBilling: billingFor(usage),
      runAttemptId: "attempt_1",
      agentId: "agent_coder",
      parentToolUseId: "toolu_parent",
      modelId: "haiku",
    }),
  ];
  const agents: AgentInstanceRecord[] = [
    {
      threadId: "thr_projector",
      agentId: "agent_coder",
      role: "coder",
      kind: "subagent",
      status: "stopped",
      runAttemptId: "attempt_1",
      parentAgentId: "main:attempt_1",
      parentToolUseId: "toolu_parent",
      missionKey: "implement",
      todoId: "todo-1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  ];

  const projection = projectBillingFromUsageLedger({
    events,
    agents,
    existingSubagentContextByAgentId: new Map([["agent_coder", 114_000]]),
  });

  expect(projection.snapshot?.subagents?.[0]?.contextOccupied).toBe(114_000);
});

test("projectBillingFromUsageLedger does not invent window occupancy from billing totals", () => {
  const usage = {
    inputTokens: 232_248,
    outputTokens: 1_000,
    cacheReadTokens: 4_157_952,
    cacheCreationTokens: 0,
  };
  const events = [
    buildSingleUsageLedgerEvent({
      threadId: "thr_projector",
      role: "explore",
      source: "proxy",
      sourceEventId: "proxy:explore:req_1",
      requestKey: "proxy:explore:req_1",
      usage,
      computedBilling: billingFor(usage),
      agentId: "agent_explore",
      modelId: "deepseek",
    }),
  ];
  const agents: AgentInstanceRecord[] = [
    {
      threadId: "thr_projector",
      agentId: "agent_explore",
      role: "explore",
      kind: "subagent",
      status: "active",
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  ];

  const projection = projectBillingFromUsageLedger({ events, agents });
  expect(projection.snapshot?.subagents?.[0]?.contextOccupied).toBe(0);
  expect(projection.snapshot?.subagents?.[0]?.inputTokens).toBe(232_248);
  expect(projection.snapshot?.subagents?.[0]?.cacheReadTokens).toBe(4_157_952);
});

test("projectBillingFromUsageLedger preserves dynamic orchestration roles", () => {
  const usage = { inputTokens: 12_000, outputTokens: 1_200, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const events = [
    buildSingleUsageLedgerEvent({
      threadId: "thr_projector",
      role: "researcher",
      source: "sdk",
      sourceEventId: "sdk:researcher:req_1",
      requestKey: "sdk:researcher:req_1",
      usage,
      computedBilling: billingFor(usage),
      agentId: "agent_researcher",
      modelId: "research-model",
    }),
  ];
  const agents: AgentInstanceRecord[] = [
    {
      threadId: "thr_projector",
      agentId: "agent_researcher",
      role: "researcher",
      kind: "subagent",
      status: "stopped",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
  ];

  const projection = projectBillingFromUsageLedger({ events, agents });

  expect(projection.snapshot?.byRole?.researcher?.inputTokens).toBe(12_000);
  expect(projection.snapshot?.byModel?.[0]?.roles).toEqual(["researcher"]);
  expect(projection.snapshot?.subagents?.[0]).toMatchObject({
    agentId: "agent_researcher",
    role: "researcher",
    modelId: "research-model",
  });
});

test("projectBillingFromUsageLedger exposes unattributed unresolved usage", () => {
  const event = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "coder",
    source: "sdk",
    sourceEventId: "sdk:unattributed",
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
    modelId: "unknown-model",
  });

  const projection = projectBillingFromUsageLedger({ events: [event] });

  expect(projection.unattributedEvents).toHaveLength(1);
  expect(projection.unresolvedEventCount).toBe(1);
  expect(projection.snapshot?.pricingResolved).toBe(false);
  expect(projection.snapshot?.ecoCostUsd).toBe(0);
});

test("projectBillingFromUsageLedger can compute billing with a rate resolver", () => {
  const event = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "coder",
    source: "proxy",
    sourceEventId: "proxy:resolver",
    usage: { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    modelId: "haiku",
    agentId: "agent_coder",
  });

  const projection = projectBillingFromUsageLedger({
    events: [event],
    resolveRates: () => ({ actualRates: haikuRates, plannerRates: sonnetRates }),
  });

  expect(projection.unresolvedEventCount).toBe(0);
  expect(projection.snapshot?.ecoCostUsd).toBeCloseTo(0.012, 4);
  expect(projection.snapshot?.plannerTokenCostUsd).toBeCloseTo(0.045, 4);
});

test("projectBillingFromUsageLedger keeps partial and context events out of billable totals", () => {
  const partial = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "coder",
    source: "sdk",
    sourceEventId: "sdk-stream:partial-1",
    usageKind: "request_partial",
    usage: { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    computedBilling: billingFor({
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }),
    agentId: "agent_coder",
    modelId: "haiku",
  });
  const context = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "main",
    source: "sdk",
    sourceEventId: "compact:1",
    usageKind: "context",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    agentId: "planner_1",
  });

  const projection = projectBillingFromUsageLedger({ events: [partial, context] });

  expect(projection.snapshot).toBeUndefined();
  expect(projection.unsettledPartialEvents).toEqual([partial]);
  expect(projection.contextEvents).toEqual([context]);
  expect(projection.byAgent).toEqual({});
});

test("projectBillingFromUsageLedger prefers proxy primary when proxy events exist", () => {
  const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const proxyEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "coder",
    source: "proxy",
    sourceEventId: "proxy:coder:req_1",
    requestKey: "proxy:coder:req_1",
    usage,
    computedBilling: billingFor(usage),
    modelId: "haiku",
  });
  const sdkEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "coder",
    source: "sdk",
    sourceEventId: "sdk-assistant:msg_1",
    usageKind: "assistant_fallback",
    usage,
    computedBilling: billingFor(usage),
    sdkMessageId: "msg_1",
    modelId: "haiku",
  });

  const projection = projectBillingFromUsageLedger({ events: [proxyEvent, sdkEvent] });

  expect(projection.snapshot?.primarySource).toBe("proxy");
  expect(projection.snapshot?.totalTokens.input).toBe(10_000);
  expect(projection.snapshot?.sourceBreakdown?.sdk).toBeUndefined();
});

test("projectBillingFromUsageLedger does not let a vision-only proxy source replace SDK primary", () => {
  const visionUsage = {
    inputTokens: 147_000,
    outputTokens: 2_000,
    cacheReadTokens: 4_000,
    cacheCreationTokens: 0,
  };
  const mainUsage = { inputTokens: 403, outputTokens: 347, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const visionEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_projector_vision",
    role: "vision",
    source: "proxy",
    sourceEventId: "proxy:vision:req_1",
    requestKey: "proxy:vision:req_1",
    usage: visionUsage,
    computedBilling: billingFor(visionUsage),
    modelId: "gpt-5.6-sol",
  });
  const sdkEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_projector_vision",
    role: "main",
    source: "sdk",
    sourceEventId: "sdk-result:req_1",
    requestKey: "sdk-result:req_1",
    usage: mainUsage,
    computedBilling: billingFor(mainUsage),
    modelId: "gpt-5.6-sol",
  });

  const projection = projectBillingFromUsageLedger({ events: [visionEvent, sdkEvent] });

  expect(projection.snapshot?.primarySource).toBe("sdk");
  expect(projection.snapshot?.totalTokens.input).toBe(mainUsage.inputTokens);
  expect(projection.snapshot?.sourceBreakdown?.proxy?.byRole?.vision?.inputTokens).toBe(
    visionUsage.inputTokens,
  );
});

test("projectBillingFromUsageLedger skips duplicate sdk totals when proxy already billable", () => {
  const usage = { inputTokens: 5_000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const proxyEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "coder",
    source: "proxy",
    sourceEventId: "proxy:coder:req_dup",
    requestKey: "proxy:coder:req_dup",
    providerRequestId: "req_dup",
    usage,
    computedBilling: billingFor(usage),
    agentId: "agent_coder",
    modelId: "haiku",
  });
  const sdkEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_projector",
    role: "coder",
    source: "sdk",
    sourceEventId: "sdk-result:evt_dup",
    requestKey: "sdk-result:evt_dup",
    usage,
    computedBilling: billingFor(usage),
    agentId: "agent_coder",
    modelId: "haiku",
  });

  const projection = projectBillingFromUsageLedger({ events: [proxyEvent, sdkEvent] });

  expect(projection.snapshot?.primarySource).toBe("proxy");
  expect(projection.snapshot?.totalTokens.input).toBe(5_000);
  expect(projection.snapshot?.byRole?.coder?.inputTokens).toBe(5_000);
});

test("projectBillingFromUsageLedger counts a duplicate same-source billable row once", () => {
  const usage = { inputTokens: 3_177, outputTokens: 281, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const makePiEvent = (sourceEventId: string) =>
    buildSingleUsageLedgerEvent({
      threadId: "thr_pi_dup",
      role: "main",
      source: "pi",
      sourceEventId,
      requestKey: "usage:main:3177:281:0:0:eco-planner-abc",
      usage,
      computedBilling: billingFor(usage),
      agentId: "main:attempt_1",
      modelId: "qwen",
    });
  const first = makePiEvent("thr_pi_dup:pi:289:usage");
  const duplicate = makePiEvent("thr_pi_dup:pi:291:usage");

  const projection = projectBillingFromUsageLedger({ events: [first, duplicate] });

  expect(projection.snapshot?.primarySource).toBe("pi");
  expect(projection.snapshot?.totalTokens.input).toBe(3_177);
  expect(projection.snapshot?.totalTokens.output).toBe(281);
  expect(projection.snapshot?.byRole?.main?.outputTokens).toBe(281);
});

test("projectBillingFromUsageLedger keeps distinct calls that happen to share tokens when sources differ", () => {
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const piEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_mix",
    role: "main",
    source: "pi",
    sourceEventId: "evt_pi",
    requestKey: "usage:main:100:10:0:0:eco-planner-abc",
    usage,
    computedBilling: billingFor(usage),
    agentId: "main:attempt_1",
    modelId: "qwen",
  });
  const proxyEvent = buildSingleUsageLedgerEvent({
    threadId: "thr_mix",
    role: "main",
    source: "proxy",
    sourceEventId: "proxy:main:qwen:resp_1",
    requestKey: "proxy:main:qwen:resp_1:100:10:0:0",
    providerRequestId: "resp_1",
    usage,
    computedBilling: billingFor(usage),
    agentId: "main:attempt_2",
    modelId: "qwen",
  });

  const projection = projectBillingFromUsageLedger({ events: [piEvent, proxyEvent] });

  // Both sources bill; primary is pi, and the distinct proxy row is not dropped.
  expect(projection.snapshot?.totalTokens.input).toBe(100);
  expect(projection.snapshot?.sourceBreakdown?.pi?.totalTokens.input).toBe(100);
  expect(projection.snapshot?.sourceBreakdown?.proxy?.totalTokens.input).toBe(100);
});
