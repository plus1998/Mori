import { expect, test } from "bun:test";
import { currentPlanExecutionStatus } from "../src/renderer/sidebar-plan-executions";
import type { ThreadPendingPlan } from "../src/shared/ipc";
import type { PlanExecutionLink } from "../src/shared/plan-execution";

const plan: ThreadPendingPlan = {
  threadId: "source",
  referenceId: "plan_v2",
  userPrompt: "Build it",
  analysis: "",
  plan: "Plan v2",
  workspacePath: "/repo",
  worktreePath: "/repo",
};
const link: PlanExecutionLink = {
  id: "link",
  planId: "plan_v2",
  version: 2,
  planTitle: "Plan v2",
  sourceThreadId: "source",
  sourceTitle: "Planning",
  sourceDeleted: false,
  executionThreadId: "execution",
  executionTitle: "Implementation",
  executionDeleted: false,
  status: "running",
  message: "",
  createdAt: "2026-11-06",
};

test("only the current source plan's execution changes its approval indicator", () => {
  expect(currentPlanExecutionStatus(plan, [link])).toBe("running");
  expect(currentPlanExecutionStatus(undefined, [link])).toBeUndefined();
  expect(currentPlanExecutionStatus({ ...plan, referenceId: "plan_v3" }, [link])).toBeUndefined();
  expect(currentPlanExecutionStatus(plan, [{ ...link, sourceThreadId: "other" }])).toBeUndefined();
  expect(currentPlanExecutionStatus(plan, [{ ...link, executionDeleted: true }])).toBeUndefined();
  expect(currentPlanExecutionStatus(plan, [])).toBeUndefined();
});

test("an active retry takes priority over finished executions, then follows settlement", () => {
  const finished = { ...link, id: "newest", status: "completed" } as const;
  expect(currentPlanExecutionStatus(plan, [finished, link])).toBe("running");
  expect(currentPlanExecutionStatus(plan, [finished, { ...link, status: "queued" }])).toBe("queued");
  expect(currentPlanExecutionStatus(plan, [finished, { ...link, status: "failed" }])).toBe("completed");
  for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
    expect(currentPlanExecutionStatus(plan, [{ ...link, status }])).toBe(status);
  }
});
