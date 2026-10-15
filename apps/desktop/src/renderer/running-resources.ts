import type { BackgroundTerminalTask, TerminalSessionView } from "../shared/ipc";

export interface RunningTerminal extends TerminalSessionView {
  taskId?: string;
  threadId?: string;
}

/** A background task and its PTY describe the same running terminal. */
export function collectRunningTerminals(
  sessions: readonly TerminalSessionView[],
  tasks: readonly BackgroundTerminalTask[],
): RunningTerminal[] {
  const terminals = new Map<string, RunningTerminal>(
    sessions.map((session) => [session.sessionId, { ...session }]),
  );
  for (const task of tasks) {
    if (task.status !== "starting" && task.status !== "running") continue;
    const session = terminals.get(task.sessionId);
    terminals.set(task.sessionId, {
      ...session,
      sessionId: task.sessionId,
      workspacePath: task.workspacePath,
      kind: session?.kind ?? "command",
      label: task.label,
      taskId: task.taskId,
      ...(task.threadId ? { threadId: task.threadId } : {}),
    });
  }
  return [...terminals.values()];
}
