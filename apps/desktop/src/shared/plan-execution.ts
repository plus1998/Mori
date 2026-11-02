/** A content version of a planner's output. Execution always reads this immutable snapshot. */
export interface PlanReferenceSnapshot {
  id: string;
  sourceThreadId: string;
  version: number;
  title: string;
  workspacePath: string;
  userPrompt: string;
  analysis: string;
  plan: string;
  createdAt: string;
}

export type PlanExecutionStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface PlanExecutionLink {
  id: string;
  planId: string;
  version: number;
  planTitle: string;
  sourceThreadId: string;
  sourceTitle: string;
  sourceDeleted: boolean;
  executionThreadId: string;
  executionTitle: string;
  executionDeleted: boolean;
  attemptId?: string;
  status: PlanExecutionStatus;
  message: string;
  createdAt: string;
}

export const PLAN_EXECUTION_CHANGED = "thread.plan_execution_updated";
