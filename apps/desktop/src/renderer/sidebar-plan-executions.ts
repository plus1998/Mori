import { useEffect, useState } from "react";
import type { ThreadPendingPlan } from "../shared/ipc";
import {
  PLAN_EXECUTION_CHANGED,
  type PlanExecutionLink,
  type PlanExecutionStatus,
} from "../shared/plan-execution";

export interface SidebarPlanExecutionState {
  status?: PlanExecutionStatus;
  error?: string;
}

/** Only executions of the currently displayed plan can replace its approval indicator. */
export function currentPlanExecutionStatus(
  plan: ThreadPendingPlan | undefined,
  links: readonly PlanExecutionLink[],
): PlanExecutionStatus | undefined {
  if (!plan?.referenceId) return undefined;
  const executions = links.filter(
    (link) =>
      link.sourceThreadId === plan.threadId && link.planId === plan.referenceId && !link.executionDeleted,
  );
  const active = executions.find((link) => link.status === "running" || link.status === "queued");
  // The API returns newest first. A retry may coexist with older, finished executions.
  return active?.status ?? executions[0]?.status;
}

/** Load only visible pending-plan sources, and refresh the affected source on live changes. */
export function useSidebarPlanExecutions(threadIdsKey: string): Record<string, SidebarPlanExecutionState> {
  const [states, setStates] = useState<Record<string, SidebarPlanExecutionState>>({});
  useEffect(() => {
    const api = window.eco;
    if (!api) return;
    const threadIds = new Set<string>(JSON.parse(threadIdsKey));
    const revisions = new Map<string, number>();
    let disposed = false;
    setStates({});
    const refresh = (threadId: string) => {
      const revision = (revisions.get(threadId) ?? 0) + 1;
      revisions.set(threadId, revision);
      void Promise.all([api.getPendingPlan(threadId), api.listPlanExecutions(threadId)])
        .then(([plan, links]) => {
          if (disposed || revisions.get(threadId) !== revision) return;
          const status = currentPlanExecutionStatus(plan, links);
          setStates((current) => ({ ...current, [threadId]: status ? { status } : {} }));
        })
        .catch((error: unknown) => {
          if (disposed || revisions.get(threadId) !== revision) return;
          setStates((current) => ({ ...current, [threadId]: { error: String(error) } }));
        });
    };
    const unsubscribe = api.onThreadEvent((event) => {
      if (
        event &&
        typeof event === "object" &&
        "threadId" in event &&
        "type" in event &&
        typeof event.threadId === "string" &&
        typeof event.type === "string" &&
        threadIds.has(event.threadId) &&
        (event.type === PLAN_EXECUTION_CHANGED ||
          event.type === "thread.awaiting_plan" ||
          event.type.startsWith("plan_approval.") ||
          event.type.startsWith("thread.plan"))
      )
        refresh(event.threadId);
    });
    for (const threadId of threadIds) refresh(threadId);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threadIdsKey]);
  return states;
}
