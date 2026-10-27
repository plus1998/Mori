import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { resolveCursorAgentExecutable, wrapForWindowsShellScript } from "./acp-cursor-agent.js";

export interface CursorAgentModelOption {
  id: string;
  displayName: string;
  current: boolean;
  default: boolean;
}

export interface CursorAgentModelListOptions {
  executable?: string;
  /** Partial override (e.g. `{ CURSOR_API_KEY }`) merged over process.env. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seam — defaults to `node:child_process.spawn`. */
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
}

/** Builds the env for Cursor Agent CLI children (e.g. CURSOR_API_KEY). */
export function buildCursorAgentCliEnv(env?: NodeJS.ProcessEnv, apiKey?: string): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...env };
  const key = apiKey?.trim();
  if (key) {
    merged.CURSOR_API_KEY = key;
  }
  return merged;
}

/** Reads Cursor's account-owned model catalog without involving Eco providers. */
export async function listCursorAgentModels(
  options: CursorAgentModelListOptions = {},
): Promise<CursorAgentModelOption[]> {
  // Merge the (partial) per-call env over process.env BEFORE resolution:
  // passing only e.g. { CURSOR_API_KEY } would hide HOME/LOCALAPPDATA/PATH
  // and make executable discovery fall back to the bare "agent" (ENOENT on
  // Windows, where CreateProcess only appends .exe).
  const resolvedEnv = buildCursorAgentCliEnv(options.env);
  const executable = resolveCursorAgentExecutable(options.executable, {
    env: resolvedEnv,
  });
  const target = wrapForWindowsShellScript(executable, ["models"]);
  const spawnFn = options.spawnFn ?? spawn;
  const child = spawnFn(target.command, target.args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: resolvedEnv,
    stdio: ["ignore", "pipe", "pipe"],
    ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            `Cursor Agent CLI 未找到（尝试启动: "${executable}"）。请确认已安装 Cursor Agent CLI（https://cursor.com/cli），或在 Mori 设置中配置 Cursor Agent 可执行文件路径 / CURSOR_AGENT_EXECUTABLE 环境变量。`,
          ),
        );
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `Cursor Agent models exited with code ${exitCode}.`);
  }
  const models = parseCursorAgentModelsOutput(stdout);
  if (models.length === 0) {
    throw new Error("Cursor Agent returned no models.");
  }
  return models;
}

export function parseCursorAgentModelsOutput(output: string): CursorAgentModelOption[] {
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g;
  const models: CursorAgentModelOption[] = [];
  for (const rawLine of output.replace(ansi, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === "Available models" || line.startsWith("Tip:")) continue;
    const match = /^(\S+)\s+-\s+(.+?)(?:\s+\(([^)]*)\))?$/.exec(line);
    if (!match) continue;
    const [, id, displayName, flags = ""] = match;
    if (!id || !displayName) continue;
    const normalizedFlags = flags.toLowerCase();
    models.push({
      id,
      displayName: displayName.trim(),
      current: /(^|[ ,])current([ ,]|$)/.test(normalizedFlags),
      default: /(^|[ ,])default([ ,]|$)/.test(normalizedFlags),
    });
  }
  return models;
}
