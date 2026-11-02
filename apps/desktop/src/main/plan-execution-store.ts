import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type ComposerReference, composerReferences } from "../shared/composer-references";
import type { ThreadPendingPlan } from "../shared/ipc";
import type { PlanExecutionLink, PlanExecutionStatus, PlanReferenceSnapshot } from "../shared/plan-execution";

export function planReferenceId(
  plan: Pick<ThreadPendingPlan, "threadId" | "userPrompt" | "analysis" | "plan">,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([plan.userPrompt, plan.analysis, plan.plan]))
    .digest("hex");
  return `plan_${plan.threadId}_${hash}`;
}

export function resolvePlanExecutionId(prompt: string, requested: unknown): string | undefined {
  const ids = [
    ...new Set(
      composerReferences(prompt)
        .filter((ref) => ref.kind === "plan" && ref.intent === "execute")
        .map((ref) => ref.id),
    ),
  ];
  if (ids.length > 1) throw new Error("一个新会话只能执行一份计划，请取消其他计划的执行。");
  if (requested !== undefined && (typeof requested !== "string" || requested !== ids[0])) {
    throw new Error("执行计划必须保留原始计划引用，请重新选择计划。");
  }
  return ids[0];
}

/** Common storage, shared by legacy migration and V2-only stores. Call transaction methods inside the host transaction. */
export class PlanExecutionStore {
  constructor(private readonly db: DatabaseSync) {}

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_reference_snapshots (
        id TEXT PRIMARY KEY,
        source_thread_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        analysis TEXT NOT NULL,
        plan TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(source_thread_id, version)
      );
      CREATE TABLE IF NOT EXISTS plan_execution_links (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plan_reference_snapshots(id),
        source_thread_id TEXT NOT NULL,
        execution_thread_id TEXT NOT NULL UNIQUE,
        attempt_id TEXT,
        status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_plan_execution_source ON plan_execution_links(source_thread_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_execution_active ON plan_execution_links(plan_id)
        WHERE status IN ('queued', 'running');
    `);
  }

  capture(plan: ThreadPendingPlan): PlanReferenceSnapshot {
    const id = planReferenceId(plan);
    this.db
      .prepare(`INSERT OR IGNORE INTO plan_reference_snapshots
      (id, source_thread_id, version, title, workspace_path, user_prompt, analysis, plan, created_at)
      SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?, ?
      FROM plan_reference_snapshots WHERE source_thread_id = ?`)
      .run(
        id,
        plan.threadId,
        plan.plan
          .split("\n")
          .map((line) => line.replace(/^\s*#+\s*/, "").trim())
          .find(Boolean)
          ?.slice(0, 160) || "Plan",
        plan.workspacePath,
        plan.userPrompt,
        plan.analysis,
        plan.plan,
        new Date().toISOString(),
        plan.threadId,
      );
    return this.requireSnapshot(id);
  }

  requireSnapshot(id: string): PlanReferenceSnapshot {
    const row = this.db
      .prepare(`SELECT id, source_thread_id AS sourceThreadId, version, title,
      workspace_path AS workspacePath, user_prompt AS userPrompt, analysis, plan, created_at AS createdAt
      FROM plan_reference_snapshots WHERE id = ?`)
      .get(id) as unknown as PlanReferenceSnapshot | undefined;
    if (!row) throw new Error("引用的计划不存在，请重新选择计划。");
    return row;
  }

  references(query: string, limit: number): ComposerReference[] {
    const rows = this.db
      .prepare(`SELECT p.id, p.title, p.version, t.title AS sourceTitle
      FROM plan_reference_snapshots p JOIN threads t ON t.id = p.source_thread_id
      WHERE (instr(lower(p.title), lower(?)) > 0 OR instr(lower(t.title), lower(?)) > 0)
      ORDER BY p.created_at DESC LIMIT ?`)
      .all(query, query, limit) as unknown as Array<{
      id: string;
      title: string;
      version: number;
      sourceTitle: string;
    }>;
    return rows.map((row) => ({
      kind: "plan",
      id: row.id,
      label: row.title,
      detail: `v${row.version} · ${row.sourceTitle}`,
    }));
  }

  reserve(planId: string, executionThreadId: string): void {
    const plan = this.requireSnapshot(planId);
    if (plan.sourceThreadId === executionThreadId) throw new Error("请在新会话中执行引用的计划。");
    this.assertAvailable(planId);
    this.db
      .prepare(`INSERT INTO plan_execution_links
      (id, plan_id, source_thread_id, execution_thread_id, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)`)
      .run(
        `planexec_${randomUUID()}`,
        planId,
        plan.sourceThreadId,
        executionThreadId,
        new Date().toISOString(),
      );
  }

  queuedForThread(threadId: string): { planId: string; sourceThreadId: string } | undefined {
    return this.db
      .prepare(`SELECT plan_id AS planId, source_thread_id AS sourceThreadId FROM plan_execution_links
      WHERE execution_thread_id = ? AND status = 'queued' AND attempt_id IS NULL`)
      .get(threadId) as { planId: string; sourceThreadId: string } | undefined;
  }

  assertAvailable(planId: string): void {
    const active = this.db
      .prepare(`SELECT execution_thread_id FROM plan_execution_links
      WHERE plan_id = ? AND status IN ('queued', 'running')`)
      .get(planId);
    if (active) throw new Error("这份计划已交给其他会话执行，请打开来源会话查看。");
  }

  bindAttempt(threadId: string, attemptId: string): void {
    this.db
      .prepare(`UPDATE plan_execution_links SET attempt_id = ?, status = 'running'
      WHERE execution_thread_id = ? AND status = 'queued' AND attempt_id IS NULL`)
      .run(attemptId, threadId);
  }

  settleAttempt(threadId: string, attemptId: string, status: PlanExecutionStatus, message: string): void {
    this.db
      .prepare(`UPDATE plan_execution_links SET status = ?, message = ?
      WHERE execution_thread_id = ? AND attempt_id = ? AND status = 'running'`)
      .run(status, message, threadId, attemptId);
  }

  failQueued(threadId: string, message: string): void {
    this.db
      .prepare(`UPDATE plan_execution_links SET status = 'failed', message = ?
      WHERE execution_thread_id = ? AND status = 'queued' AND attempt_id IS NULL`)
      .run(message, threadId);
  }

  recoverInterrupted(): void {
    this.db
      .prepare(`UPDATE plan_execution_links SET status = 'interrupted', message = ?
      WHERE status IN ('queued', 'running')`)
      .run("应用退出时执行尚未结束，请打开执行会话检查结果。");
  }

  threadDeleted(threadId: string): void {
    this.db
      .prepare(`UPDATE plan_execution_links SET status = 'interrupted', message = ?
      WHERE execution_thread_id = ? AND status IN ('queued', 'running')`)
      .run("执行会话已删除。", threadId);
    this.db.exec(`DELETE FROM plan_execution_links
      WHERE NOT EXISTS (SELECT 1 FROM threads WHERE id = source_thread_id)
      AND NOT EXISTS (SELECT 1 FROM threads WHERE id = execution_thread_id);
      DELETE FROM plan_reference_snapshots
      WHERE NOT EXISTS (SELECT 1 FROM threads WHERE id = source_thread_id)
      AND NOT EXISTS (SELECT 1 FROM plan_execution_links WHERE plan_id = plan_reference_snapshots.id);`);
  }

  links(threadId: string): PlanExecutionLink[] {
    return this.db
      .prepare(`SELECT e.id, e.plan_id AS planId, p.version, p.title AS planTitle,
      e.source_thread_id AS sourceThreadId, COALESCE(s.title, p.title) AS sourceTitle,
      s.id IS NULL AS sourceDeleted, e.execution_thread_id AS executionThreadId,
      COALESCE(t.title, e.execution_thread_id) AS executionTitle, t.id IS NULL AS executionDeleted,
      e.attempt_id AS attemptId, e.status, e.message, e.created_at AS createdAt
      FROM plan_execution_links e JOIN plan_reference_snapshots p ON p.id = e.plan_id
      LEFT JOIN threads s ON s.id = e.source_thread_id LEFT JOIN threads t ON t.id = e.execution_thread_id
      WHERE e.source_thread_id = ? OR e.execution_thread_id = ? ORDER BY e.created_at DESC`)
      .all(threadId, threadId)
      .map((row) => {
        const link = row as unknown as PlanExecutionLink & { attemptId: string | null };
        const { attemptId, ...rest } = link;
        return {
          ...rest,
          sourceDeleted: Boolean(link.sourceDeleted),
          executionDeleted: Boolean(link.executionDeleted),
          ...(attemptId ? { attemptId } : {}),
        };
      });
  }
}
