import type { CoreKind } from "@eco/runtime/core-runtime";
import type { ThreadPendingPlan, ThreadSummary } from "./ipc";
import type { ThreadRuntimeConfig } from "./thread-runtime-config";

export interface MultiAgentsMember {
  id: string;
  name: string;
  responsibility: string;
  coreKind: CoreKind;
  runtimeConfig: ThreadRuntimeConfig;
}

export interface MultiAgentsConfig {
  id: string;
  name: string;
  mode: "sessions" | "subagents";
  members: MultiAgentsMember[];
  agentKeys: string[];
  maxConcurrency: number;
}

export interface MultiAgentsTaskInput {
  id: string;
  memberId: string;
  title: string;
  instructions: string;
  scope: string[];
  dependsOn: string[];
  acceptance: string;
}

export type MultiAgentsTaskStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
export interface MultiAgentsTask extends MultiAgentsTaskInput {
  status: MultiAgentsTaskStatus;
  attempt: number;
  threadId?: string;
  baseCommit?: string;
  resultCommit?: string;
  result?: string;
  error?: string;
  reported?: boolean;
  reportAttemptId?: string;
  integratedCommit?: string;
  integrationError?: string;
  integrationResolution?: { review: string; workspaceCommit: string };
  history?: {
    attempt: number;
    status: MultiAgentsTaskStatus;
    result?: string;
    error?: string;
    baseCommit?: string;
    resultCommit?: string;
    integratedCommit?: string;
  }[];
}

export interface MultiAgentsRun {
  id: string;
  sourceThreadId: string;
  config: MultiAgentsConfig;
  plan?: ThreadPendingPlan;
  /** Agent-mode request selected through an explicit @Multi-Agents reference. */
  request?: string;
  additionalMessage: string;
  status: "planning" | "running" | "awaiting_review" | "completed" | "paused" | "cancelled" | "interrupted";
  tasks: MultiAgentsTask[];
  baselineCommit?: string;
  workspacePath: string;
  review?: string;
  message?: string;
  revision: number;
  notifiedRevision: number;
  pendingNotification?: { id: string; text: string };
  createdAt: string;
}

export interface MultiAgentsSnapshot {
  configs: MultiAgentsConfig[];
  runs: MultiAgentsRun[];
  groups?: { source: ThreadSummary; children: ThreadSummary[] }[];
}

export const MULTI_AGENTS_CHANGED = "thread.multi_agents_updated";

export const MULTI_AGENTS_STATUS_LABELS: Record<MultiAgentsRun["status"] | MultiAgentsTaskStatus, string> = {
  planning: "待拆分",
  running: "执行中",
  awaiting_review: "待主代理验收",
  completed: "已验收",
  paused: "已暂停",
  cancelled: "已停止",
  interrupted: "已中断",
  queued: "等待依赖 / 调度",
  succeeded: "执行完成，待验收",
  failed: "失败",
  blocked: "阻塞",
};

export function validateMultiAgentsTasks(tasks: MultiAgentsTaskInput[], config: MultiAgentsConfig): void {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 64) throw new Error("每次提交 1–64 个任务。");
  const ids = new Set<string>();
  for (const task of tasks) {
    if (
      task &&
      Object.keys(task).some(
        (key) =>
          !["id", "memberId", "title", "instructions", "scope", "dependsOn", "acceptance"].includes(key),
      )
    )
      throw new Error("任务只允许包含派发字段，不能指定会话、账号或执行状态。");
    if (!task || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.id) || ids.has(task.id))
      throw new Error("任务 ID 必须唯一，且仅含字母、数字、横线或下划线。");
    ids.add(task.id);
    if (!config.members.some((member) => member.id === task.memberId))
      throw new Error(`未知成员：${task.memberId}`);
    for (const key of ["title", "instructions", "acceptance"] as const)
      if (typeof task[key] !== "string" || !task[key].trim())
        throw new Error(`任务 ${task.id} 缺少 ${key}。`);
    for (const key of ["scope", "dependsOn"] as const)
      if (!Array.isArray(task[key]) || task[key].some((value) => typeof value !== "string" || !value.trim()))
        throw new Error(`任务 ${task.id} 的 ${key} 无效。`);
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("任务依赖不能成环。");
    if (visited.has(id)) return;
    const task = tasks.find((value) => value.id === id);
    if (!task) throw new Error(`依赖任务不存在：${id}`);
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  tasks.forEach((task) => visit(task.id));
}
