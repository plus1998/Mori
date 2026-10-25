import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IPty } from "node-pty";
import * as pty from "node-pty";
import type { TerminalSessionKind, TerminalSessionView, TerminalStreamEvent } from "../shared/ipc";
import { normalizeTerminalStartupCommand } from "../shared/project-terminal-settings";
import {
  buildWindowsCommandLine,
  needsWindowsShellWrapper,
  toSpawnEnv,
} from "./resolve-command-executable";

export type TerminalEventEmitter = (event: TerminalStreamEvent) => void;

export interface InteractiveTerminalManagerOptions {
  /**
   * Merge PTY `onData` chunks into fewer `output` events.
   * `0` disables batching (emit immediately). Default `32` (1Panel-style ~60ms
   * softened for local IPC so interactive typing still feels snappy).
   */
  outputCoalesceMs?: number;
}

/**
 * Identity carried by a PTY so a restored/live session can be re-labelled in the
 * tab strip. Without it an SSH session would come back as a generic shell tab.
 */
export interface TerminalSessionDescriptor {
  kind?: TerminalSessionKind;
  label?: string;
  endpoint?: string;
}

interface ActiveTerminalSession {
  sessionId: string;
  workspacePath: string;
  kind: TerminalSessionKind;
  label?: string;
  endpoint?: string;
  pty: IPty;
}

interface PendingOutput {
  chunks: string[];
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_OUTPUT_COALESCE_MS = 32;

function resolveInteractiveShell(): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec?.trim();
    if (comspec) {
      return { executable: comspec, args: [] };
    }
    return { executable: "powershell.exe", args: [] };
  }

  const shell = process.env.SHELL?.trim() || "/bin/bash";
  const name = shell.split("/").pop() ?? "";
  if (name === "zsh" || name === "bash") {
    return { executable: shell, args: ["-l"] };
  }
  return { executable: shell, args: [] };
}

/**
 * argv that runs a one-line shell command in the user's login+interactive shell,
 * so rc-file setup (nvm as a shell function, PATH, aliases) is available for
 * `&&`-chained prefixes. Only used when a script has a leading command.
 */
export function buildShellCommandInvocation(line: string): string[] {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec?.trim() || "cmd.exe";
    return [comspec, "/d", "/s", "/c", line];
  }
  const { executable, args } = resolveInteractiveShell();
  if (args.includes("-l")) {
    return [executable, "-l", "-i", "-c", line];
  }
  return [executable, "-c", line];
}

function resolvePtySize(size?: { cols: number; rows: number }): { cols: number; rows: number } {
  const cols = size?.cols;
  const rows = size?.rows;
  return {
    cols:
      cols !== undefined && Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : DEFAULT_COLS,
    rows:
      rows !== undefined && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_ROWS,
  };
}

export class InteractiveTerminalManager {
  private readonly sessions = new Map<string, ActiveTerminalSession>();
  private readonly pendingOutput = new Map<string, PendingOutput>();
  private readonly outputCoalesceMs: number;

  constructor(
    private readonly emit: TerminalEventEmitter,
    options?: InteractiveTerminalManagerOptions,
  ) {
    const coalesceMs = options?.outputCoalesceMs;
    this.outputCoalesceMs =
      coalesceMs !== undefined && Number.isFinite(coalesceMs) && coalesceMs >= 0
        ? Math.floor(coalesceMs)
        : DEFAULT_OUTPUT_COALESCE_MS;
  }

  spawn(
    workspacePath: string,
    size?: { cols: number; rows: number },
    startupCommand = "",
  ): { sessionId: string } {
    const command = normalizeTerminalStartupCommand(startupCommand);
    const { executable, args } = resolveInteractiveShell();
    const result = this.spawnProcess(workspacePath, executable, args, size);
    if (command) {
      // Queue input in the PTY: the login shell loads its rc files before reading
      // these commands. Running in this shell preserves nvm/venv environment changes.
      try {
        this.write(result.sessionId, `${command.replace(/\n/g, "\r")}\r`);
      } catch (error) {
        this.kill(result.sessionId);
        throw error;
      }
    }
    return result;
  }

  spawnCommand(
    workspacePath: string,
    command: readonly string[],
    descriptor?: TerminalSessionDescriptor,
    size?: { cols: number; rows: number },
  ): { sessionId: string } {
    const executable = command[0]?.trim();
    if (!executable) {
      throw new Error("Terminal command is required.");
    }
    if (process.platform === "win32" && needsWindowsShellWrapper(executable)) {
      const comspec = process.env.ComSpec?.trim() || "cmd.exe";
      const line = buildWindowsCommandLine([...command]);
      return this.spawnProcess(workspacePath, comspec, ["/d", "/s", "/c", line], size, undefined, {
        kind: "command",
        ...descriptor,
      });
    }
    return this.spawnProcess(workspacePath, executable, command.slice(1), size, undefined, {
      kind: "command",
      ...descriptor,
    });
  }

