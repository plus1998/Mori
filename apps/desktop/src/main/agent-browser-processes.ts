import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentBrowserProcessView } from "../shared/browser";

export const AGENT_BROWSER_IDLE_TIMEOUT_MS = 5 * 60_000;
const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Session = {
  sessionKey: string;
  binaryPath: string;
  otherBinaryPaths?: string[];
  socketDir: string;
  threadId?: string;
  browserId?: string;
  pid?: number;
  pidWrittenAt?: number;
  error?: string;
  calls: Map<AbortController, Promise<unknown>>;
  stopping?: Promise<void>;
};
type SessionInput = Pick<Session, "sessionKey" | "binaryPath" | "threadId" | "browserId"> & {
  env: Record<string, string>;
};

/** Read executable identity, not command arguments that may contain an app path. */
type ProcessIdentity = { executable: string; startedAt: number };
async function inspectProcesses(pids: number[]): Promise<Map<number, ProcessIdentity>> {
  if (!pids.length) return new Map();
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter '${pids.map((pid) => `ProcessId=${pid}`).join(" OR ")}' | Select-Object ProcessId,ExecutablePath,@{N='StartedAt';E={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true, timeout: 5000 },
    );
    const rows = stdout.trim() ? JSON.parse(stdout) : [];
    return new Map(
      (Array.isArray(rows) ? rows : [rows]).map((row) => [
        Number(row.ProcessId),
        { executable: String(row.ExecutablePath ?? ""), startedAt: Number(row.StartedAt) },
      ]),
    );
  }
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(
      "ps",
      ["-p", pids.join(","), "-o", "pid=,stat=,lstart=,comm="],
      { timeout: 5000, env: { ...process.env, LC_ALL: "C" } },
    ));
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    if (result.code !== 1 || result.stdout?.trim() || result.stderr?.trim()) throw error;
    return new Map(); // ps exits 1 when none of the requested PIDs exist.
  }
  const result = new Map<number, ProcessIdentity>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
    if (line.trim() && !match) throw new Error("无法识别 agent-browser 的系统进程信息。");
    if (match && !match[2]?.includes("Z")) {
      const pid = Number(match[1]);
      let executable = match[4] ?? "";
      if (process.platform === "linux") {
        try {
          executable = await fs.promises.readlink(`/proc/${pid}/exe`);
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          throw error;
        }
      }
      const startedAt = Date.parse(match[3] ?? "");
      if (!Number.isFinite(startedAt)) throw new Error(`无法读取进程启动时间（PID ${pid}）。`);
      result.set(pid, { executable, startedAt });
    }
  }
  return result;
}

function canonical(executable: string): string {
  return fs.realpathSync.native(executable);
}

/** Owns only sessions in this Eco user-data directory; dev and production stay separate. */
export class AgentBrowserProcesses {
  private readonly sessions = new Map<string, Session>();
  private readonly closingRoots = new Set<string>();

  beginShutdown(root: string): void {
    this.closingRoots.add(root);
  }
  constructor(
    private readonly deps = {
      inspect: inspectProcesses,
      signal: process.kill,
      delay: sleep,
      timeoutMs: 1500,
    },
  ) {}

  private register(input: SessionInput): Session {
    const socketDir = input.env.AGENT_BROWSER_SOCKET_DIR;
    if (!socketDir || path.basename(socketDir) !== input.sessionKey) {
      throw new Error("agent-browser 缺少 Mori 专属的会话进程目录。");
    }
    let session = this.sessions.get(socketDir);
    if (!session) {
      session = {
        sessionKey: input.sessionKey,
        binaryPath: canonical(input.binaryPath),
        socketDir,
        calls: new Map(),
      };
      this.sessions.set(socketDir, session);
    }
    if (input.threadId) session.threadId = input.threadId;
    if (input.browserId) session.browserId = input.browserId;
    return session;
  }

  private metadataPath(session: Pick<Session, "socketDir" | "sessionKey">): string {
    return path.join(session.socketDir, `${session.sessionKey}.eco-process.json`);
  }

