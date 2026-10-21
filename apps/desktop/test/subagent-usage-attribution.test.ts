import { expect, test } from "bun:test";
import {
  resolveSubagentUsageAttribution,
  type SubagentUsageAttributionResolver,
} from "../src/main/subagent-usage-attribution";
import type { AgentRole } from "../src/shared/ipc";

function resolver(
  input: {
    resolve?: (role: AgentRole, subagentAgentId?: string, parentToolUseId?: string) => string | undefined;
    roleFor?: (agentId: string) => AgentRole | undefined;
    calls?: Array<{ role: AgentRole; subagentAgentId?: string; parentToolUseId?: string }>;
  } = {},
): SubagentUsageAttributionResolver {
  return {
    resolveAgentId: (_threadId, request) => {
      input.calls?.push(request);
      return input.resolve?.(request.role, request.subagentAgentId, request.parentToolUseId);
    },
    roleForAgentId: (_threadId, agentId) => input.roleFor?.(agentId),
  };
}

test("resolveSubagentUsageAttribution skips planner without explicit subagent context", () => {
  const calls: Array<{ role: AgentRole; subagentAgentId?: string; parentToolUseId?: string }> = [];

  const attribution = resolveSubagentUsageAttribution({
    threadId: "thr_attr",
    role: "main",
    resolver: resolver({ calls }),
  });

  expect(calls).toEqual([]);
  expect(attribution).toEqual({ billingRole: "main", attempted: false });
});

test("resolveSubagentUsageAttribution resolves subagent billing role by role", () => {
  const calls: Array<{ role: AgentRole; subagentAgentId?: string; parentToolUseId?: string }> = [];

  const attribution = resolveSubagentUsageAttribution({
    threadId: "thr_attr",
    role: "coder",
    resolver: resolver({
      calls,
      resolve: () => "agent_coder",
      roleFor: () => "coder",
    }),
  });

  expect(calls).toEqual([{ role: "coder" }]);
  expect(attribution).toEqual({
    billingRole: "coder",
    attempted: true,
    subagentAgentId: "agent_coder",
  });
});

test("resolveSubagentUsageAttribution lets explicit subagent context resolve from planner events", () => {
  const calls: Array<{ role: AgentRole; subagentAgentId?: string; parentToolUseId?: string }> = [];

  const attribution = resolveSubagentUsageAttribution({
    threadId: "thr_attr",
    role: "main",
    resolver: resolver({
      calls,
      resolve: (_role, subagentAgentId) => subagentAgentId,
      roleFor: () => "reviewer",
    }),
    explicitSubagentId: "agent_reviewer",
  });

  expect(calls).toEqual([]);
  expect(attribution).toEqual({
    billingRole: "reviewer",
    attempted: true,
    subagentAgentId: "agent_reviewer",
  });
});

test("resolveSubagentUsageAttribution resolves parent tool use before role fallback", () => {
  const attribution = resolveSubagentUsageAttribution({
    threadId: "thr_attr",
    role: "main",
    resolver: resolver({
      resolve: (_role, _subagentAgentId, parentToolUseId) =>
        parentToolUseId === "tool_parent" ? "agent_architect" : undefined,
      roleFor: () => "architect",
    }),
    parentToolUseId: "tool_parent",
  });

  expect(attribution).toEqual({
    billingRole: "architect",
    attempted: true,
    subagentAgentId: "agent_architect",
  });
});

test("resolveSubagentUsageAttribution applies registry role for resolved agents", () => {
  const attribution = resolveSubagentUsageAttribution({
    threadId: "thr_attr",
    role: "coder",
    resolver: resolver({
      resolve: () => "agent_planner_like",
      roleFor: () => "main",
    }),
  });

  expect(attribution).toEqual({
    billingRole: "main",
    attempted: true,
    subagentAgentId: "agent_planner_like",
  });
});

test("resolveSubagentUsageAttribution keeps unresolved subagent usage explicit", () => {
  const attribution = resolveSubagentUsageAttribution({
    threadId: "thr_attr",
    role: "coder",
    resolver: resolver(),
  });

  expect(attribution).toEqual({
    billingRole: "coder",
    attempted: true,
  });
});
