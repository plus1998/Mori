import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { resolveCodexHomeDir } from "@eco/runtime/codex-config-sync";
import type {
  StorageCleanupAction,
  StorageCleanupOlderThanUnit,
  StorageCleanupProgress,
  StorageCleanupRequest,
  StorageCleanupResult,
} from "../shared/storage-usage";
import {
  encodeClaudeProjectDirName,
  isEcoClaudeProjectDirName,
  resolveClaudeFileHistoryDir,
  resolveClaudeProjectsDir,
} from "./claude-session-paths";
import type { ConversationStore } from "./conversation-store";
import { measurePathBytes } from "./storage-inventory";
import { getUpstreamLogBaseDir } from "./upstream-log";

const UPSTREAM_LOG_NAME = /^upstream-\d{4}-\d{2}-\d{2}\.log$/;
/** Safe-to-regenerate directories under CODEX_HOME only. */
const CODEX_HOME_CACHE_DIRS = ["eco-pending-spawns", "eco-forced-plan-delegations"] as const;

export interface StorageCleanupDeps {
  userDataDir: string;
  databasePath: string;
  conversationStore: ConversationStore;
  deleteThreadWithExternalState: (threadId: string) => Promise<void>;
  onProgress?: (progress: Omit<StorageCleanupProgress, "request" | "status" | "result">) => void;
  logsDir?: string;
  codexHomeDir?: string;
  claudeProjectsDir?: string;
  claudeFileHistoryDir?: string;
  piAgentDir?: string;
}

export async function runStorageCleanup(
  deps: StorageCleanupDeps,
  request: StorageCleanupRequest,
): Promise<StorageCleanupResult> {
  switch (request.action) {
    case "clearLogs":
      return clearLogs(deps.logsDir ?? getUpstreamLogBaseDir(), request.options?.olderThanDays);
    case "clearCodexHomeCaches":
      return clearCodexHomeCaches(deps.codexHomeDir ?? resolveCodexHomeDir(deps.userDataDir));
    case "clearClaudeSessions":
      return clearClaudeSessions(deps, request.options?.orphansOnly === true);
    case "clearPiAgent":
      return clearPiAgent(deps, request.options?.orphansOnly === true);
    case "clearOldConversations":
      return clearOldConversations(deps, request.options?.olderThanValue, request.options?.olderThanUnit);
    case "clearAllConversations":
      return clearAllConversations(deps);
    case "vacuumDatabase":
      return vacuumDatabase(deps);
    default: {
      const _exhaustive: never = request.action;
      throw new Error(`Unknown storage cleanup action: ${String(_exhaustive)}`);
    }
  }
}

