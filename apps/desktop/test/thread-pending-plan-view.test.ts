import { expect, test } from "bun:test";
import {
  buildThreadPendingPlanView,
  buildThreadPlanLivePayload,
  type ThreadPendingPlanInternal,
} from "../src/main/thread-pending-plan-view";

const pendingPlan: ThreadPendingPlanInternal = {
  threadId: "thr_plan",
  userPrompt: "Build billing ledger",
  analysis: "Need a stable domain model.",
  plan: "1. Capture usage\n2. Project billing",
  workspacePath: "/repo",
  worktreePath: "/repo/.worktrees/thr_plan",
  routesJson: '{"main":"sonnet"}',
};

test("buildThreadPendingPlanView returns undefined without a pending plan", () => {
  expect(buildThreadPendingPlanView(undefined)).toBeUndefined();
});

test("buildThreadPendingPlanView strips internal routing fields from IPC view", () => {
  expect(buildThreadPendingPlanView(pendingPlan)).toEqual({
    threadId: "thr_plan",
    userPrompt: "Build billing ledger",
    analysis: "Need a stable domain model.",
    plan: "1. Capture usage\n2. Project billing",
    workspacePath: "/repo",
    worktreePath: "/repo/.worktrees/thr_plan",
  });
  expect(buildThreadPendingPlanView(pendingPlan)).not.toHaveProperty("routesJson");
});

test("buildThreadPlanLivePayload omits routesJson for live events", () => {
  expect(buildThreadPlanLivePayload(pendingPlan)).toEqual({
    userPrompt: "Build billing ledger",
    analysis: "Need a stable domain model.",
    plan: "1. Capture usage\n2. Project billing",
  });
});
