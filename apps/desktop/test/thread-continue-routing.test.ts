import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approvedPlanSnapshotExists,
  deleteApprovedPlanSnapshotIfNewerThan,
  parseApprovedPlanDocument,
  writeApprovedPlanSnapshot,
} from "../src/main/worktree-lifecycle";
import {
  continueStatusMessage,
  resolveContinuePhase,
  resolveThreadContinueAction,
  threadEnteredExecutionPhase,
  userRequestsPlanRevision,
} from "../src/shared/thread-continuation";

test("userRequestsPlanRevision detects replan intent", () => {
  expect(userRequestsPlanRevision("继续")).toBe(false);
  expect(userRequestsPlanRevision("请重新规划一下")).toBe(true);
  expect(userRequestsPlanRevision("改计划：加上测试")).toBe(true);
  expect(userRequestsPlanRevision("先别做导出，改成修复登录")).toBe(true);
  expect(userRequestsPlanRevision("换方向，先做批量导入")).toBe(true);
});

test("threadEnteredExecutionPhase uses plan_cleared and approved file signals", () => {
  expect(
    threadEnteredExecutionPhase({
      threadStatus: "awaiting_plan",
      hasPendingPlan: true,
      hasApprovedPlanOnDisk: false,
      enteredExecutionPhase: false,
      hasCoderTodos: false,
      hasAppliedDiff: false,
      activityLines: [{ role: "system", message: "计划已进入执行阶段。" }],
    }),
  ).toBe(true);
  expect(
    threadEnteredExecutionPhase({
      threadStatus: "blocked",
      hasPendingPlan: false,
      hasApprovedPlanOnDisk: true,
      enteredExecutionPhase: false,
      hasCoderTodos: false,
      hasAppliedDiff: false,
      activityLines: [],
    }),
  ).toBe(true);
});

test("resolveContinuePhase returns execution after plan_cleared", () => {
  expect(
    resolveContinuePhase({
      threadStatus: "idle",
      hasPendingPlan: false,
      hasApprovedPlanOnDisk: true,
      enteredExecutionPhase: true,
      hasCoderTodos: false,
      hasAppliedDiff: false,
      activityLines: [{ role: "system", message: "计划已进入执行阶段。" }],
    }),
  ).toBe("execution");
});

test("awaiting_plan with pending after execution failure resumes execution not replan", () => {
  const action = resolveThreadContinueAction({
    followUp: "继续",
    canResume: true,
    sessionMode: "plan",
    hasPendingPlan: true,
    hasApprovedPlanOnDisk: true,
    enteredExecutionPhase: true,
    hasCoderTodos: true,
    hasAppliedDiff: false,
    threadStatus: "awaiting_plan",
    activityLines: [{ role: "system", message: "计划已进入执行阶段。" }],
  });
  expect(action).toEqual({ kind: "resume_execution" });
  expect(continueStatusMessage(action)).toBe("正在按计划执行…");
});

test("awaiting_plan with pending before approval continues planning session", () => {
  const action = resolveThreadContinueAction({
    followUp: "继续",
    canResume: true,
    sessionMode: "plan",
    hasPendingPlan: true,
    hasApprovedPlanOnDisk: false,
    enteredExecutionPhase: false,
    hasCoderTodos: false,
    hasAppliedDiff: false,
    threadStatus: "awaiting_plan",
    activityLines: [{ role: "main", message: "计划已生成，等待确认。" }],
  });
  expect(action).toEqual({ kind: "resume_sdk", phase: "planning" });
});

test("canResume false with approved snapshot resumes execution", () => {
  const action = resolveThreadContinueAction({
    followUp: "继续",
    canResume: false,
    sessionMode: "plan",
    hasPendingPlan: false,
    hasApprovedPlanOnDisk: true,
    enteredExecutionPhase: true,
    hasCoderTodos: false,
    hasAppliedDiff: false,
    threadStatus: "blocked",
    activityLines: [{ role: "system", message: "计划已进入执行阶段。" }],
  });
  expect(action).toEqual({ kind: "resume_execution" });
});

