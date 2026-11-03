import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeClaudeProjectDirName } from "../src/main/claude-session-paths";
import { createConversationStore } from "../src/main/conversation-store";
import { clearCodexHomeCaches, clearLogs, runStorageCleanup } from "../src/main/storage-cleanup";
import { createStorageCleanupService } from "../src/main/storage-cleanup-service";
import type { ThreadSummary } from "../src/shared/ipc";
import type { StorageCleanupProgress } from "../src/shared/storage-usage";
import { removeTempDirectory } from "./helpers/temp-directory";

/** 跨平台的工作区 fixture：POSIX 上是 `/Users/me/repo`，Windows 上是 `<当前盘>:/Users/me/repo`。 */
const WORKSPACE_ROOT = path.resolve(path.parse(process.cwd()).root, "Users", "me", "repo");

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-storage-cleanup-"));
});

afterEach(async () => {
  await removeTempDirectory(tempDir);
});

test("clearLogs deletes only upstream-*.log and not other files", async () => {
  const logsDir = path.join(tempDir, "logs");
  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(path.join(logsDir, "upstream-2026-01-01.log"), "log-one");
  await fs.writeFile(path.join(logsDir, "upstream-2026-01-02.log"), "log-two");
  await fs.writeFile(path.join(logsDir, "readme.txt"), "keep-me");

  const result = await clearLogs(logsDir);
  expect(result.ok).toBe(true);
  expect(result.deletedCount).toBe(2);
  expect(result.freedBytes).toBe("log-one".length + "log-two".length);
  expect(await fs.readdir(logsDir)).toEqual(["readme.txt"]);
});

test("clearLogs respects olderThanDays using mtime", async () => {
  const logsDir = path.join(tempDir, "logs-age");
  await fs.mkdir(logsDir, { recursive: true });
  const oldPath = path.join(logsDir, "upstream-2020-01-01.log");
  const newPath = path.join(logsDir, "upstream-2026-08-01.log");
  await fs.writeFile(oldPath, "old");
  await fs.writeFile(newPath, "new");
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await fs.utimes(oldPath, tenDaysAgo, tenDaysAgo);

  const result = await clearLogs(logsDir, 3);
  expect(result.deletedCount).toBe(1);
  expect(await fs.readdir(logsDir)).toEqual(["upstream-2026-08-01.log"]);
});

