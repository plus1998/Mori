import type { ClaudeBackgroundTask, ClaudeBackgroundTaskStopResult } from "../shared/ipc";

export interface ClaudeBackgroundTaskSnapshot {
  taskId: string;
  taskType: string;
  description: string;
  isBackgrounded?: boolean;
}

interface RegisteredClaudeBackgroundTask extends ClaudeBackgroundTask {
  owner: object;
  stopTask(taskId: string): Promise<void>;
  confirmations: Set<(confirmed: boolean) => void>;
  stopping?: Promise<ClaudeBackgroundTaskStopResult>;
}

export function isClaudeBashTaskType(taskType: string): boolean {
  const normalized = taskType.trim().toLowerCase();
  return normalized === "shell" || normalized.includes("bash") || normalized === "local_bash";
}

/**
 * Producer-owned Claude Bash task registry. Task IDs are meaningful only
 * inside the Query that emitted them, so each entry retains the exact stopTask
 * closure for that Query.
 */
export class ClaudeBackgroundTaskRegistry {
  private readonly tasks = new Map<string, RegisteredClaudeBackgroundTask>();
  private readonly stopTaskTimeoutMs: number;

  constructor(options: { stopTaskTimeoutMs?: number } = {}) {
    this.stopTaskTimeoutMs = Math.max(1, options.stopTaskTimeoutMs ?? 5_000);
  }

  replaceThread(input: {
    threadId: string;
    workspacePath: string;
    owner: object;
    tasks: readonly ClaudeBackgroundTaskSnapshot[];
    stopTask(taskId: string): Promise<void>;
  }): void {
    const threadId = input.threadId.trim();
    const workspacePath = input.workspacePath.trim();
    if (!threadId || !workspacePath) {
      return;
    }
    const nextIds = new Set(
      input.tasks.filter((task) => isClaudeBashTaskType(task.taskType)).map((task) => task.taskId.trim()),
    );
    for (const [key, task] of this.tasks) {
      if (task.threadId !== threadId) continue;
      if (task.owner !== input.owner || !nextIds.has(task.taskId)) {
        this.tasks.delete(key);
        for (const confirm of task.confirmations) confirm(task.owner === input.owner);
      }
    }
    for (const task of input.tasks) {
      const taskId = task.taskId.trim();
      if (!taskId || !isClaudeBashTaskType(task.taskType)) continue;
      const key = taskKey(threadId, taskId);
      const current = this.tasks.get(key);
      const fields = {
        threadId,
        taskId,
        workspacePath,
        label: task.description.trim() || `Claude Bash ${taskId}`,
        status: "running" as const,
        taskType: task.taskType.trim(),
        ...(task.isBackgrounded !== undefined && { isBackgrounded: task.isBackgrounded }),
        owner: input.owner,
        stopTask: input.stopTask,
      };
      if (current) Object.assign(current, fields);
      else this.tasks.set(key, { ...fields, confirmations: new Set() });
    }
  }

  list(threadId?: string): ClaudeBackgroundTask[] {
    const normalizedThreadId = threadId?.trim();
    return [...this.tasks.values()]
      .filter((task) => !normalizedThreadId || task.threadId === normalizedThreadId)
      .map(
        ({
          owner: _owner,
          stopTask: _stopTask,
          confirmations: _confirmations,
          stopping: _stopping,
          ...task
        }) => ({ ...task }),
      )
      .sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  async stop(threadId: string, taskId: string): Promise<ClaudeBackgroundTaskStopResult> {
    const normalizedThreadId = threadId.trim();
    const normalizedTaskId = taskId.trim();
    const key = taskKey(normalizedThreadId, normalizedTaskId);
    const task = this.tasks.get(key);
    if (!task) {
      return { stopped: false };
    }
    if (task.stopping) return task.stopping;
    let confirm!: (confirmed: boolean) => void;
    const confirmation = new Promise<void>((resolve, reject) => {
      confirm = (confirmed) =>
        confirmed
          ? resolve()
          : reject(new Error("Claude Query closed before Bash termination was confirmed."));
      task.confirmations.add(confirm);
    });
    const operation = withTimeout(
      Promise.all([Promise.resolve().then(() => task.stopTask(normalizedTaskId)), confirmation]).then(
        () => {},
      ),
      this.stopTaskTimeoutMs,
    ).then(() => ({ stopped: true, mode: "task" as const }));
    task.stopping = operation;
    try {
      return await operation;
    } finally {
      task.confirmations.delete(confirm);
      delete task.stopping;
    }
  }

  clearThread(threadId: string, owner: object): void {
    for (const [key, task] of this.tasks) {
      if (task.threadId === threadId && task.owner === owner) {
        this.tasks.delete(key);
        for (const confirm of task.confirmations) confirm(false);
      }
    }
  }
}

function taskKey(threadId: string, taskId: string): string {
  return `${threadId}\0${taskId}`;
}

async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Claude stopTask timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
