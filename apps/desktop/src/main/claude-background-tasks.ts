import type {
  ClaudeBackgroundTask,
  ClaudeBackgroundTaskStopResult,
} from "../shared/ipc";

export interface ClaudeBackgroundTaskSnapshot {
  taskId: string;
  taskType: string;
  description: string;
}

interface RegisteredClaudeBackgroundTask extends ClaudeBackgroundTask {
  owner: object;
  stopTask(taskId: string): Promise<void>;
  forceClose(): void;
}

export function isClaudeBashTaskType(taskType: string): boolean {
  const normalized = taskType.trim().toLowerCase();
  return normalized === "shell" || normalized.includes("bash") || normalized === "local_bash";
}

/**
 * Producer-owned Claude background task registry. Task IDs are meaningful only
 * inside the Query that emitted them, so each entry retains the exact stopTask
 * closure for that Query.
 */
export class ClaudeBackgroundTaskRegistry {
  private readonly tasks = new Map<string, RegisteredClaudeBackgroundTask>();
  private readonly stopTaskTimeoutMs: number;

  constructor(options: { stopTaskTimeoutMs?: number } = {}) {
    this.stopTaskTimeoutMs = Math.max(1, options.stopTaskTimeoutMs ?? 2_000);
  }

  replaceThread(input: {
    threadId: string;
    workspacePath: string;
    owner: object;
    tasks: readonly ClaudeBackgroundTaskSnapshot[];
    stopTask(taskId: string): Promise<void>;
    forceClose(): void;
  }): void {
    const threadId = input.threadId.trim();
    const workspacePath = input.workspacePath.trim();
    if (!threadId || !workspacePath) {
      return;
    }
    for (const [key, task] of this.tasks) {
      // background_tasks_changed is a level snapshot for the active thread Query.
      // Replace the entire thread set so a restarted Query cannot inherit stale IDs.
      if (task.threadId === threadId) {
        this.tasks.delete(key);
      }
    }
    for (const task of input.tasks) {
      const taskId = task.taskId.trim();
      if (!taskId || !isClaudeBashTaskType(task.taskType)) {
        continue;
      }
      const label = task.description.trim() || `Claude Bash ${taskId}`;
      this.tasks.set(taskKey(threadId, taskId), {
        threadId,
        taskId,
        workspacePath,
        label,
        status: "running",
        taskType: task.taskType.trim(),
        owner: input.owner,
        stopTask: input.stopTask,
        forceClose: input.forceClose,
      });
    }
  }

  list(threadId?: string): ClaudeBackgroundTask[] {
    const normalizedThreadId = threadId?.trim();
    return [...this.tasks.values()]
      .filter((task) => !normalizedThreadId || task.threadId === normalizedThreadId)
      .map(({ owner: _owner, stopTask: _stopTask, forceClose: _forceClose, ...task }) => ({ ...task }))
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
    let mode: "task" | "query" = "task";
    try {
      await withTimeout(task.stopTask(normalizedTaskId), this.stopTaskTimeoutMs);
    } catch {
      mode = "query";
      task.forceClose();
    }
    if (this.tasks.get(key) === task) {
      this.tasks.delete(key);
    }
    return { stopped: true, mode };
  }

  clearThread(threadId: string, owner: object): void {
    for (const [key, task] of this.tasks) {
      if (task.threadId === threadId && task.owner === owner) {
        this.tasks.delete(key);
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