test("clearCodexHomeCaches only removes whitelisted dirs", async () => {
  const codexHome = path.join(tempDir, "codex");
  await fs.mkdir(path.join(codexHome, "eco-pending-spawns"), { recursive: true });
  await fs.mkdir(path.join(codexHome, "agents"), { recursive: true });
  await fs.writeFile(path.join(codexHome, "config.toml"), "keep");
  await fs.writeFile(path.join(codexHome, "eco-pending-spawns", "x.json"), "{}");
  await fs.writeFile(path.join(codexHome, "agents", "a.md"), "agent");

  const result = await clearCodexHomeCaches(codexHome);
  expect(result.ok).toBe(true);
  expect(result.deletedCount).toBe(1);
  expect(await fs.readdir(codexHome)).toEqual(expect.arrayContaining(["agents", "config.toml"]));
  await expect(fs.access(path.join(codexHome, "eco-pending-spawns"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("clearClaudeSessions orphansOnly removes Eco worktree projects only", async () => {
  const projectsDir = path.join(tempDir, "claude-projects");
  const historyDir = path.join(tempDir, "claude-history");
  // Claude 的 project 目录名由工作区绝对路径编码而来，所以 fixture 用同一个编码函数生成：
  // POSIX 与 Windows 上都指向同一个"还活着的 worktree"。
  const liveWorktree = path.join(WORKSPACE_ROOT, ".eco", "worktrees", "thr-live");
  const ecoOrphan = encodeClaudeProjectDirName(path.join(WORKSPACE_ROOT, ".eco", "worktrees", "thr-gone"));
  const ecoActive = encodeClaudeProjectDirName(liveWorktree);
  const cliProject = encodeClaudeProjectDirName(path.join(WORKSPACE_ROOT, "other"));
  for (const name of [ecoOrphan, ecoActive, cliProject]) {
    await fs.mkdir(path.join(projectsDir, name), { recursive: true });
    await fs.writeFile(path.join(projectsDir, name, "sess.jsonl"), "data");
  }
  await fs.mkdir(historyDir, { recursive: true });
  await fs.writeFile(path.join(historyDir, "keep"), "history");

  const store = {
    listThreads: () => [
      {
        id: "t1",
        workspacePath: liveWorktree,
        status: "idle" as const,
      },
    ],
    getSdkSession: () => ({
      sessionId: "live-session",
      cwd: liveWorktree,
    }),
  };

  const result = await runStorageCleanup(
    {
      userDataDir: tempDir,
      databasePath: path.join(tempDir, "x.sqlite"),
      conversationStore: store as never,
      deleteThreadWithExternalState: async () => {},
      hasActiveThreadRuns: () => false,
      claudeProjectsDir: projectsDir,
      claudeFileHistoryDir: historyDir,
    },
    { action: "clearClaudeSessions", options: { orphansOnly: true } },
  );

  expect(result.ok).toBe(true);
  expect(result.deletedCount).toBe(1);
  const remaining = (await fs.readdir(projectsDir)).sort();
  expect(remaining).toEqual([cliProject, ecoActive].sort());
  // File history untouched on orphan pass
  expect(await fs.readFile(path.join(historyDir, "keep"), "utf8")).toBe("history");
});

test.skipIf(!sqliteAvailable)("clearAllConversations skips running threads", async () => {
  const userDataDir = path.join(tempDir, "userdata-clear");
  const store = await createConversationStore(path.join(userDataDir, "eco-coding.sqlite"));

  const idle: ThreadSummary = {
    id: "idle-thread-id-0001",
    title: "Idle",
    prompt: "p",
    workspacePath: "/tmp",
    status: "idle",
    message: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const running: ThreadSummary = {
    id: "running-thread-id-01",
    title: "Run",
    prompt: "p",
    workspacePath: "/tmp",
    status: "running",
    message: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.saveThread(idle);
  store.saveThread(running);

  const deleted: string[] = [];
  const result = await runStorageCleanup(
    {
      userDataDir,
      databasePath: path.join(userDataDir, "eco-coding.sqlite"),
      conversationStore: store,
      deleteThreadWithExternalState: async (threadId) => {
        deleted.push(threadId);
        store.deleteThread(threadId);
      },
      hasActiveThreadRuns: () => true,
    },
    { action: "clearAllConversations" },
  );

  expect(deleted).toEqual(["idle-thread-id-0001"]);
  expect(result.skippedThreadIds).toEqual(["running-thread-id-01"]);
  expect(result.ok).toBe(false);
  expect(store.listThreads().map((thread) => thread.id)).toEqual(["running-thread-id-01"]);
});

test("clearOldConversations deletes by updatedAt and skips busy", async () => {
  const userDataDir = path.join(tempDir, "userdata-old");
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const threads = [
    {
      id: "old-idle-thread-00001",
      status: "idle" as const,
      updatedAt: tenDaysAgo,
    },
    {
      id: "recent-idle-thread-01",
      status: "idle" as const,
      updatedAt: oneDayAgo,
    },
    {
      id: "old-running-thread-01",
      status: "running" as const,
      updatedAt: tenDaysAgo,
    },
  ];

  const deleted: string[] = [];
  const result = await runStorageCleanup(
    {
      userDataDir,
      databasePath: path.join(userDataDir, "eco-coding.sqlite"),
      conversationStore: {
        listThreads: () => threads,
        listCleanupThreads: () => threads.map((thread) => ({ ...thread })),
        getThread: (id: string) => threads.find((thread) => thread.id === id),
      } as never,
      deleteThreadWithExternalState: async (threadId) => {
        deleted.push(threadId);
        const index = threads.findIndex((thread) => thread.id === threadId);
        if (index >= 0) {
          threads.splice(index, 1);
        }
      },
      hasActiveThreadRuns: () => true,
    },
    {
      action: "clearOldConversations",
      options: { olderThanValue: 7, olderThanUnit: "days" },
    },
  );

  expect(deleted).toEqual(["old-idle-thread-00001"]);
  expect(result.deletedCount).toBe(1);
  expect(result.skippedThreadIds).toEqual(["old-running-thread-01"]);
  expect(result.ok).toBe(false);
  expect(threads.map((thread) => thread.id).sort()).toEqual([
    "old-running-thread-01",
    "recent-idle-thread-01",
  ]);
});

test("clearOldConversations rejects missing retention options", async () => {
  const result = await runStorageCleanup(
    {
      userDataDir: tempDir,
      databasePath: path.join(tempDir, "x.sqlite"),
      conversationStore: { listThreads: () => [] } as never,
      deleteThreadWithExternalState: async () => {},
      hasActiveThreadRuns: () => false,
    },
    { action: "clearOldConversations" },
  );
  expect(result.ok).toBe(false);
  expect(result.errors?.[0]).toMatch(/olderThanValue/i);
});

test.skipIf(!sqliteAvailable)("vacuumDatabase refuses while threads are active", async () => {
  const userDataDir = path.join(tempDir, "userdata-vac");
  const store = await createConversationStore(path.join(userDataDir, "eco-coding.sqlite"));
  const result = await runStorageCleanup(
    {
      userDataDir,
      databasePath: path.join(userDataDir, "eco-coding.sqlite"),
      conversationStore: store,
      deleteThreadWithExternalState: async () => {},
      hasActiveThreadRuns: () => true,
    },
    { action: "vacuumDatabase" },
  );
  expect(result.ok).toBe(false);
  expect(result.errors?.[0]).toMatch(/running or queued/i);
});

test("clearPiAgent orphansOnly removes thread dirs absent from conversation list", async () => {
  const userDataDir = path.join(tempDir, "userdata-pi");
  const piAgentDir = path.join(userDataDir, "pi-agent");
  await fs.mkdir(path.join(piAgentDir, "thr_keep", "sessions"), { recursive: true });
  await fs.mkdir(path.join(piAgentDir, "thr_orphan", "sessions"), { recursive: true });
  await fs.writeFile(path.join(piAgentDir, "thr_keep", "sessions", "a.jsonl"), "keep");
  await fs.writeFile(path.join(piAgentDir, "thr_orphan", "sessions", "b.jsonl"), "gone");

  const result = await runStorageCleanup(
    {
      userDataDir,
      databasePath: path.join(userDataDir, "eco-coding.sqlite"),
      conversationStore: {
        listThreads: () => [{ id: "thr_keep", status: "idle" as const, coreKind: "pi" as const }],
      } as never,
      deleteThreadWithExternalState: async () => {},
      hasActiveThreadRuns: () => false,
      piAgentDir,
    },
    { action: "clearPiAgent", options: { orphansOnly: true } },
  );

  expect(result.ok).toBe(true);
  expect(result.deletedCount).toBe(1);
  expect(await fs.readdir(piAgentDir)).toEqual(["thr_keep"]);
});

test("clearPiAgent full wipe deletes Eco PI threads and leftover agent dirs", async () => {
  const userDataDir = path.join(tempDir, "userdata-pi-full");
  const piAgentDir = path.join(userDataDir, "pi-agent");
  await fs.mkdir(path.join(piAgentDir, "thr_pi_idle", "sessions"), { recursive: true });
  await fs.mkdir(path.join(piAgentDir, "thr_pi_run", "sessions"), { recursive: true });
  await fs.mkdir(path.join(piAgentDir, "thr_orphan", "sessions"), { recursive: true });
  await fs.writeFile(path.join(piAgentDir, "thr_pi_idle", "sessions", "a.jsonl"), "idle");
  await fs.writeFile(path.join(piAgentDir, "thr_pi_run", "sessions", "b.jsonl"), "run");
  await fs.writeFile(path.join(piAgentDir, "thr_orphan", "sessions", "c.jsonl"), "orphan");

  const deleted: string[] = [];
  const threads = [
    { id: "thr_pi_idle", status: "idle" as const, coreKind: "pi" as const },
    { id: "thr_pi_run", status: "running" as const, coreKind: "pi" as const },
    { id: "thr_claude", status: "idle" as const, coreKind: "claude" as const },
  ];

  const result = await runStorageCleanup(
    {
      userDataDir,
      databasePath: path.join(userDataDir, "x.sqlite"),
      conversationStore: {
        listThreads: () => threads,
        listCleanupThreads: () => threads.map((thread) => ({ ...thread })),
        getThread: (id: string) => threads.find((thread) => thread.id === id),
      } as never,
      deleteThreadWithExternalState: async (threadId) => {
        deleted.push(threadId);
        const index = threads.findIndex((thread) => thread.id === threadId);
        if (index >= 0) {
          threads.splice(index, 1);
        }
        await fs.rm(path.join(piAgentDir, threadId), { recursive: true, force: true });
      },
      hasActiveThreadRuns: () => true,
      piAgentDir,
    },
    { action: "clearPiAgent" },
  );

  expect(deleted).toEqual(["thr_pi_idle"]);
  expect(result.skippedThreadIds).toEqual(["thr_pi_run"]);
  expect(result.ok).toBe(false);
  expect(await fs.readdir(piAgentDir)).toEqual(["thr_pi_run"]);
  expect(threads.map((thread) => thread.id).sort()).toEqual(["thr_claude", "thr_pi_run"]);
});

test("clearPiAgent full wipe with no running PI threads removes all agent dirs", async () => {
  const userDataDir = path.join(tempDir, "userdata-pi-full-ok");
  const piAgentDir = path.join(userDataDir, "pi-agent");
  await fs.mkdir(path.join(piAgentDir, "thr_pi", "sessions"), { recursive: true });
  await fs.writeFile(path.join(piAgentDir, "thr_pi", "sessions", "a.jsonl"), "x");

  const deleted: string[] = [];
  const result = await runStorageCleanup(
    {
      userDataDir,
      databasePath: path.join(userDataDir, "x.sqlite"),
      conversationStore: {
        listThreads: () => [],
        listCleanupThreads: () =>
          deleted.length ? [] : [{ id: "thr_pi", status: "idle" as const, coreKind: "pi" as const }],
        getThread: () => ({ id: "thr_pi", status: "idle", coreKind: "pi" }),
      } as never,
      deleteThreadWithExternalState: async (threadId) => {
        deleted.push(threadId);
        await fs.rm(path.join(piAgentDir, threadId), { recursive: true, force: true });
      },
      hasActiveThreadRuns: () => false,
      piAgentDir,
    },
    { action: "clearPiAgent" },
  );

  expect(result.ok).toBe(true);
  expect(deleted).toEqual(["thr_pi"]);
  expect(
    await fs.readdir(piAgentDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }),
  ).toEqual([]);
});

function batchFixture(threads: Array<{ id: string; status: string; updatedAt: string; coreKind?: string }>) {
  return {
    userDataDir: tempDir,
    databasePath: path.join(tempDir, "batch.sqlite"),
    conversationStore: {
      listCleanupThreads: () => threads.map((thread) => ({ ...thread })),
      getThread: (id: string) => threads.find((thread) => thread.id === id),
    } as never,
    hasActiveThreadRuns: () => false,
    deleteThreadWithExternalState: async (id: string) => {
      const index = threads.findIndex((thread) => thread.id === id);
      if (index >= 0) threads.splice(index, 1);
    },
  };
}

test("conversation cleanup gives timers a turn between deletions and reports incremental progress", async () => {
  const threads = Array.from({ length: 5 }, (_, i) => ({
    id: `batch-${i}`,
    status: "idle",
    updatedAt: "2020-01-01",
  }));
  const deps = batchFixture(threads);
  const progress: StorageCleanupProgress["processedCount"][] = [];
  let heartbeat = 0;
  const beatsAtDeletion: number[] = [];
  const timer = setInterval(() => heartbeat++, 1);
  const deleteThread = deps.deleteThreadWithExternalState;
  try {
    await runStorageCleanup(
      {
        ...deps,
        onProgress: (next) => progress.push(next.processedCount),
        deleteThreadWithExternalState: async (id) => {
          beatsAtDeletion.push(heartbeat);
          await deleteThread(id);
        },
      },
      { action: "clearAllConversations" },
    );
  } finally {
    clearInterval(timer);
  }
  expect(progress).toEqual([0, 1, 2, 3, 4, 5]);
  expect(beatsAtDeletion).toHaveLength(5);
  let previousBeat = 0;
  for (const beat of beatsAtDeletion) {
    expect(beat).toBeGreaterThan(previousBeat);
    previousBeat = beat;
  }
});

test("cleanup rechecks candidates, skips changed/busy conversations and excludes new arrivals", async () => {
  const threads = ["first", "became-running", "became-queued", "updated", "removed"].map((id) => ({
    id,
    status: "idle",
    updatedAt: "2020-01-01",
  }));
  const deps = batchFixture(threads);
  const deleteThread = deps.deleteThreadWithExternalState;
  const result = await runStorageCleanup(
    {
      ...deps,
      deleteThreadWithExternalState: async (id) => {
        await deleteThread(id);
        for (const thread of threads) {
          if (thread.id === "became-running") thread.status = "running";
          if (thread.id === "became-queued") thread.status = "queued";
          if (thread.id === "updated") thread.updatedAt = new Date().toISOString();
        }
        threads.pop();
        threads.push({ id: "new", status: "idle", updatedAt: "2020-01-01" });
      },
    },
    { action: "clearAllConversations" },
  );
  expect(result.deletedCount).toBe(1);
  expect(result.skippedThreadIds).toEqual(["became-running", "became-queued", "updated", "removed"]);
  expect(threads.map((thread) => thread.id)).toContain("new");
});

test("cleanup service rejects concurrent work, retains progress and reports partial failures", async () => {
  const threads = ["fail", "ok"].map((id) => ({ id, status: "idle", updatedAt: "2020-01-01" }));
  const deps = batchFixture(threads);
  const updates: StorageCleanupProgress[] = [];
  const service = createStorageCleanupService((next) => updates.push(next));
  const deleteThread = deps.deleteThreadWithExternalState;
  const task = service.run(
    {
      ...deps,
      deleteThreadWithExternalState: async (id) => {
        if (id === "fail") throw new Error("cannot delete");
        expect(service.getProgress()?.processedCount).toBe(1);
        await deleteThread(id);
      },
    },
    { action: "clearAllConversations" },
  );
  expect(service.getProgress()?.status).toBe("running");
  await expect(service.run(deps, { action: "clearAllConversations" })).rejects.toThrow(/already running/);
  const result = await task;
  expect(result.ok).toBe(false);
  expect(result.deletedCount).toBe(1);
  expect(result.errors).toEqual(["fail: cannot delete"]);
  expect(service.getProgress()).toMatchObject({
    status: "completed",
    processedCount: 2,
    deletedCount: 1,
    failedCount: 1,
    result,
  });
  expect(updates.map((next) => next.status)).toEqual([
    "running",
    "running",
    "running",
    "running",
    "completed",
  ]);
  // A new operation is allowed once the previous one has completed.
  expect((await service.run(deps, { action: "clearAllConversations" })).ok).toBe(true);
});

test("PI cleanup preserves files of failed deletions and newly created conversations", async () => {
  const piAgentDir = path.join(tempDir, "pi-agent-preserved");
  for (const id of ["failed", "ok", "orphan"]) {
    await fs.mkdir(path.join(piAgentDir, id), { recursive: true });
    await fs.writeFile(path.join(piAgentDir, id, "session.jsonl"), "history");
  }
  const threads = ["failed", "ok"].map((id) => ({
    id,
    status: "idle",
    updatedAt: "2020-01-01",
    coreKind: "pi",
  }));
  const deps = batchFixture(threads);
  const deleteThread = deps.deleteThreadWithExternalState;
  const result = await runStorageCleanup(
    {
      ...deps,
      piAgentDir,
      deleteThreadWithExternalState: async (id) => {
        if (id === "failed") throw new Error("keep me");
        await deleteThread(id);
        threads.push({ id: "new", status: "idle", updatedAt: "2020-01-01", coreKind: "pi" });
        await fs.mkdir(path.join(piAgentDir, "new"));
      },
    },
    { action: "clearPiAgent" },
  );
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual(["failed: keep me"]);
  expect((await fs.readdir(piAgentDir)).sort()).toEqual(["failed", "new"]);
  expect(await fs.readFile(path.join(piAgentDir, "failed", "session.jsonl"), "utf8")).toBe("history");
});
