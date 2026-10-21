import { expect, test } from "bun:test";
import { resolveBashApprovalAgentId } from "../src/main/bash-approval-agent-id";
import type { RuntimeAgentRole } from "../src/shared/ipc";

function deps(input: {
  plannerAgentId?: string;
  roles?: Record<string, RuntimeAgentRole>;
  resolveSubagentId?: (
    threadId: string,
    input: { role: RuntimeAgentRole; subagentAgentId?: string },
  ) => string | undefined;
}) {
  return {
    plannerAgentId: input.plannerAgentId,
    roleForAgentId: (_threadId: string, agentId: string) => input.roles?.[agentId],
    resolveSubagentId: input.resolveSubagentId ?? ((_threadId, _input) => undefined),
  };
}

test("resolveBashApprovalAgentId returns planner agent id for main-thread bash", () => {
  expect(
    resolveBashApprovalAgentId(
      "thr_1",
      { toolName: "Bash", input: {}, toolUseId: "toolu_1", signal: new AbortController().signal },
      deps({ plannerAgentId: "main:attempt_execution_0" }),
    ),
  ).toBe("main:attempt_execution_0");
});

test("resolveBashApprovalAgentId returns registered subagent instance id", () => {
  expect(
    resolveBashApprovalAgentId(
      "thr_1",
      {
        toolName: "Bash",
        input: {},
        toolUseId: "toolu_1",
        agentId: "agent_coder_a",
        agentType: "coder",
        signal: new AbortController().signal,
      },
      deps({
        plannerAgentId: "main:attempt_execution_0",
        roles: { agent_coder_a: "coder" },
      }),
    ),
  ).toBe("agent_coder_a");
});

test("resolveBashApprovalAgentId resolves subagent session id via registry", () => {
  expect(
    resolveBashApprovalAgentId(
      "thr_1",
      {
        toolName: "Bash",
        input: {},
        toolUseId: "toolu_1",
        agentId: "sdk_session_coder",
        agentType: "coder",
        signal: new AbortController().signal,
      },
      deps({
        plannerAgentId: "main:attempt_execution_0",
        resolveSubagentId: (_threadId, input) =>
          input.subagentAgentId === "sdk_session_coder" ? "agent_coder_a" : undefined,
      }),
    ),
  ).toBe("agent_coder_a");
});

test("resolveBashApprovalAgentId returns undefined when subagent attribution fails", () => {
  expect(
    resolveBashApprovalAgentId(
      "thr_1",
      {
        toolName: "Bash",
        input: {},
        toolUseId: "toolu_1",
        agentId: "sdk_session_coder",
        agentType: "coder",
        signal: new AbortController().signal,
      },
      deps({ plannerAgentId: "main:attempt_execution_0" }),
    ),
  ).toBeUndefined();
});
