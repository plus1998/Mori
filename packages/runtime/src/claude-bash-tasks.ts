export interface ClaudeBashTaskSnapshot {
  taskId: string;
  taskType: string;
  description: string;
  isBackgrounded?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Merge foreground lifecycle edges with the SDK's background-only level signal. */
export class ClaudeBashTaskTracker {
  private readonly tasks = new Map<string, ClaudeBashTaskSnapshot>();
  private readonly ended = new Set<string>();

  apply(message: unknown): ClaudeBashTaskSnapshot[] | undefined {
    if (!isRecord(message)) return;
    const event = message;
    if (event.type !== "system") return;
    const patch = isRecord(event.patch) ? event.patch : {};
    if (event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
      const tasks = event.tasks.filter(isRecord);
      const ids = new Set(tasks.map((task) => task.task_id));
      for (const [id, task] of this.tasks) {
        if (task.isBackgrounded && !ids.has(id)) this.tasks.delete(id);
      }
      for (const task of tasks) this.upsert(task, true);
    } else if (event.subtype === "task_started") {
      if (typeof event.task_id !== "string") return;
      this.ended.delete(event.task_id);
      this.upsert(event, event.is_backgrounded === true);
    } else if (
      event.subtype === "task_notification" ||
      (event.subtype === "task_updated" &&
        typeof patch.status === "string" &&
        ["completed", "failed", "killed", "stopped"].includes(patch.status))
    ) {
      if (typeof event.task_id !== "string") return;
      this.ended.add(event.task_id);
      this.tasks.delete(event.task_id);
    } else if (
      event.subtype === "task_updated" &&
      typeof event.task_id === "string" &&
      typeof patch.is_backgrounded === "boolean"
    ) {
      const task = this.tasks.get(event.task_id);
      if (task) task.isBackgrounded = patch.is_backgrounded;
    } else return;
    return [...this.tasks.values()];
  }

  private upsert(task: Record<string, unknown>, isBackgrounded: boolean): void {
    if (
      !task ||
      typeof task.task_id !== "string" ||
      !task.task_id.trim() ||
      typeof task.task_type !== "string" ||
      !/^(local_bash|shell|bash)$/i.test(task.task_type) ||
      this.ended.has(task.task_id)
    )
      return;
    this.tasks.set(task.task_id, {
      taskId: task.task_id,
      taskType: task.task_type,
      description: typeof task.description === "string" ? task.description : "",
      isBackgrounded,
    });
  }
}
