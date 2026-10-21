import { expect, test } from "bun:test";
import {
  isRequestAttemptAborted,
  resolveAskRunOutcome,
  resolveAutonomousRunOutcome,
  resolveContinuationRunOutcome,
  resolveExecutionRunOutcome,
  resolvePlanningRunOutcome,
  resolvePlanSessionRunOutcome,
  runAttemptPhaseFromThreadMode,
} from "../src/main/thread-run-outcome";

test("resolveAskRunOutcome maps cancelled failed and completed results", () => {
  expect(resolveAskRunOutcome({ ok: false, reason: "stop", aborted: true })).toEqual({
    kind: "cancelled",
    reason: "stop",
  });
  expect(resolveAskRunOutcome({ ok: false, reason: "upstream failed" })).toEqual({
    kind: "failed",
    reason: "upstream failed",
  });
  expect(
    resolveAskRunOutcome({
      ok: false,
      reason: "Error: RetriableError: [resource_exhausted] Error",
      unstarted: true,
    }),
  ).toEqual({
    kind: "unstarted",
    reason: "Error: RetriableError: [resource_exhausted] Error",
  });
  expect(resolveAskRunOutcome({ ok: true })).toEqual({
    kind: "completed",
  });
});

test("resolveAutonomousRunOutcome only waits for existing pending plans", () => {
  expect(resolveAutonomousRunOutcome({ ok: true }, { hasPendingPlan: true, planCaptured: false })).toEqual({
    kind: "awaiting_plan",
    message: "",
  });
  expect(resolveAutonomousRunOutcome({ ok: true }, { hasPendingPlan: false, planCaptured: true })).toEqual({
    kind: "completed",
  });
  expect(resolveAutonomousRunOutcome({ ok: true }, { hasPendingPlan: false, planCaptured: false })).toEqual({
    kind: "completed",
  });
});

test("resolvePlanningRunOutcome returns awaiting plan or idle on success", () => {
  expect(resolvePlanningRunOutcome({ ok: true }, { hasPendingPlan: true })).toEqual({
    kind: "awaiting_plan",
    message: "",
  });
  expect(resolvePlanningRunOutcome({ ok: true }, { hasPendingPlan: false })).toEqual({
    kind: "idle",
    message: "",
  });
});

test("resolvePlanningRunOutcome keeps awaiting_plan when upstream fails after plan capture", () => {
  expect(
    resolvePlanningRunOutcome({ ok: false, reason: "ACP process exited" }, { hasPendingPlan: true }),
  ).toEqual({ kind: "awaiting_plan", message: "" });
  expect(
    resolvePlanningRunOutcome({ ok: false, reason: "stop", aborted: true }, { hasPendingPlan: true }),
  ).toEqual({ kind: "cancelled", reason: "stop" });
});

test("preserves the quota stop reason and surfaces interrupt failures as failures", () => {
  const quotaReason = "ChatGPT subscription usage limit exceeded; 该账号的 ChatGPT 订阅用量受限，本轮已停止";
  expect(resolveAskRunOutcome({ ok: false, reason: quotaReason, aborted: true })).toEqual({
    kind: "cancelled",
    reason: quotaReason,
  });
  expect(
    resolveAskRunOutcome({
      ok: false,
      reason: "停止当前 Codex turn 失败：turn/interrupt failed",
      aborted: true,
      interruptFailed: true,
    }),
  ).toEqual({
    kind: "failed",
    reason: "停止当前 Codex turn 失败：turn/interrupt failed",
  });
});

test("resolveAutonomousRunOutcome keeps awaiting_plan on non-cancel failure with pending plan", () => {
  expect(
    resolveAutonomousRunOutcome(
      { ok: false, reason: "disconnected" },
      { hasPendingPlan: true, planCaptured: true },
    ),
  ).toEqual({ kind: "awaiting_plan", message: "" });
});

test("resolvePlanSessionRunOutcome treats an approved in-session plan as execution", () => {
  expect(
    resolvePlanSessionRunOutcome({ ok: true }, { hasPendingPlan: false, enteredExecution: true }),
  ).toEqual({ kind: "completed" });
  expect(
    resolvePlanSessionRunOutcome({ ok: true }, { hasPendingPlan: true, enteredExecution: false }),
  ).toEqual({ kind: "awaiting_plan", message: "" });
});

test("resolveExecutionRunOutcome returns completed on success", () => {
  expect(resolveExecutionRunOutcome({ ok: true })).toEqual({ kind: "completed" });
  expect(resolveExecutionRunOutcome({ ok: false, reason: "blocked" })).toEqual({
    kind: "failed",
    reason: "blocked",
  });
  expect(resolveExecutionRunOutcome({ ok: false, reason: "tasks remain", incomplete: true })).toEqual({
    kind: "incomplete",
    reason: "tasks remain",
  });
});

test("resolveContinuationRunOutcome keeps mode-specific success decisions", () => {
  expect(
    resolveContinuationRunOutcome({ ok: true }, { mode: "execution", planningPlanCaptured: false }),
  ).toEqual({ kind: "completed" });
  expect(resolveContinuationRunOutcome({ ok: true }, { mode: "ask", planningPlanCaptured: false })).toEqual({
    kind: "completed",
  });
  expect(
    resolveContinuationRunOutcome({ ok: true }, { mode: "planning", planningPlanCaptured: true }),
  ).toEqual({
    kind: "awaiting_plan",
    message: "",
  });
  expect(
    resolveContinuationRunOutcome({ ok: true }, { mode: "planning", planningPlanCaptured: false }),
  ).toEqual({
    kind: "idle",
    message: "",
  });
});

test("runAttemptPhaseFromThreadMode and isRequestAttemptAborted expose shared run helpers", () => {
  expect(runAttemptPhaseFromThreadMode("ask")).toBe("ask");
  expect(runAttemptPhaseFromThreadMode("planning")).toBe("planning");
  expect(runAttemptPhaseFromThreadMode("execution")).toBe("execution");
  expect(isRequestAttemptAborted({ ok: false, reason: "stop", aborted: true })).toBe(true);
  expect(
    isRequestAttemptAborted({
      ok: false,
      reason: "turn/interrupt failed",
      aborted: true,
      interruptFailed: true,
    }),
  ).toBe(false);
  expect(isRequestAttemptAborted({ ok: false, reason: "failed" })).toBe(false);
});
