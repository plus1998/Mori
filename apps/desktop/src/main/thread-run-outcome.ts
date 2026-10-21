import type { RequestAttemptResult } from "./request-retry";
import type { RunAttemptPhase } from "./usage-ledger";

export type ThreadRunMode = "planning" | "execution" | "ask";

export type ThreadRunOutcomeDecision =
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "unstarted"; reason: string }
  | { kind: "incomplete"; reason: string }
  | { kind: "awaiting_plan"; message: string }
  | { kind: "completed"; message?: string }
  | { kind: "idle"; message: string };

export function isRequestAttemptAborted(result: RequestAttemptResult): boolean {
  return !result.ok && result.aborted === true && result.interruptFailed !== true;
}

export function runAttemptPhaseFromThreadMode(mode: ThreadRunMode): RunAttemptPhase {
  return mode;
}

export function resolveAskRunOutcome(result: RequestAttemptResult): ThreadRunOutcomeDecision {
  const interrupted = resolveInterruptedRunOutcome(result);
  if (interrupted) {
    return interrupted;
  }
  return { kind: "completed" };
}

export function resolveAutonomousRunOutcome(
  result: RequestAttemptResult,
  input: { hasPendingPlan: boolean; planCaptured: boolean },
): ThreadRunOutcomeDecision {
  const interrupted = resolveInterruptedRunOutcome(result);
  if (interrupted) {
    // User cancel still wins; otherwise keep an Eco-owned pending plan waitable.
    if (interrupted.kind !== "cancelled" && input.hasPendingPlan) {
      return { kind: "awaiting_plan", message: "" };
    }
    return interrupted;
  }
  if (input.hasPendingPlan) {
    return { kind: "awaiting_plan", message: "" };
  }
  return { kind: "completed" };
}

export function resolvePlanningRunOutcome(
  result: RequestAttemptResult,
  input: { hasPendingPlan: boolean },
): ThreadRunOutcomeDecision {
  const interrupted = resolveInterruptedRunOutcome(result);
  if (interrupted) {
    // Cursor ACP may drop the parked create_plan RPC; Eco must keep awaiting_plan.
    if (interrupted.kind !== "cancelled" && input.hasPendingPlan) {
      return { kind: "awaiting_plan", message: "" };
    }
    return interrupted;
  }
  if (input.hasPendingPlan) {
    return { kind: "awaiting_plan", message: "" };
  }
  return { kind: "idle", message: "" };
}

export function resolvePlanSessionRunOutcome(
  result: RequestAttemptResult,
  input: { hasPendingPlan: boolean; enteredExecution: boolean },
): ThreadRunOutcomeDecision {
  return input.enteredExecution
    ? resolveExecutionRunOutcome(result)
    : resolvePlanningRunOutcome(result, { hasPendingPlan: input.hasPendingPlan });
}

export function resolveExecutionRunOutcome(result: RequestAttemptResult): ThreadRunOutcomeDecision {
  const interrupted = resolveInterruptedRunOutcome(result);
  if (interrupted) {
    return interrupted;
  }
  return { kind: "completed" };
}

export function resolveContinuationRunOutcome(
  result: RequestAttemptResult,
  input: { mode: ThreadRunMode; planningPlanCaptured: boolean },
): ThreadRunOutcomeDecision {
  const interrupted = resolveInterruptedRunOutcome(result);
  if (interrupted) {
    return interrupted;
  }

  if (input.mode === "execution") {
    return { kind: "completed" };
  }
  if (input.mode === "ask") {
    return { kind: "completed" };
  }
  if (input.planningPlanCaptured) {
    return { kind: "awaiting_plan", message: "" };
  }
  return { kind: "idle", message: "" };
}

function resolveInterruptedRunOutcome(
  result: RequestAttemptResult,
):
  | Extract<ThreadRunOutcomeDecision, { kind: "cancelled" | "failed" | "unstarted" | "incomplete" }>
  | undefined {
  if (!result.ok && isRequestAttemptAborted(result)) {
    return {
      kind: "cancelled",
      reason: result.reason.trim() || "cancelled by user",
    };
  }
  if (!result.ok && result.incomplete) {
    return { kind: "incomplete", reason: result.reason };
  }
  if (!result.ok && result.unstarted) {
    return { kind: "unstarted", reason: result.reason };
  }
  if (!result.ok) {
    return { kind: "failed", reason: result.reason };
  }
  return undefined;
}
