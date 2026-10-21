import { expect, test } from "bun:test";
import {
  applyThreadPlanReadyEffects,
  buildExecutionFailureRestorePendingPlan,
  type ThreadPendingPlanWithRoutes,
  type ThreadPlanReadyAwaitingPlanEvent,
} from "../src/main/thread-plan-ready-effects";

test("applyThreadPlanReadyEffects persists plan and emits awaiting event", () => {
  const savedPlans: ThreadPendingPlanWithRoutes[] = [];
  const emittedEvents: ThreadPlanReadyAwaitingPlanEvent[] = [];

  const result = applyThreadPlanReadyEffects({
    threadId: "thr_plan_ready",
    payload: {
      userPrompt: "Build billing ledger",
      analysis: "Need a stable ledger domain.",
      plan: "1. Capture usage events\n2. Project billing",
      deferredExitPlanToolUseId: "tool_exit_deferred",
    },
    workspacePath: "/repo",
    worktreePath: "/repo/.worktrees/thr_plan_ready",
    routesJson: '{"main":"model_planner"}',
    awaitingPlanMessage: "",
    effects: {
      savePendingPlan: (plan) => {
        savedPlans.push(plan);
      },
      emitAwaitingPlan: (event) => {
        emittedEvents.push(event);
      },
    },
  });

  expect(result).toEqual({
    planCaptured: true,
    pendingPlan: {
      threadId: "thr_plan_ready",
      userPrompt: "Build billing ledger",
      analysis: "Need a stable ledger domain.",
      plan: "1. Capture usage events\n2. Project billing",
      workspacePath: "/repo",
      worktreePath: "/repo/.worktrees/thr_plan_ready",
      routesJson: '{"main":"model_planner"}',
      deferredExitPlanToolUseId: "tool_exit_deferred",
    },
  });
  expect(savedPlans).toEqual([result.pendingPlan]);
  expect(emittedEvents).toEqual([
    {
      threadId: "thr_plan_ready",
      message: "",
      plan: {
        userPrompt: "Build billing ledger",
        analysis: "Need a stable ledger domain.",
        plan: "1. Capture usage events\n2. Project billing",
      },
    },
  ]);
});

test("applyThreadPlanReadyEffects keeps caller-specific awaiting messages out of persisted plan", () => {
  const savedPlans: ThreadPendingPlanWithRoutes[] = [];
  const emittedEvents: ThreadPlanReadyAwaitingPlanEvent[] = [];

  applyThreadPlanReadyEffects({
    threadId: "thr_autonomous_plan",
    payload: {
      userPrompt: "Audit subagents",
      analysis: "Review lifecycle first.",
      plan: "Inspect attribution.",
    },
    workspacePath: "/repo",
    worktreePath: "/repo",
    routesJson: "{}",
    awaitingPlanMessage: "",
    effects: {
      savePendingPlan: (plan) => savedPlans.push(plan),
      emitAwaitingPlan: (event) => emittedEvents.push(event),
    },
  });

  expect(savedPlans[0]?.plan).toBe("Inspect attribution.");
  expect(savedPlans[0]).not.toHaveProperty("message");
  expect(emittedEvents[0]?.message).toBe("");
});

test("buildExecutionFailureRestorePendingPlan keeps approved deferred ExitPlanMode id", () => {
  const pending: ThreadPendingPlanWithRoutes = {
    threadId: "thr_execution_failure",
    userPrompt: "Ship it",
    analysis: "Approved",
    plan: "Do the work",
    workspacePath: "/repo",
    worktreePath: "/repo",
    routesJson: "",
    deferredExitPlanToolUseId: "tool_exit_deferred",
  };

  expect(buildExecutionFailureRestorePendingPlan(pending)).toEqual({
    ...pending,
    routesJson: "[]",
    deferredExitPlanToolUseId: "tool_exit_deferred",
  });
});