test("explicit replan uses sdk planning when session resumable", () => {
  const action = resolveThreadContinueAction({
    followUp: "重新规划",
    canResume: true,
    sessionMode: "plan",
    hasPendingPlan: true,
    hasApprovedPlanOnDisk: true,
    enteredExecutionPhase: true,
    hasCoderTodos: false,
    hasAppliedDiff: false,
    threadStatus: "awaiting_plan",
    activityLines: [],
  });
  expect(action).toEqual({ kind: "resume_sdk", phase: "planning" });
});

test("continue with extra tests stays on execution route", () => {
  const action = resolveThreadContinueAction({
    followUp: "继续，但加测试",
    canResume: true,
    sessionMode: "plan",
    hasPendingPlan: false,
    hasApprovedPlanOnDisk: true,
    enteredExecutionPhase: true,
    hasCoderTodos: true,
    hasAppliedDiff: false,
    threadStatus: "completed",
    activityLines: [{ role: "system", message: "计划已进入执行阶段。" }],
  });
  expect(action).toEqual({ kind: "resume_execution" });
});

test("plan mode off without resumable session starts fresh autonomous handling", () => {
  const action = resolveThreadContinueAction({
    followUp: "继续",
    canResume: false,
    sessionMode: "agent",
    hasPendingPlan: false,
    hasApprovedPlanOnDisk: false,
    enteredExecutionPhase: false,
    hasCoderTodos: false,
    hasAppliedDiff: false,
    threadStatus: "blocked",
    activityLines: [],
  });
  expect(action).toEqual({ kind: "fresh_autonomous" });
  expect(continueStatusMessage(action)).toBe("正在交给主代理处理…");
});

test("agent mode does not enter planning for stale pending plan", () => {
  const action = resolveThreadContinueAction({
    followUp: "继续",
    canResume: true,
    sessionMode: "agent",
    hasPendingPlan: true,
    hasApprovedPlanOnDisk: false,
    enteredExecutionPhase: false,
    hasCoderTodos: false,
    hasAppliedDiff: false,
    threadStatus: "awaiting_plan",
    activityLines: [{ role: "main", message: "计划已生成，等待确认。" }],
  });
  expect(action).toEqual({ kind: "resume_sdk", phase: "execution" });
  expect(continueStatusMessage(action)).toBe("正在继续执行…");
});

test("parseApprovedPlanDocument round-trips snapshot sections", () => {
  const doc = [
    "# Mori approved plan",
    "",
    "## User request",
    "fix export",
    "",
    "## Planning analysis",
    "missing handler",
    "",
    "## Approved plan",
    "## Steps",
    "1. add route",
    "",
    "_User edited this plan in Mori before approval._",
  ].join("\n");
  const parsed = parseApprovedPlanDocument(doc);
  expect(parsed?.userPrompt).toBe("fix export");
  expect(parsed?.analysis).toBe("missing handler");
  expect(parsed?.plan).toContain("## Steps");
  expect(parsed?.planUserEdited).toBe(true);
});

test("deleteApprovedPlanSnapshotIfNewerThan removes only future snapshots", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-approved-plan-"));
  await writeApprovedPlanSnapshot(dir, "thr_plan", {
    userPrompt: "fix export",
    analysis: "analysis",
    plan: "plan",
  });

  expect(
    await deleteApprovedPlanSnapshotIfNewerThan(dir, "thr_plan", new Date(Date.now() + 60_000).toISOString()),
  ).toBe(false);
  expect(await approvedPlanSnapshotExists(dir, "thr_plan")).toBe(true);
  expect(
    await deleteApprovedPlanSnapshotIfNewerThan(dir, "thr_plan", new Date(Date.now() - 60_000).toISOString()),
  ).toBe(true);
  expect(await approvedPlanSnapshotExists(dir, "thr_plan")).toBe(false);
});
