import { expect, test } from "bun:test";
import { parseSdkUsageBilling } from "@eco/runtime";
import {
  buildAssistantUsageRequestKey,
  buildUsageSnapshotForRole,
  isSdkIncrementalStreamUsage,
  isSubagentBillingRole,
  sdkPayloadHasModelUsage,
  shouldBillAssistantSubagentUsage,
  shouldUpdateContextFromUsageSource,
} from "../src/main/billing-orchestration";
import type { ContextMonitorSnapshot } from "../src/main/context-window-monitor";
import { buildUsageRequestKey, ThreadUsageAccumulator } from "../src/main/thread-usage-accumulator";

test("isSubagentBillingRole accepts dynamic runtime agents and excludes non-agent roles", () => {
  expect(isSubagentBillingRole("coder")).toBe(true);
  expect(isSubagentBillingRole("researcher")).toBe(true);
  expect(isSubagentBillingRole("source_verifier")).toBe(true);
  expect(isSubagentBillingRole("main")).toBe(false);
  expect(isSubagentBillingRole("system")).toBe(false);
  expect(isSubagentBillingRole("tool")).toBe(false);
  expect(isSubagentBillingRole("bad role")).toBe(false);
});

test("isSdkIncrementalStreamUsage detects message_delta style payloads", () => {
  const payload = { usage: { input_tokens: 10, output_tokens: 5 } };
  const bundle = parseSdkUsageBilling(payload);
  expect(bundle?.authoritative).toBe(true);
  expect(isSdkIncrementalStreamUsage(true, payload)).toBe(true);
  expect(sdkPayloadHasModelUsage(payload)).toBe(false);
});

test("isSdkIncrementalStreamUsage is false for SDK result modelUsage", () => {
  const payload = {
    total_cost_usd: 0.5,
    usage: { input_tokens: 100, output_tokens: 50 },
    modelUsage: { "claude-opus-4": { inputTokens: 100, outputTokens: 50 } },
  };
  expect(isSdkIncrementalStreamUsage(true, payload)).toBe(false);
  expect(sdkPayloadHasModelUsage(payload)).toBe(true);
});

