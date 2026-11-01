import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  BackgroundTerminalListRequest,
  BackgroundTerminalStartRequest,
  BackgroundTerminalStopResult,
  BackgroundTerminalTask,
  TerminalStreamEvent,
} from "../shared/ipc";
import type { InteractiveTerminalManager } from "./interactive-terminal-manager";
import { buildShellCommandLine, resolveCommandExecutable } from "./resolve-command-executable";

function nowIso(): string {
  return new Date().toISOString();
}

const MAX_CAPTURED_OUTPUT_LENGTH = 128 * 1024;

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveDisplayLabel(input: BackgroundTerminalStartRequest): string {
  const explicit = normalizeOptionalText(input.label);
  if (explicit) {
    return explicit;
  }
  return buildShellCommandLine(input.command);
}

function resolveCommand(command: readonly string[]): string[] {
  const executable = command[0]?.trim();
  if (!executable) {
    throw new Error("Background terminal command is required.");
  }
  if (process.platform === "win32" && !executable.includes(path.sep)) {
    return [...command];
  }
  return [resolveCommandExecutable(executable), ...command.slice(1)];
}

function toTaskSummary(task: BackgroundTerminalTask): BackgroundTerminalTask {
  const summary = { ...task };
  delete summary.output;
  delete summary.outputTruncated;
  return summary;
}

export class BackgroundTerminalTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTerminalTask>();
  private readonly stopping = new Map<string, Promise<BackgroundTerminalStopResult>>();

  constructor(
    private readonly terminalManager: InteractiveTerminalManager,
    private readonly onRunningChanged?: () => void,
  ) {}

  start(
    request: BackgroundTerminalStartRequest,
    metadata: { startupScriptId?: string } = {},
  ): BackgroundTerminalTask {
    const workspacePath = path.resolve(request.workspacePath.trim());
    const command = resolveCommand(request.command);
    const threadId = normalizeOptionalText(request.threadId);
    const taskId = randomUUID();
    const startupScriptId = metadata.startupScriptId?.trim();
    let task: BackgroundTerminalTask = {
      taskId,
      workspacePath,
      command,
      label: resolveDisplayLabel({ ...request, command }),
      sessionId: "",
      status: "starting",
      startedAt: nowIso(),
      ...(threadId && { threadId }),
      ...(startupScriptId && { startupScriptId }),
    };

    try {
      const onSessionCreated = (sessionId: string) => {
        task = { ...task, sessionId };
        this.tasks.set(task.taskId, task);
      };
      this.terminalManager.spawnCommand(
        workspacePath,
        command,
        { kind: "command", ...(startupScriptId ? { trackProcessGroup: true } : {}) },
        undefined,
        onSessionCreated,
      );
    } catch (error) {
      this.tasks.delete(taskId);
      throw error;
    }

    const current = this.tasks.get(taskId) ?? task;
    task = current.status === "starting" ? { ...current, status: "running" } : current;
    this.tasks.set(task.taskId, task);
    this.onRunningChanged?.();
    return { ...task };
  }

  list(request: BackgroundTerminalListRequest = {}): BackgroundTerminalTask[] {
    const workspacePath = normalizeOptionalText(request.workspacePath);
    const resolvedWorkspacePath = workspacePath ? path.resolve(workspacePath) : undefined;
    const threadId = normalizeOptionalText(request.threadId);
    const startupScriptId = normalizeOptionalText(request.startupScriptId);
    return [...this.tasks.values()]
      .filter((task) => !resolvedWorkspacePath || task.workspacePath === resolvedWorkspacePath)
      .filter((task) => !threadId || task.threadId === threadId)
      .filter((task) => !startupScriptId || task.startupScriptId === startupScriptId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map(toTaskSummary);
  }

  get(taskId: string): BackgroundTerminalTask | undefined {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : undefined;
  }

  stop(taskId: string): Promise<BackgroundTerminalStopResult> {
    const inFlight = this.stopping.get(taskId);
    if (inFlight) return inFlight;

    const current = this.tasks.get(taskId);
    if (!current) {
      return Promise.resolve({ stopped: false });
    }
    if (current.status !== "starting" && current.status !== "running") {
      return Promise.resolve({ stopped: false, task: { ...current } });
    }

    let operation: Promise<BackgroundTerminalStopResult>;
    operation = Promise.resolve()
      .then(() => this.stopTask(current))
      .finally(() => {
        if (this.stopping.get(taskId) === operation) this.stopping.delete(taskId);
      });
    this.stopping.set(taskId, operation);
    return operation;
  }

  private async stopTask(current: BackgroundTerminalTask): Promise<BackgroundTerminalStopResult> {
    const killed = current.startupScriptId
      ? await this.terminalManager.killProcessGroup(current.sessionId)
      : this.terminalManager.kill(current.sessionId);
    if (!killed) {
      const latest = this.tasks.get(current.taskId) ?? current;
      return { stopped: false, task: { ...latest } };
    }
    const latest = this.tasks.get(current.taskId) ?? current;
    const next: BackgroundTerminalTask = {
      ...latest,
      status: "stopped",
      endedAt: latest.endedAt ?? nowIso(),
    };
    this.tasks.set(current.taskId, next);
    this.onRunningChanged?.();
    return { stopped: killed, task: { ...next } };
  }

  countRunning(): number {
    return [...this.tasks.values()].filter((task) => task.status === "starting" || task.status === "running")
      .length;
  }

  async stopAllRunning(): Promise<void> {
    const runningTasks = [...this.tasks.values()].filter(
      (task) => task.status === "starting" || task.status === "running",
    );
    const results = await Promise.allSettled(runningTasks.map((task) => this.stop(task.taskId)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const incomplete = results.find(
      (result) => result.status === "fulfilled" && !result.value.stopped,
    );
    if (incomplete?.status === "fulfilled") {
      throw new Error(`Failed to stop background terminal task ${incomplete.value.task?.taskId ?? "unknown"}.`);
    }
  }

  handleTerminalEvent(event: TerminalStreamEvent): void {
    const match = [...this.tasks.values()].find((task) => task.sessionId === event.sessionId);
    if (!match) {
      return;
    }

    if (event.type === "output") {
      const combined = `${match.output ?? ""}${event.data}`;
      const outputTruncated = combined.length > MAX_CAPTURED_OUTPUT_LENGTH;
      this.tasks.set(match.taskId, {
        ...match,
        output: outputTruncated ? combined.slice(-MAX_CAPTURED_OUTPUT_LENGTH) : combined,
        ...(outputTruncated || match.outputTruncated ? { outputTruncated: true } : {}),
      });
      return;
    }

    if ((event.type !== "exit" && event.type !== "error") || match.status === "stopped") {
      return;
    }
    if (this.stopping.has(match.taskId)) return;
    const next: BackgroundTerminalTask =
      event.type === "exit"
        ? {
            ...match,
            status: event.exitCode === 0 ? "exited" : "failed",
            exitCode: event.exitCode,
            ...(event.signal !== undefined && { signal: event.signal }),
            endedAt: nowIso(),
          }
        : {
            ...match,
            status: "failed",
            endedAt: nowIso(),
          };
    this.tasks.set(next.taskId, next);
    this.onRunningChanged?.();
  }
}
