import { expect, test } from "bun:test";
import { inferActivityRole } from "@eco/runtime/sdk";
import {
  activityStreamKey,
  resolveActivityAgentId,
  shouldOmitAcpRootActivityAgentId,
} from "../src/main/activity-agent-id";
import type { SubagentMetricsPersistenceStore } from "../src/main/subagent-metrics-persistence";
import { SubagentMetricsRegistry } from "../src/main/subagent-metrics-registry";

test("shouldOmitAcpRootActivityAgentId drops Cursor ACP per-run UUIDs", () => {
  expect(
    shouldOmitAcpRootActivityAgentId({
      coreKind: "acp",
      eventAgentId: "e5c5801d-e0ad-495c-abc3-fdf0fd4645e5",
    }),
  ).toBe(true);
  expect(
    shouldOmitAcpRootActivityAgentId({
      coreKind: "acp",
      eventAgentId: "acp-sub:call_1",
    }),
  ).toBe(false);
  expect(
    shouldOmitAcpRootActivityAgentId({
      coreKind: "acp",
      eventAgentId: "e5c5801d-e0ad-495c-abc3-fdf0fd4645e5",
      parentToolUseId: "call_parent",
    }),
  ).toBe(false);
  expect(
    shouldOmitAcpRootActivityAgentId({
      coreKind: "claude",
      eventAgentId: "e5c5801d-e0ad-495c-abc3-fdf0fd4645e5",
    }),
  ).toBe(false);
});

test("resolveActivityAgentId omits ACP root-turn UUIDs when coreKind is acp", () => {
  expect(
    resolveActivityAgentId(
      "thr_acp",
      {
        type: "message.delta",
        role: "main",
        agentId: "e5c5801d-e0ad-495c-abc3-fdf0fd4645e5",
        payload: { type: "eco_stream", text: "hello" },
      },
      { coreKind: "acp", plannerSessionId: "fba96a72-b0be-42f2-8ac4-419bdda0465e" },
    ),
  ).toBeUndefined();
});

test("resolveActivityAgentId prefers distinct subagent session id", () => {
  const agentId = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "coder",
      agentId: "session_coder_1",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        parent_tool_use_id: "tool_parent_1",
        subagent_type: "coder",
      },
    },
    { plannerSessionId: "session_planner" },
  );
  expect(agentId).toBe("session_coder_1");
});

test("resolveActivityAgentId falls back to parent tool use mapping", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  registry.noteTaskToolUse("thr_1", "toolu_task_1");
  registry.linkToolUseToAgent("thr_1", "toolu_task_1", "agent_coder_a");

  const agentId = resolveActivityAgentId(
    "thr_1",
    {
      type: "message.delta",
      role: "main",
      agentId: "session_planner",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        text: "hi",
        parent_tool_use_id: "toolu_task_1",
        subagent_type: "coder",
      },
    },
    {
      plannerSessionId: "session_planner",
      metricsRegistry: registry,
    },
  );

  expect(agentId).toBe("agent_coder_a");
  expect(
    inferActivityRole({
      type: "message.delta",
      role: "main",
      payload: {
        type: "eco_stream",
        blockKind: "text",
        subagent_type: "coder",
      },
    }),
  ).toBe("coder");
});

test("activityStreamKey isolates parallel subagent streams", () => {
  expect(activityStreamKey("thr_1", "agent_a", "coder")).toBe("thr_1:agent_a");
  expect(activityStreamKey("thr_1", undefined, "coder", "toolu_parent")).toBe("thr_1:parent:toolu_parent");
  expect(activityStreamKey("thr_1", undefined, "main")).toBe("thr_1:main");
  expect(activityStreamKey("thr_1", "agent_a", "coder", undefined, "text:2")).toBe(
    "thr_1:agent_a:block:text:2",
  );
  expect(activityStreamKey("thr_1", undefined, "main", undefined, "message:0", "attempt_1")).toBe(
    "thr_1:main:attempt:attempt_1:block:message:0",
  );
});

const metricsStoreStub: SubagentMetricsPersistenceStore = {
  listSubagentMetrics: () => [],
  upsertSubagentMetrics: () => {},
  clearSubagentMetrics: () => {},
};

test("resolveActivityAgentId requires parent tool use mapping when role-only", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  registry.onSubagentStart("thr_1", { agentId: "agent_coder_solo", role: "coder" });

  const agentId = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "tool",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        subagent_type: "coder",
      },
    },
    { metricsRegistry: registry },
  );

  expect(agentId).toBeUndefined();
});

test("resolveActivityAgentId requires parent mapping for dynamic runtime roles", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  registry.onSubagentStart("thr_1", { agentId: "agent_researcher_solo", role: "researcher" });

  const agentId = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "researcher",
      payload: {
        type: "tool_use",
        tool_name: "WebSearch",
      },
    },
    { metricsRegistry: registry },
  );

  expect(agentId).toBeUndefined();
});

test("resolveActivityAgentId resolves parallel coders via parent tool use", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  registry.noteTaskToolUse("thr_1", "toolu_task_a");
  registry.onSubagentStart("thr_1", {
    agentId: "agent_coder_a",
    role: "coder",
    parentToolUseId: "toolu_task_a",
  });
  registry.noteTaskToolUse("thr_1", "toolu_task_b");
  registry.onSubagentStart("thr_1", {
    agentId: "agent_coder_b",
    role: "coder",
    parentToolUseId: "toolu_task_b",
  });

  const agentA = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "coder",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        parent_tool_use_id: "toolu_task_a",
        subagent_type: "coder",
      },
    },
    { metricsRegistry: registry },
  );
  const agentB = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "coder",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        parent_tool_use_id: "toolu_task_b",
        subagent_type: "coder",
      },
    },
    { metricsRegistry: registry },
  );

  expect(agentA).toBe("agent_coder_a");
  expect(agentB).toBe("agent_coder_b");
});

test("resolveActivityAgentId maps parent tool use when activity role is tool", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  registry.noteTaskToolUse("thr_1", "toolu_task_1");
  registry.linkToolUseToAgent("thr_1", "toolu_task_1", "agent_coder_a");

  const agentId = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "tool",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        parent_tool_use_id: "toolu_task_1",
      },
    },
    { metricsRegistry: registry },
  );

  expect(agentId).toBe("agent_coder_a");
});

test("resolveActivityAgentId accepts SDK general-purpose billing role", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  registry.noteTaskToolUse("thr_1", "toolu_task_gp", "general-purpose");
  registry.linkToolUseToAgent("thr_1", "toolu_task_gp", "agent_gp_1");

  const agentId = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "general-purpose",
      payload: {
        type: "tool_use",
        tool_name: "Read",
        parent_tool_use_id: "toolu_task_gp",
        subagent_type: "general-purpose",
      },
    },
    { metricsRegistry: registry },
  );

  expect(agentId).toBe("agent_gp_1");
});

test("resolveActivityAgentId accepts distinct session id registered in metrics", () => {
  const registry = new SubagentMetricsRegistry(metricsStoreStub);
  registry.onSubagentStart("thr_1", { agentId: "agent_coder_solo", role: "coder" });

  const agentId = resolveActivityAgentId(
    "thr_1",
    {
      type: "tool.started",
      role: "tool",
      agentId: "agent_coder_solo",
      payload: {
        type: "tool_use",
        tool_name: "Read",
      },
    },
    { plannerSessionId: "session_planner", metricsRegistry: registry },
  );

  expect(agentId).toBe("agent_coder_solo");
});
