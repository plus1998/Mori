import { expect, test } from "bun:test";
import {
  buildForcedPlanDelegationContract,
  buildForcedPlanDelegationTask,
  listPlanDelegationAgents,
  planDelegationAgentCanExecutePlan,
  supportsForcedPlanDelegation,
  validatePlanExecutionTarget,
} from "@eco/runtime/forced-plan-delegation";

const WRITE_TOOLS = {
  filesystem: { read: "workspace" as const, write: "workspace" as const },
  bash: { enabled: true },
  disallowed: ["Agent", "Task"],
};

const PLAN = "1. 修改 A\n2. 验证 B";

test("forced plan parent contract states the user request with the callable agent name", () => {
  expect(buildForcedPlanDelegationContract({ agentKey: "eco_coder" })).toBe(
    "用户要求使用子代理「eco_coder」执行已批准的计划。",
  );
});

test("buildForcedPlanDelegationTask embeds the plan verbatim", () => {
  expect(buildForcedPlanDelegationTask({ plan: PLAN })).toBe(
    [
      "执行以下已经由用户批准的完整计划。",
      "",
      "<approved_plan>",
      PLAN,
      "</approved_plan>",
      "",
      "严格按获批计划列出的步骤和约束执行；计划是唯一任务范围。计划给出精确命令或唯一工具动作时，直接按原文执行，不要先做无关的环境检查、目录/文件浏览或额外验证。计划没有要求额外验证时，不要自行追加检查。",
      "完成计划明确要求的步骤后，立即将实际结果返回给主代理。不要再委派其他代理。",
    ].join("\n"),
  );
});

test("buildForcedPlanDelegationTask trims the note and includes it when non-empty", () => {
  const task = buildForcedPlanDelegationTask({ plan: PLAN, additionalMessage: "  只看后端  " });
  expect(task).toContain("<additional_user_message>\n只看后端\n</additional_user_message>");
});

test("buildForcedPlanDelegationTask omits the note block for whitespace-only notes", () => {
  const task = buildForcedPlanDelegationTask({ plan: PLAN, additionalMessage: "   " });
  expect(task).not.toContain("additional_user_message");
});

test("buildForcedPlanDelegationTask never trims or truncates the plan body", () => {
  const padded = `  ${PLAN}  `;
  const task = buildForcedPlanDelegationTask({ plan: padded });
  expect(task).toContain(`<approved_plan>\n${padded}\n</approved_plan>`);
});

test("listPlanDelegationAgents keeps enabled agents and falls back to the agentKey as name", () => {
  expect(
    listPlanDelegationAgents({
      agents: [
        { agentKey: "coder", displayName: "Coder", enabled: true, tools: WRITE_TOOLS },
        { agentKey: "reviewer", enabled: true },
        { agentKey: "tester", displayName: "Tester", enabled: false, tools: WRITE_TOOLS },
      ],
    }),
  ).toEqual([
    { agentKey: "coder", displayName: "Coder", canExecutePlan: true },
    { agentKey: "reviewer", displayName: "reviewer", canExecutePlan: false },
  ]);
});

test("listPlanDelegationAgents returns an empty list without a snapshot", () => {
  expect(listPlanDelegationAgents(undefined)).toEqual([]);
  expect(listPlanDelegationAgents({})).toEqual([]);
});

test("supportsForcedPlanDelegation is limited to Claude, Codex, and PI", () => {
  expect(supportsForcedPlanDelegation("claude")).toBe(true);
  expect(supportsForcedPlanDelegation("codex")).toBe(true);
  expect(supportsForcedPlanDelegation("pi")).toBe(true);
  expect(supportsForcedPlanDelegation("acp")).toBe(false);
  expect(supportsForcedPlanDelegation("cursor")).toBe(false);
  expect(supportsForcedPlanDelegation(undefined)).toBe(false);
});

test("planDelegationAgentCanExecutePlan requires workspace writes", () => {
  expect(planDelegationAgentCanExecutePlan(WRITE_TOOLS)).toBe(true);
  expect(planDelegationAgentCanExecutePlan(undefined)).toBe(false);
  expect(
    planDelegationAgentCanExecutePlan({
      filesystem: { read: "workspace", write: "none" },
      bash: { enabled: false },
      disallowed: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"],
    }),
  ).toBe(false);
  expect(planDelegationAgentCanExecutePlan({ ...WRITE_TOOLS, disallowed: ["Write"] })).toBe(false);
  expect(
    planDelegationAgentCanExecutePlan({
      ...WRITE_TOOLS,
      coreOverrides: { codex: { sandboxMode: "read-only" } },
    }),
  ).toBe(false);
  expect(
    planDelegationAgentCanExecutePlan({
      ...WRITE_TOOLS,
      coreOverrides: { claude: { disallowedTools: ["Edit"] } },
    }),
  ).toBe(false);
});

test("validatePlanExecutionTarget rejects read-only agents", () => {
  const result = validatePlanExecutionTarget({
    target: { kind: "subagent", agentKey: "explore" },
    coreKind: "claude",
    agents: [{ agentKey: "explore", displayName: "Explore", canExecutePlan: false }],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("read_only_agent");
    expect(result.reason).toContain("只读代理");
  }
});

test("validatePlanExecutionTarget defaults to the main agent", () => {
  expect(validatePlanExecutionTarget({ coreKind: "claude", agents: [] })).toEqual({
    ok: true,
    target: { kind: "main" },
  });
});

test("validatePlanExecutionTarget rejects unsupported cores", () => {
  const result = validatePlanExecutionTarget({
    target: { kind: "subagent", agentKey: "coder" },
    coreKind: "acp",
    agents: [{ agentKey: "coder", displayName: "Coder", canExecutePlan: true }],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe("unsupported_core");
  }
});

test("validatePlanExecutionTarget rejects unknown and disabled agents", () => {
  const unknown = validatePlanExecutionTarget({
    target: { kind: "subagent", agentKey: "ghost" },
    coreKind: "claude",
    agents: [{ agentKey: "coder", displayName: "Coder", canExecutePlan: true }],
  });
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) {
    expect(unknown.code).toBe("unknown_agent");
  }

  const disabled = validatePlanExecutionTarget({
    target: { kind: "subagent", agentKey: "coder" },
    coreKind: "claude",
    agents: [{ agentKey: "coder", displayName: "Coder", canExecutePlan: true }],
    agentEnabled: () => false,
  });
  expect(disabled.ok).toBe(false);
  if (!disabled.ok) {
    expect(disabled.code).toBe("disabled_agent");
  }
});

test("validatePlanExecutionTarget trims the agent key and normalizes the note", () => {
  const result = validatePlanExecutionTarget({
    target: { kind: "subagent", agentKey: "  coder  ", additionalMessage: "  hi  " },
    coreKind: "pi",
    agents: [{ agentKey: "coder", displayName: "Coder", canExecutePlan: true }],
  });
  expect(result).toEqual({
    ok: true,
    target: { kind: "subagent", agentKey: "coder", additionalMessage: "hi" },
  });
});
