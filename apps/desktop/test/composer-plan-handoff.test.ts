import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPlanExecutionRequest } from "../src/renderer/composer-plan-handoff";
import { composerReferences } from "../src/shared/composer-references";
import type { ThreadPendingPlan, ThreadSummary } from "../src/shared/ipc";

const plan: ThreadPendingPlan = {
  referenceId: "plan_1",
  version: 1,
  threadId: "source",
  userPrompt: "implement",
  analysis: "reason",
  plan: "# Plan",
  workspacePath: "/workspace",
  worktreePath: "/workspace",
};
const source: ThreadSummary = {
  id: "source",
  title: "Source plan",
  prompt: "implement",
  coreKind: "pi",
  status: "awaiting_plan",
  workspacePath: "/workspace",
  message: "",
  createdAt: "2026-11-03",
  updatedAt: "2026-11-03",
};

test("explicit execution carries the immutable plan ID and uses the source harness in agent mode", () => {
  const request = buildPlanExecutionRequest(plan, source, { sessionMode: "plan" }, "计划 v1");
  expect(request).toMatchObject({
    planExecutionId: "plan_1",
    workspacePath: "/workspace",
    coreKind: "pi",
    developmentMode: "direct",
    runtimeConfig: { sessionMode: "agent" },
  });
  expect(composerReferences(request.prompt)).toEqual([
    { kind: "plan", id: "plan_1", label: "计划 v1", detail: "Source plan" },
  ]);
  expect(request.managedWorktreeId).toBeUndefined();
});

test("execution uses the source worktree so its code can be reviewed in the plan conversation", () => {
  const request = buildPlanExecutionRequest(
    plan,
    {
      ...source,
      workLocation: {
        mode: "isolated",
        worktree: { id: "worktree_1" } as NonNullable<ThreadSummary["workLocation"]>["worktree"],
      },
    },
    {},
    "Plan",
  );
  expect(request.managedWorktreeId).toBe("worktree_1");
});

test("unversioned or mismatched plans cannot silently start an unrelated conversation", () => {
  expect(() => buildPlanExecutionRequest({ ...plan, referenceId: undefined }, source, {}, "Plan")).toThrow(
    "不匹配",
  );
  expect(() => buildPlanExecutionRequest(plan, { ...source, id: "other" }, {}, "Plan")).toThrow("不匹配");
});

test("unresolved work locations fail visibly instead of switching execution to the main checkout", () => {
  for (const mode of ["needs_choice", "isolated"] as const) {
    expect(() => buildPlanExecutionRequest(plan, { ...source, workLocation: { mode } }, {}, "Plan")).toThrow(
      "工作位置尚未就绪",
    );
  }
});

test("the explicit action starts execution without navigating away from the plan", () => {
  const appSource = readFileSync(fileURLToPath(new URL("../src/renderer/App.tsx", import.meta.url)), "utf8");
  const start = appSource.indexOf("async function startNewChatWithPlan(plan: ThreadPendingPlan)");
  const handler = appSource.slice(start, appSource.indexOf("async function navigatePlanConversation", start));
  expect(handler).toContain("window.eco.startThread(buildPlanExecutionRequest(");
  expect(handler).not.toContain("startNewChat()");
  expect(handler).not.toContain("clearPendingPlanForThread");
  expect(handler).not.toContain("adoptLandingThreadSelection");
});