  spawnCommandWithEnv(
    workspacePath: string,
    executable: string,
    args: readonly string[],
    envOverrides: Record<string, string>,
    descriptor?: TerminalSessionDescriptor,
    size?: { cols: number; rows: number },
  ): { sessionId: string } {
    const resolvedExecutable = executable.trim();
    if (!resolvedExecutable) {
      throw new Error("Terminal command is required.");
    }
    return this.spawnProcess(workspacePath, resolvedExecutable, args, size, envOverrides, descriptor);
  }

  private spawnProcess(
    workspacePath: string,
    executable: string,
    args: readonly string[],
    size?: { cols: number; rows: number },
    envOverrides?: Record<string, string>,
    descriptor?: TerminalSessionDescriptor,
  ): { sessionId: string } {
    const cwd = workspacePath.trim();
    if (!cwd) {
      throw new Error("Workspace path is required.");
    }
    if (!existsSync(cwd)) {
      throw new Error(`Workspace directory does not exist: ${cwd}`);
    }

    const sessionId = randomUUID();
    const { cols, rows } = resolvePtySize(size);
    const env = envOverrides ? { ...toSpawnEnv(), ...envOverrides } : toSpawnEnv();

    let ptyProcess: IPty;
    try {
      ptyProcess = pty.spawn(executable, [...args], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to start interactive terminal: ${detail}`);
    }

    const label = descriptor?.label?.trim();
    const endpoint = descriptor?.endpoint?.trim();
    this.sessions.set(sessionId, {
      sessionId,
      workspacePath: cwd,
      kind: descriptor?.kind ?? "local",
      ...(label ? { label } : {}),
      ...(endpoint ? { endpoint } : {}),
      pty: ptyProcess,
    });
    this.emit({ type: "started", sessionId, workspacePath: cwd });

    ptyProcess.onData((data) => {
      if (!this.sessions.has(sessionId)) {
        return;
      }
      this.queueOutput(sessionId, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      if (!this.sessions.has(sessionId)) {
        this.discardPendingOutput(sessionId);
        return;
      }
      this.sessions.delete(sessionId);
      this.flushOutput(sessionId);
      this.emit({
        type: "exit",
        sessionId,
        exitCode: exitCode ?? 1,
        ...(signal !== undefined && { signal }),
      });
    });

    return { sessionId };
  }

  write(sessionId: string, data: string): void {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`);
    }
    session.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.getSession(sessionId);
    if (!session) {
      return;
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
      return;
    }
    session.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  kill(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) {
      return false;
    }
    this.flushOutput(sessionId);
    session.pty.kill();
    this.sessions.delete(sessionId);
    this.discardPendingOutput(sessionId);
    return true;
  }

  killAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.kill(sessionId);
    }
  }

  get(sessionId: string): ActiveTerminalSession | undefined {
    return this.getSession(sessionId);
  }

  list(workspacePath?: string): TerminalSessionView[] {
    const normalizedWorkspacePath = workspacePath?.trim();
    return [...this.sessions.values()]
      .filter((session) => !normalizedWorkspacePath || session.workspacePath === normalizedWorkspacePath)
      .map((session) => ({
        sessionId: session.sessionId,
        workspacePath: session.workspacePath,
        kind: session.kind,
        ...(session.label ? { label: session.label } : {}),
        ...(session.endpoint ? { endpoint: session.endpoint } : {}),
      }));
  }

  private getSession(sessionId: string): ActiveTerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  private queueOutput(sessionId: string, data: string): void {
    if (this.outputCoalesceMs <= 0) {
      this.emit({ type: "output", sessionId, data });
      return;
    }

    let pending = this.pendingOutput.get(sessionId);
    if (!pending) {
      pending = { chunks: [], timer: undefined };
      this.pendingOutput.set(sessionId, pending);
    }
    pending.chunks.push(data);
    if (pending.timer !== undefined) {
      return;
    }
    pending.timer = setTimeout(() => {
      this.flushOutput(sessionId);
    }, this.outputCoalesceMs);
  }

  private flushOutput(sessionId: string): void {
    const pending = this.pendingOutput.get(sessionId);
    if (!pending) {
      return;
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    this.pendingOutput.delete(sessionId);
    if (pending.chunks.length === 0) {
      return;
    }
    this.emit({ type: "output", sessionId, data: pending.chunks.join("") });
  }

  private discardPendingOutput(sessionId: string): void {
    const pending = this.pendingOutput.get(sessionId);
    if (!pending) {
      return;
    }
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    this.pendingOutput.delete(sessionId);
  }
}
