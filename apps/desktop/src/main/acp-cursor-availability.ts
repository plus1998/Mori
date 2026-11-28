import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  AcpClient,
  AcpJsonRpcPeer,
  agentSupportsSessionDelete,
  cursorAcpSpawnError,
  isAcpSessionDeleteMethodNotFound,
  killChildProcessTree,
  parseAcpAvailableModels,
  removeCursorAcpSessionDir,
  resolveCursorAgentExecutable,
  type AcpInitializeResult,
  spawnCursorAcpProcess,
} from "@eco/runtime";
import type { CursorModelOption } from "../shared/ipc";

export type AcpCursorProbeResult =
  | { available: true }
  | { available: false; reasonKey: "missingCli" | "handshakeFailed"; detail?: string };

export interface AcpCursorProbeDeps {
  resolveExecutable: () => string;
  executableExists: (path: string) => boolean;
  /** Spawn + initialize → initialized → dispose. Throws on failure. */
  handshake: () => Promise<void>;
}

export type AcpCursorHandshakeOptions = {
  resolveExecutable?: () => string;
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  env?: NodeJS.ProcessEnv;
};

const DETAIL_MAX_LEN = 500;

function truncateDetail(message: string): string {
  if (message.length <= DETAIL_MAX_LEN) return message;
  return message.slice(0, DETAIL_MAX_LEN);
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) {
    return truncateDetail(error.message);
  }
  return truncateDetail(String(error));
}

function isFilesystemPath(executable: string): boolean {
  return path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\");
}

/**
 * Probe Cursor ACP availability.
 * Success = executable present (when path-like) + handshake completes.
 */
export async function probeAcpCursorAvailability(deps: AcpCursorProbeDeps): Promise<AcpCursorProbeResult> {
  const executablePath = deps.resolveExecutable();
  if (isFilesystemPath(executablePath) && !deps.executableExists(executablePath)) {
    return { available: false, reasonKey: "missingCli" };
  }

  try {
    await deps.handshake();
    return { available: true };
  } catch (error) {
    const detail = errorDetail(error);
    if (/ENOENT|not found|no such file/i.test(detail)) {
      return { available: false, reasonKey: "missingCli", detail };
    }
    return {
      available: false,
      reasonKey: "handshakeFailed",
      detail,
    };
  }
}

/**
 * Real handshake: spawn `agent acp` → initialize → notifications/initialized → dispose.
 * Injectable spawn for unit tests; CI may skip live integration.
 */
export async function handshakeAcpCursor(options: AcpCursorHandshakeOptions = {}): Promise<void> {
  await withInitializedCursorAcp(options, async () => {});
}

