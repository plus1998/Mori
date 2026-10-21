import { expect, test } from "bun:test";
import type { SubagentMetricsPersistenceStore } from "../src/main/subagent-metrics-persistence";
import { SubagentMetricsRegistry } from "../src/main/subagent-metrics-registry";
import { resolveSdkLateBindAttribution } from "../src/main/thread-live-request-coordinator";

const metricsStoreStub: SubagentMetricsPersistenceStore = {
  listSubagentMetrics: () => [],
  upsertSubagentMetrics: () => {},
  clearSubagentMetrics: () => {},
};

test("main planner late-bind uses exact session id when parent_tool_use_id absent", () => {
  const attribution = resolveSdkLateBindAttribution(
    "thr_main",
    {
      type: "usage.recorded",
      role: "main",
      agentId: "session_planner_1",
      payload: { request_id: "req_main" },
    },
    { plannerSessionId: "session_planner_1" },
  );
  expect(attribution).toEqual({ agentId: "session_planner_1", role: "main" });
});

test("main planner late-bind rejected when parent_tool_use_id present", () => {
  expect(
    resolveSdkLateBindAttribution(
      "thr_main",
      {
        type: "usage.recorded",
        role: "main",
        agentId: "session_planner_1",
        payload: { request_id: "req_main", parent_tool_use_id: "toolu_parent" },
      },
      { plannerSessionId: "session_planner_1" },
    ),
  ).toBeUndefined();
});

test("subagent late-bind resolves via parentToolUseId metrics link", () => {
  const metrics = new SubagentMetricsRegistry(metricsStoreStub);
  const threadId = "thr_sub";
  metrics.noteTaskToolUse(threadId, "toolu_parent", "coder");
  metrics.onSubagentStart(threadId, {
    agentId: "agent_sub_1",
    role: "coder",
    parentToolUseId: "toolu_parent",
  });

  const attribution = resolveSdkLateBindAttribution(
    threadId,
    {
      type: "message.delta",
      role: "coder",
      agentId: "session_planner_1",
      payload: { request_id: "req_sub", parent_tool_use_id: "toolu_parent" },
    },
    { plannerSessionId: "session_planner_1", metricsRegistry: metrics },
  );
  expect(attribution).toEqual({ agentId: "agent_sub_1", role: "coder" });
});

test("planner session id alone without exact main markers does not bind subagent", () => {
  expect(
    resolveSdkLateBindAttribution(
      "thr_ambiguous",
      {
        type: "usage.recorded",
        role: "coder",
        agentId: "session_planner_1",
        payload: { request_id: "req_x", parent_tool_use_id: "toolu_missing" },
      },
      { plannerSessionId: "session_planner_1" },
    ),
  ).toBeUndefined();
});
