import type {
  BackgroundTerminalTask,
  CodexBackgroundTerminal,
  TerminalSessionView,
} from "../shared/ipc";

export interface RunningTerminal extends TerminalSessionView {
  taskId?: string;
  threadId?: string;
  codexThreadId?: string;
  codexProcessId?: string;
  osPid?: number;
  cpuPercent?: number;
  rssKb?: number;
}

/** A background task and its PTY describe the same running terminal. */
export function collectRunningTerminals(
  sessions: readonly TerminalSessionView[],
  tasks: readonly BackgroundTerminalTask[],
  codexTerminals: readonly CodexBackgroundTerminal[] = [],
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
  for (const terminal of codexTerminals) {
    const key = `codex:${terminal.codexThreadId}:${terminal.processId}`;
    terminals.set(key, {
      sessionId: key,
      workspacePath: terminal.workspacePath,
      kind: "command",
      label: terminal.command.split(/\r?\n/, 1)[0]?.trim() || terminal.command,
      threadId: terminal.threadId,
      codexThreadId: terminal.codexThreadId,
      codexProcessId: terminal.processId,
      ...(terminal.osPid !== undefined && { osPid: terminal.osPid }),
      ...(terminal.cpuPercent !== undefined && { cpuPercent: terminal.cpuPercent }),
      ...(terminal.rssKb !== undefined && { rssKb: terminal.rssKb }),
    });
  }
  return [...terminals.values()];
}