/** Use the model IDs advertised by the same protocol as session/set_model. */
export async function listCursorAcpModels(options: AcpCursorHandshakeOptions = {}): Promise<CursorModelOption[]> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mori-cursor-models-"));
  try {
    return await withInitializedCursorAcp(options, async (client, capabilities) => {
      const session = await client.newSession({ cwd });
      try {
        const models = parseAcpAvailableModels(session);
        if (!models.length) throw new Error("Cursor ACP session/new returned no availableModels");
        const currentModelId = (session.models as { currentModelId?: unknown }).currentModelId;
        return models.map(({ modelId, name }) => ({
          id: modelId,
          displayName: name ?? modelId,
          current: modelId === currentModelId,
          default: modelId === "default[]",
        }));
      } finally {
        if (agentSupportsSessionDelete(capabilities)) {
          try {
            await client.deleteSession({ sessionId: session.sessionId });
          } catch (error) {
            if (!isAcpSessionDeleteMethodNotFound(error)) throw error;
            await removeCursorAcpSessionDir(session.sessionId, { ...process.env, ...options.env });
          }
        } else {
          await removeCursorAcpSessionDir(session.sessionId, { ...process.env, ...options.env });
        }
      }
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** With auto assignment, a pinned model must be accepted by every eligible account. */
export function intersectCursorAcpModelLists(catalogs: readonly CursorModelOption[][]): CursorModelOption[] {
  const [first, ...others] = catalogs;
  if (!first) return [];
  const byId = others.map(models => new Map(models.map(model => [model.id, model])));
  return first
    .filter(model => byId.every(models => models.has(model.id)))
    .map(model => ({ ...model, current: model.current && byId.every(models => models.get(model.id)?.current) }));
}

async function withInitializedCursorAcp<T>(
  options: AcpCursorHandshakeOptions,
  operation: (client: AcpClient, init: AcpInitializeResult) => Promise<T>,
): Promise<T> {
  const executable = options.resolveExecutable?.();
  const child = spawnCursorAcpProcess({
    ...(executable !== undefined ? { executable } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
  });
  const spawnFailure = cursorAcpSpawnError(child);

  let peer: AcpJsonRpcPeer | undefined;
  let closeReadline: (() => void) | undefined;
  try {
    if (!child.stdin || !child.stdout) {
      throw new Error("ACP process requires piped stdin/stdout");
    }
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    peer = new AcpJsonRpcPeer({
      write: (line) => {
        child.stdin!.write(line);
      },
      onLine: (cb) => {
        rl.on("line", cb);
      },
    });
    closeReadline = () => rl.close();
    child.once("exit", () => {
      peer?.dispose();
      closeReadline?.();
      closeReadline = undefined;
    });

    const client = new AcpClient({
      peer,
      clientInfo: { name: "eco", version: "0.0.0" },
    });
    // Race against the child's `error` event: when Cursor is not installed the
    // spawn fails async (ENOENT) and initialize would otherwise hang forever.
    const query = (async () => {
      const init = await client.initialize();
      client.confInitialized();
      return operation(client, init);
    })();
    return await Promise.race([query, spawnFailure]);
  } finally {
    peer?.dispose();
    closeReadline?.();
    closeReadline = undefined;
    killChildProcessTree(child);
  }
}

/** 若 enabled 但 probe 失败，返回应写入的 workflow 补丁；否则 undefined */
export function reconcileAcpCursorEnabled(input: {
  acpCursorEnabled: boolean;
  defaultCoreKind?: string;
  probe: AcpCursorProbeResult;
}): { acpCursorEnabled: false; defaultCoreKind?: "claude" } | undefined {
  if (!input.acpCursorEnabled || input.probe.available) {
    return undefined;
  }

  if (input.defaultCoreKind === "acp" || input.defaultCoreKind === "cursor") {
    return { acpCursorEnabled: false, defaultCoreKind: "claude" };
  }

  return { acpCursorEnabled: false };
}

/**
 * 新建/续跑门禁；失败抛 Error。
 * Cursor ACP 可用性以 CLI probe 为准（历史 `acpAgentsEnabled.cursor` 开关已无入口）。
 */
export function assertAcpCursorRunnable(input: {
  probe: AcpCursorProbeResult;
  unavailableMessage: string;
}): void {
  if (!input.probe.available) {
    throw new Error(input.unavailableMessage);
  }
}

function acpCursorDisablePatch(defaultCoreKind?: string): {
  acpCursorEnabled: false;
  defaultCoreKind?: string;
} {
  if (defaultCoreKind === "acp" || defaultCoreKind === "cursor") {
    return { acpCursorEnabled: false, defaultCoreKind: "claude" };
  }
  return {
    acpCursorEnabled: false,
    ...(defaultCoreKind ? { defaultCoreKind } : {}),
  };
}

/**
 * workflow save：
 * - false→true：probe 须成功，否则 throw（不落库 true）
 * - 已为 true 且 probe 失败：对账关闭（acp→claude），不 throw，以便继续保存其它字段
 * - true→false：关闭；若 default 为 acp 则回退 claude
 */
export function applyAcpCursorEnableSave(input: {
  nextEnabled: boolean;
  current: { acpAgentsEnabled?: { cursor?: boolean }; defaultCoreKind?: string };
  probe: AcpCursorProbeResult;
  probeFailedMessage: string;
}): {
  acpCursorEnabled: boolean;
  defaultCoreKind?: string;
} {
  const previouslyEnabled = input.current.acpAgentsEnabled?.cursor === true;
  const risingEdge = input.nextEnabled && !previouslyEnabled;

  if (risingEdge && !input.probe.available) {
    throw new Error(input.probeFailedMessage);
  }

  if (input.nextEnabled) {
    if (!input.probe.available) {
      return acpCursorDisablePatch(input.current.defaultCoreKind);
    }
    return {
      acpCursorEnabled: true,
      ...(input.current.defaultCoreKind ? { defaultCoreKind: input.current.defaultCoreKind } : {}),
    };
  }

  return acpCursorDisablePatch(input.current.defaultCoreKind);
}