test("shouldBillAssistantSubagentUsage requires subagent role and no matching authoritative usage", () => {
  expect(
    shouldBillAssistantSubagentUsage({
      role: "coder",
      messageId: "msg_1",
      agentId: "agent_coder",
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  ).toBe(true);
  expect(
    shouldBillAssistantSubagentUsage({
      role: "coder",
      messageId: "msg_1",
      agentId: "agent_coder",
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      observedAuthoritativeUsage: [
        {
          source: "proxy",
          role: "coder",
          agentId: "agent_coder",
          usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
        },
      ],
    }),
  ).toBe(false);
  expect(
    shouldBillAssistantSubagentUsage({
      role: "researcher",
      messageId: "msg_2",
      agentId: "agent_researcher",
      usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
  ).toBe(true);
  expect(
    shouldBillAssistantSubagentUsage({
      role: "main",
      messageId: "msg_1",
      agentId: "main",
    }),
  ).toBe(false);
});

test("assistant fallback is not blocked by unrelated or unattributed authoritative usage", () => {
  const usage = { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

  expect(
    shouldBillAssistantSubagentUsage({
      role: "explore",
      messageId: "msg_explore_1",
      agentId: "agent_explore",
      usage,
      observedAuthoritativeUsage: [
        {
          source: "sdk",
          role: "coder",
          agentId: "agent_coder",
          usage,
        },
      ],
    }),
  ).toBe(true);

  expect(
    shouldBillAssistantSubagentUsage({
      role: "explore",
      messageId: "msg_explore_1",
      agentId: "agent_explore",
      usage,
      observedAuthoritativeUsage: [
        {
          source: "sdk",
          role: "explore",
          usage,
        },
      ],
    }),
  ).toBe(true);
});

test("buildUsageRequestKey includes dedupId to avoid token fingerprint collisions", () => {
  const base = {
    role: "coder",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelId: "haiku",
  };
  expect(buildUsageRequestKey(base)).not.toBe(buildUsageRequestKey({ ...base, dedupId: "1" }));
});

test("buildAssistantUsageRequestKey is stable per message", () => {
  expect(buildAssistantUsageRequestKey("msg_abc")).toBe("sdk-assistant:msg_abc");
});

test("shouldUpdateContextFromUsageSource accepts SDK and proxy subagent usage", () => {
  expect(shouldUpdateContextFromUsageSource("sdk")).toBe(true);
  expect(shouldUpdateContextFromUsageSource("sdk", "main")).toBe(true);
  expect(shouldUpdateContextFromUsageSource("proxy", "explore")).toBe(true);
  expect(shouldUpdateContextFromUsageSource("proxy", "researcher")).toBe(true);
  expect(shouldUpdateContextFromUsageSource("proxy", "main")).toBe(true);
  expect(shouldUpdateContextFromUsageSource("proxy")).toBe(false);
});

test("buildUsageSnapshotForRole uses the matching role window instead of display occupancy", () => {
  const monitorSnap: ContextMonitorSnapshot = {
    occupied: 90_000,
    limit: 100_000,
    ratio: 0.9,
    occupancyPct: 90,
    limitsResolved: true,
    displayRole: "main",
    roles: [
      {
        role: "main",
        occupied: 90_000,
        limit: 100_000,
        ratio: 0.9,
        occupancyPct: 90,
        limitsResolved: true,
      },
      {
        role: "explore",
        occupied: 15_000,
        limit: 40_000,
        ratio: 0.375,
        occupancyPct: 38,
        limitsResolved: true,
      },
    ],
  };

  const snapshot = buildUsageSnapshotForRole({
    role: "explore",
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 2000, cacheCreationTokens: 0 },
    monitorSnap,
    fallbackContext: "estimate",
  });

  expect(snapshot.contextTokens).toBe(15_000);
  expect(snapshot.contextLimit).toBe(40_000);
  expect(snapshot.occupancyPct).toBe(38);
});

test("buildUsageSnapshotForRole can suppress aggregate SDK context fallback", () => {
  const snapshot = buildUsageSnapshotForRole({
    role: "main",
    usage: { inputTokens: 20_000, outputTokens: 1000, cacheReadTokens: 30_000, cacheCreationTokens: 0 },
    fallbackContext: "none",
  });

  expect(snapshot.contextTokens).toBe(0);
  expect(snapshot.contextLimit).toBeUndefined();
});

test("SDK incremental billing attributes subagent role separately from planner", () => {
  const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };
  const accumulator = new ThreadUsageAccumulator();
  const delta = { inputTokens: 50_000, outputTokens: 5_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

  accumulator.recordUsage({
    threadId: "t1",
    role: "main",
    delta: { inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0 },
    sourceReportedCostUsd: 0.5,
    actualRates: sonnetRates,
    plannerRates: sonnetRates,
    requestKey: buildUsageRequestKey({
      role: "main",
      inputTokens: 10_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      dedupId: "1",
    }),
  });

  accumulator.recordUsage({
    threadId: "t1",
    role: "coder",
    delta,
    sourceReportedCostUsd: 2.1,
    actualRates: haikuRates,
    plannerRates: sonnetRates,
    modelId: "haiku",
    requestKey: buildUsageRequestKey({
      role: "coder",
      inputTokens: delta.inputTokens,
      outputTokens: delta.outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelId: "haiku",
      dedupId: "2",
    }),
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.sourceReportedCostUsd).toBeCloseTo(2.6);
  expect(billing?.byRole?.main?.inputTokens).toBe(10_000);
  expect(billing?.byRole?.coder?.inputTokens).toBe(50_000);
  expect(billing?.ecoCostUsd).toBeGreaterThan(billing?.byRole?.main?.ecoCostUsd ?? 0);
});

test("proxy and SDK result tokens stay separate without doubling headline totals", () => {
  const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const accumulator = new ThreadUsageAccumulator();
  const proxyDelta = {
    inputTokens: 100_000,
    outputTokens: 10_000,
    cacheReadTokens: 800_000,
    cacheCreationTokens: 0,
  };

  accumulator.recordUsage({
    threadId: "t1",
    role: "coder",
    source: "proxy",
    delta: proxyDelta,
    actualRates: sonnetRates,
    plannerRates: sonnetRates,
    requestKey: "proxy:coder:100000:10000:800000:0:haiku:1",
  });

  const before = accumulator.getSnapshot("t1");
  expect(before?.totalTokens.input).toBe(100_000);

  accumulator.recordRunUsage({
    threadId: "t1",
    role: "main",
    requestKey: "sdk-result:run-1",
    models: [
      {
        role: "main",
        modelId: "claude-opus-4",
        usage: proxyDelta,
        actualRates: sonnetRates,
        plannerRates: sonnetRates,
      },
    ],
    sourceReportedCostUsd: 3.5,
  });

  const after = accumulator.getSnapshot("t1");
  expect(after?.primarySource).toBe("proxy");
  expect(after?.totalTokens.input).toBe(100_000);
  expect(after?.sourceBreakdown?.proxy?.totalTokens.input).toBe(100_000);
  expect(after?.sourceBreakdown?.sdk?.totalTokens.input).toBe(100_000);
});

test("assistant subagent fallback bills when authoritative SDK usage is missing", () => {
  const sonnetRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const haikuRates = { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 };
  const accumulator = new ThreadUsageAccumulator();
  const delta = { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheCreationTokens: 0 };

  if (
    !shouldBillAssistantSubagentUsage({
      role: "explore",
      messageId: "msg_explore_1",
      agentId: "agent_explore",
      usage: delta,
    })
  ) {
    expect.fail("expected assistant fallback eligibility");
  }

  accumulator.recordUsage({
    threadId: "t1",
    role: "explore",
    delta,
    actualRates: haikuRates,
    plannerRates: sonnetRates,
    modelId: "haiku",
    requestKey: buildAssistantUsageRequestKey("msg_explore_1"),
  });

  const billing = accumulator.getSnapshot("t1");
  expect(billing?.byRole?.explore?.inputTokens).toBe(20_000);
  expect(billing?.byRole?.main).toBeUndefined();
});
