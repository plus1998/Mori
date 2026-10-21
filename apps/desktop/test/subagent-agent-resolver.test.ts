import { expect, test } from "bun:test";
import { resolveSubagentAgentId } from "../src/main/subagent-agent-resolver";

test("resolveSubagentAgentId prefers explicit agent id", () => {
  expect(
    resolveSubagentAgentId({
      role: "main",
      explicitAgentId: " agent_explicit ",
      linkedParentAgentId: "agent_parent",
      hasThreadState: false,
    }),
  ).toEqual({ agentId: "agent_explicit" });
});

test("resolveSubagentAgentId maps linked parent tool use before role checks", () => {
  expect(
    resolveSubagentAgentId({
      role: "main",
      parentToolUseId: "toolu_task",
      linkedParentAgentId: "agent_explore",
      hasThreadState: true,
    }),
  ).toEqual({ agentId: "agent_explore" });
});

test("resolveSubagentAgentId skips non-subagent roles without a parent link", () => {
  expect(
    resolveSubagentAgentId({
      role: "main",
      hasThreadState: true,
      activeAgentIds: ["agent_planner_like"],
    }),
  ).toEqual({});
});

test("resolveSubagentAgentId reports missing thread state", () => {
  expect(
    resolveSubagentAgentId({
      role: "coder",
      hasThreadState: false,
    }),
  ).toEqual({ missReason: "no_thread_state", activeAgentIds: [] });
});

test("resolveSubagentAgentId refuses role-only sole active fallback", () => {
  expect(
    resolveSubagentAgentId({
      role: "coder",
      hasThreadState: true,
      activeAgentIds: ["agent_coder_a"],
    }),
  ).toEqual({
    missReason: "missing_structured_agent_id",
    activeAgentIds: ["agent_coder_a"],
  });
});

test("resolveSubagentAgentId refuses role-only multiple active fallback", () => {
  expect(
    resolveSubagentAgentId({
      role: "coder",
      hasThreadState: true,
      activeAgentIds: ["agent_coder_a", "agent_coder_b"],
    }),
  ).toEqual({
    missReason: "missing_structured_agent_id",
    activeAgentIds: ["agent_coder_a", "agent_coder_b"],
  });
});

test("resolveSubagentAgentId treats an unmapped parent with multiple active agents as parent miss", () => {
  expect(
    resolveSubagentAgentId({
      role: "coder",
      parentToolUseId: "toolu_task",
      hasThreadState: true,
      activeAgentIds: ["agent_coder_a", "agent_coder_b"],
    }),
  ).toEqual({
    missReason: "parent_tool_use_unmapped",
    activeAgentIds: ["agent_coder_a", "agent_coder_b"],
  });
});

test("resolveSubagentAgentId reports missing structured id when no parent is available", () => {
  expect(
    resolveSubagentAgentId({
      role: "tester",
      hasThreadState: true,
      activeAgentIds: [],
    }),
  ).toEqual({ missReason: "missing_structured_agent_id", activeAgentIds: [] });
});