export async function clearLogs(logsDir: string, olderThanDays?: number): Promise<StorageCleanupResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(logsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, freedBytes: 0, deletedCount: 0 };
    }
    throw error;
  }

  const cutoffMs =
    typeof olderThanDays === "number" && Number.isFinite(olderThanDays) && olderThanDays > 0
      ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000
      : undefined;

  let freedBytes = 0;
  let deletedCount = 0;
  const errors: string[] = [];

  for (const name of entries) {
    if (!UPSTREAM_LOG_NAME.test(name)) {
      continue;
    }
    const filePath = path.join(logsDir, name);
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      if (cutoffMs !== undefined && stat.mtimeMs >= cutoffMs) {
        continue;
      }
      const size = stat.size;
      await fs.unlink(filePath);
      freedBytes += size;
      deletedCount += 1;
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    freedBytes,
    deletedCount,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export async function clearCodexHomeCaches(codexHomeDir: string): Promise<StorageCleanupResult> {
  let freedBytes = 0;
  let deletedCount = 0;
  const errors: string[] = [];

  for (const name of CODEX_HOME_CACHE_DIRS) {
    const target = path.join(codexHomeDir, name);
    try {
      const measured = await measurePathBytes(target);
      if (!measured.exists) {
        continue;
      }
      await fs.rm(target, { recursive: true, force: true });
      freedBytes += measured.bytes;
      deletedCount += 1;
    } catch (error) {
      errors.push(`${name}: ${errorMessage(error)}`);
    }
  }

  return {
    ok: errors.length === 0,
    freedBytes,
    deletedCount,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Claude JSONL under projects/ and file-history/.
 * orphansOnly: only Eco worktree project dirs that no active thread still references (by session id or cwd).
 * Full clear also empties leftover Claude CLI file-history — same confirm path as full wipe.
 */
export async function clearClaudeSessions(
  deps: StorageCleanupDeps,
  orphansOnly: boolean,
): Promise<StorageCleanupResult> {
  const projectsDir = deps.claudeProjectsDir ?? resolveClaudeProjectsDir();
  const fileHistoryDir = deps.claudeFileHistoryDir ?? resolveClaudeFileHistoryDir();

  const beforeProjects = (await measurePathBytes(projectsDir)).bytes;
  const beforeHistory = (await measurePathBytes(fileHistoryDir)).bytes;
  const before = beforeProjects + beforeHistory;

  if (orphansOnly) {
    const keepDirNames = new Set<string>();
    const keepSessionIds = new Set<string>();
    for (const thread of deps.conversationStore.listThreads()) {
      const session = deps.conversationStore.getSdkSession(thread.id);
      if (session?.sessionId) {
        keepSessionIds.add(session.sessionId);
      }
      if (session?.cwd) {
        keepDirNames.add(encodeClaudeProjectDirName(session.cwd));
      }
      if (thread.workspacePath) {
        keepDirNames.add(encodeClaudeProjectDirName(thread.workspacePath));
      }
    }

    let deletedCount = 0;
    const errors: string[] = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(projectsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    for (const name of names) {
      if (!isEcoClaudeProjectDirName(name)) {
        continue;
      }
      if (keepDirNames.has(name)) {
        continue;
      }
      // Also keep if any kept session JSONL lives in this folder.
      const dirPath = path.join(projectsDir, name);
      try {
        const children = await fs.readdir(dirPath);
        const hasActiveSession = children.some((child) => {
          const base = child.replace(/\.jsonl$/i, "");
          return keepSessionIds.has(base) || keepSessionIds.has(child);
        });
        if (hasActiveSession) {
          continue;
        }
        const measured = await measurePathBytes(dirPath);
        await fs.rm(dirPath, { recursive: true, force: true });
        deletedCount += 1;
        void measured;
      } catch (error) {
        errors.push(`${name}: ${errorMessage(error)}`);
      }
    }

    const after =
      (await measurePathBytes(projectsDir)).bytes + (await measurePathBytes(fileHistoryDir)).bytes;
    return {
      ok: errors.length === 0,
      freedBytes: Math.max(0, before - after),
      deletedCount,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  // Full clear: projects + leftover Claude CLI file-history
  const errors: string[] = [];
  let deletedCount = 0;
  for (const target of [projectsDir, fileHistoryDir]) {
    try {
      const measured = await measurePathBytes(target);
      if (!measured.exists) {
        continue;
      }
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(target, { recursive: true });
      deletedCount += 1;
    } catch (error) {
      errors.push(`${target}: ${errorMessage(error)}`);
    }
  }

  const after = (await measurePathBytes(projectsDir)).bytes + (await measurePathBytes(fileHistoryDir)).bytes;
  return {
    ok: errors.length === 0,
    freedBytes: Math.max(0, before - after),
    deletedCount,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * Eco-owned `userData/pi-agent/<threadId>/` (sessions JSONL, skills mounts, auth).
 * orphansOnly: remove thread dirs whose id is not in the conversation DB.
 * Full clear: delete every Eco thread with coreKind=pi (so the chat cannot be reopened),
 * then wipe leftover `pi-agent/` dirs. Running/queued PI threads are skipped.
 */
export async function clearPiAgent(
  deps: StorageCleanupDeps,
  orphansOnly: boolean,
): Promise<StorageCleanupResult> {
  const piAgentDir = deps.piAgentDir ?? path.join(deps.userDataDir, "pi-agent");
  const before = (await measurePathBytes(piAgentDir)).bytes;

  if (orphansOnly) {
    const keepIds = new Set(deps.conversationStore.listThreads().map((thread) => thread.id));
    let deletedCount = 0;
    const errors: string[] = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(piAgentDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    for (const name of names) {
      if (keepIds.has(name)) {
        continue;
      }
      const dirPath = path.join(piAgentDir, name);
      try {
        const stat = await fs.lstat(dirPath);
        if (!stat.isDirectory()) {
          continue;
        }
        await fs.rm(dirPath, { recursive: true, force: true });
        deletedCount += 1;
      } catch (error) {
        errors.push(`${name}: ${errorMessage(error)}`);
      }
    }

    const after = (await measurePathBytes(piAgentDir)).bytes;
    return {
      ok: errors.length === 0,
      freedBytes: Math.max(0, before - after),
      deletedCount,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  const threadResult = await clearConversationBatch(deps, (thread) => thread.coreKind === "pi");
  const skippedThreadIds = threadResult.skippedThreadIds ?? [];
  const errors = threadResult.errors ?? [];
  const deletedThreadCount = threadResult.deletedCount ?? 0;
  // Keep failed deletions and conversations created while the cleanup was running.
  const keepIds = new Set(deps.conversationStore.listCleanupThreads().map((thread) => thread.id));
  deps.onProgress?.({
    phase: "files",
    processedCount: 0,
    totalCount: 0,
    deletedCount: deletedThreadCount,
    skippedCount: skippedThreadIds.length,
    failedCount: errors.length,
  });
  let deletedDirCount = 0;
  let names: string[] = [];
  try {
    names = await fs.readdir(piAgentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(errorMessage(error));
    }
  }

  for (const name of names) {
    if (keepIds.has(name) || deps.conversationStore.getThread(name)) {
      continue;
    }
    const dirPath = path.join(piAgentDir, name);
    try {
      const stat = await fs.lstat(dirPath);
      if (!stat.isDirectory() && !stat.isFile()) {
        continue;
      }
      await fs.rm(dirPath, { recursive: true, force: true });
      deletedDirCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        errors.push(`${name}: ${errorMessage(error)}`);
      }
    }
  }

  const after = (await measurePathBytes(piAgentDir)).bytes;
  return {
    ok: errors.length === 0 && skippedThreadIds.length === 0,
    freedBytes: Math.max(0, before - after),
    deletedCount: deletedThreadCount + deletedDirCount,
    ...(skippedThreadIds.length > 0 ? { skippedThreadIds } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...(skippedThreadIds.length > 0
      ? {
          message: "Some PI conversations were skipped because their state changed or they are still active.",
        }
      : {}),
  };
}

async function clearOldConversations(
  deps: StorageCleanupDeps,
  olderThanValue: number | undefined,
  olderThanUnit: StorageCleanupOlderThanUnit | undefined,
): Promise<StorageCleanupResult> {
  const cutoffMs = resolveOlderThanCutoffMs(olderThanValue, olderThanUnit);
  if (cutoffMs === undefined) {
    return {
      ok: false,
      errors: ["clearOldConversations requires a positive olderThanValue and olderThanUnit (hours|days)."],
    };
  }

  return clearConversationBatch(deps, (thread) => {
    const updatedAt = Date.parse(thread.updatedAt);
    return Number.isFinite(updatedAt) && updatedAt < cutoffMs;
  });
}

async function clearAllConversations(deps: StorageCleanupDeps): Promise<StorageCleanupResult> {
  return clearConversationBatch(deps);
}

type CleanupThread = Pick<import("../shared/ipc").ThreadSummary, "id" | "status" | "updatedAt" | "coreKind">;

async function clearConversationBatch(
  deps: StorageCleanupDeps,
  eligible: (thread: CleanupThread) => boolean = () => true,
): Promise<StorageCleanupResult> {
  // Snapshot only the candidate IDs/metadata, never entire conversation projections.
  const threads = deps.conversationStore.listCleanupThreads().filter(eligible);
  const skippedThreadIds: string[] = [];
  const errors: string[] = [];
  let deletedCount = 0;
  let processedCount = 0;
  const report = () =>
    deps.onProgress?.({
      phase: "conversations",
      totalCount: threads.length,
      processedCount,
      deletedCount,
      skippedCount: skippedThreadIds.length,
      failedCount: errors.length,
    });
  report();
  for (const candidate of threads) {
    // A resolved Promise only yields to microtasks. A timer gives IPC, input and
    // other active conversations a turn, even when deletion completes synchronously.
    await pause(25);
    try {
      const thread = deps.conversationStore.getThread(candidate.id);
      if (
        !thread ||
        thread.updatedAt !== candidate.updatedAt ||
        !eligible(thread) ||
        thread.status === "running" ||
        thread.status === "queued"
      ) {
        skippedThreadIds.push(candidate.id);
      } else {
        await deps.deleteThreadWithExternalState(thread.id);
        deletedCount += 1;
      }
    } catch (error) {
      errors.push(`${candidate.id}: ${errorMessage(error)}`);
    }
    processedCount += 1;
    report();
  }
  return {
    ok: errors.length === 0 && skippedThreadIds.length === 0,
    deletedCount,
    ...(skippedThreadIds.length > 0 ? { skippedThreadIds } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function resolveOlderThanCutoffMs(
  olderThanValue: number | undefined,
  olderThanUnit: StorageCleanupOlderThanUnit | undefined,
): number | undefined {
  if (
    typeof olderThanValue !== "number" ||
    !Number.isFinite(olderThanValue) ||
    olderThanValue <= 0 ||
    (olderThanUnit !== "hours" && olderThanUnit !== "days")
  ) {
    return undefined;
  }
  const msPerUnit = olderThanUnit === "hours" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return Date.now() - olderThanValue * msPerUnit;
}

async function vacuumDatabase(deps: StorageCleanupDeps): Promise<StorageCleanupResult> {
  const before = (await measurePathBytes(deps.databasePath)).bytes;
  let beforeTotal = before;
  for (const suffix of ["-wal", "-shm"] as const) {
    beforeTotal += (await measurePathBytes(`${deps.databasePath}${suffix}`)).bytes;
  }
  deps.conversationStore.vacuum();
  let afterTotal = 0;
  for (const suffix of ["", "-wal", "-shm"] as const) {
    afterTotal += (await measurePathBytes(`${deps.databasePath}${suffix}`)).bytes;
  }
  return {
    ok: true,
    freedBytes: Math.max(0, beforeTotal - afterTotal),
  };
}

export function isStorageCleanupAction(value: unknown): value is StorageCleanupAction {
  return (
    value === "clearLogs" ||
    value === "clearCodexHomeCaches" ||
    value === "clearClaudeSessions" ||
    value === "clearPiAgent" ||
    value === "clearOldConversations" ||
    value === "clearAllConversations" ||
    value === "vacuumDatabase"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