  private readPid(session: Session): void {
    try {
      const pidFile = path.join(session.socketDir, `${session.sessionKey}.pid`);
      const raw = fs.readFileSync(pidFile, "utf8").trim();
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 1) {
        throw new Error(`无效的 agent-browser PID：${raw}`);
      }
      session.pid = Number(raw);
      session.pidWrittenAt = fs.statSync(pidFile).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async run<T>(
    input: SessionInput,
    signal: AbortSignal | undefined,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const session = this.register(input);
    if (this.closingRoots.has(path.dirname(session.socketDir)))
      throw new Error("Mori 正在退出，不能启动浏览器自动化进程。");
    if (session.stopping) throw new Error("浏览器自动化进程正在停止，请稍后重试。");
    const clientBinary = canonical(input.binaryPath);
    if (clientBinary !== session.binaryPath) {
      session.otherBinaryPaths = [...new Set([...(session.otherBinaryPaths ?? []), clientBinary])];
    }
    fs.writeFileSync(
      this.metadataPath(session),
      JSON.stringify({
        binaryPath: session.binaryPath,
        binaryPaths: [session.binaryPath, ...(session.otherBinaryPaths ?? [])],
        ...(session.threadId ? { threadId: session.threadId } : {}),
        ...(session.browserId ? { browserId: session.browserId } : {}),
      }),
      { mode: 0o600 },
    );
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const call = Promise.resolve().then(() => execute(combined));
    session.calls.set(controller, call);
    try {
      return await call;
    } finally {
      session.calls.delete(controller);
      this.readPid(session);
    }
  }

  private discover(root: string, binaryPath: string, owners: ReadonlyMap<string, string>): void {
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory() || !/^e[a-f0-9]{10}$/.test(dir.name)) continue;
      const socketDir = path.join(root, dir.name);
      let metadata:
        | { binaryPath: string; binaryPaths?: string[]; threadId?: string; browserId?: string }
        | undefined;
      try {
        const value = JSON.parse(
          fs.readFileSync(this.metadataPath({ socketDir, sessionKey: dir.name }), "utf8"),
        );
        if (
          typeof value.binaryPath !== "string" ||
          !path.isAbsolute(value.binaryPath) ||
          (value.binaryPaths !== undefined &&
            (!Array.isArray(value.binaryPaths) ||
              !value.binaryPaths.every(
                (entry: unknown) => typeof entry === "string" && path.isAbsolute(entry),
              ))) ||
          (value.threadId !== undefined && typeof value.threadId !== "string") ||
          (value.browserId !== undefined && typeof value.browserId !== "string")
        ) {
          throw new Error(`无效的 agent-browser 进程归属记录：${dir.name}`);
        }
        metadata = value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const threadId = metadata?.threadId ?? owners.get(dir.name);
      if (metadata && !this.sessions.has(socketDir)) {
        this.sessions.set(socketDir, {
          sessionKey: dir.name,
          socketDir,
          binaryPath: metadata.binaryPath,
          calls: new Map(),
          ...(metadata.binaryPaths ? { otherBinaryPaths: metadata.binaryPaths } : {}),
          ...(threadId ? { threadId } : {}),
          ...(metadata.browserId ? { browserId: metadata.browserId } : {}),
        });
      }
      const existing = this.sessions.get(socketDir);
      if (existing && metadata) {
        existing.otherBinaryPaths = [
          ...new Set([
            ...(existing.otherBinaryPaths ?? []),
            metadata.binaryPath,
            ...(metadata.binaryPaths ?? []),
          ]),
        ];
      }
      this.register({
        sessionKey: dir.name,
        binaryPath,
        env: { AGENT_BROWSER_SOCKET_DIR: socketDir },
        ...(threadId ? { threadId } : {}),
      });
    }
  }

  async list(
    root: string,
    binaryPath: string,
    owners: ReadonlyMap<string, string> = new Map(),
  ): Promise<AgentBrowserProcessView[]> {
    this.discover(root, binaryPath, owners);
    const sessions = [...this.sessions.values()].filter(
      (session) => path.dirname(session.socketDir) === root,
    );
    for (const session of sessions) this.readPid(session);
    const processes = await this.deps.inspect(
      sessions.flatMap((session) => (session.pid ? [session.pid] : [])),
    );
    return sessions.flatMap((session) => {
      if (!session.pid || !this.matches(session, processes.get(session.pid))) return [];
      return [
        {
          id: session.sessionKey,
          pid: session.pid,
          ...(session.threadId ? { threadId: session.threadId } : {}),
          ...(session.browserId ? { browserId: session.browserId } : {}),
          state: session.stopping
            ? ("stopping" as const)
            : session.calls.size
              ? ("active" as const)
              : ("idle" as const),
          ...(session.error ? { error: session.error } : {}),
        },
      ];
    });
  }

  private async ownsPid(session: Session, pid: number): Promise<boolean> {
    return this.matches(session, (await this.deps.inspect([pid])).get(pid));
  }

  private matches(session: Session, identity: ProcessIdentity | undefined): boolean {
    // The PID file is written at daemon startup. Reject stale files whose PID
    // was reused, even if the replacement happens to run the same binary.
    const age = (session.pidWrittenAt ?? 0) - (identity?.startedAt ?? Number.NaN);
    const executableMatches = [session.binaryPath, ...(session.otherBinaryPaths ?? [])].some((executable) =>
      process.platform === "win32"
        ? identity?.executable.toLowerCase() === executable.toLowerCase()
        : identity?.executable === executable,
    );
    return executableMatches && age >= 0 && age < 10_000;
  }

  private async stopSession(session: Session): Promise<void> {
    for (const controller of session.calls.keys()) controller.abort(new Error("浏览器自动化进程已停止。"));
    const hadCalls = session.calls.size > 0;
    await Promise.allSettled(session.calls.values());
    // An interrupted CLI may already have forked a daemon which is still writing its PID.
    if (hadCalls) await this.deps.delay(250);
    this.readPid(session);
    const pid = session.pid;
    if (!pid) return;
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (!(await this.ownsPid(session, pid))) return;
      try {
        this.deps.signal(pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      for (let elapsed = 0; elapsed < this.deps.timeoutMs; elapsed += 100) {
        await this.deps.delay(100);
        if (!(await this.ownsPid(session, pid))) return;
      }
    }
    throw new Error(`agent-browser 进程未退出（PID ${pid}，会话 ${session.sessionKey}）。`);
  }

  async stop(root: string, ids?: ReadonlySet<string>): Promise<void> {
    const sessions = [...this.sessions.values()].filter(
      (session) => path.dirname(session.socketDir) === root && (!ids || ids.has(session.sessionKey)),
    );
    const results = await Promise.allSettled(
      sessions.map((session) => {
        if (!session.stopping) {
          const stopping = this.stopSession(session)
            .then(() => {
              this.sessions.delete(session.socketDir);
            })
            .catch((error) => {
              session.error = error instanceof Error ? error.message : String(error);
              throw error;
            })
            .finally(() => {
              delete session.stopping;
            });
          session.stopping = stopping;
        }
        return session.stopping;
      }),
    );
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, errors.map((error) => String(error)).join("\n"));
  }
}

export const agentBrowserProcesses = new AgentBrowserProcesses();
