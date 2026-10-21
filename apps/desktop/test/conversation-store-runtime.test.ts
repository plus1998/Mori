import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { prepareConversationCommandDispatch } from "../src/main/conversation-command-dispatch";
import { createConversationStore, parseCompactHandoffRecentMessages } from "../src/main/conversation-store";
import { conversationV2ProviderMessageId } from "../src/main/conversation-v2-provider-events";
import { buildResourcesFromRouteProfile } from "../src/shared/agent-orchestration";
import type { ModelSettingsSnapshot, ThreadSummary } from "../src/shared/ipc";
import { buildThreadRuntimeConfigFromDefaults } from "../src/shared/thread-runtime-config";

test("parseCompactHandoffRecentMessages accepts structured and legacy records", () => {
  expect(
    parseCompactHandoffRecentMessages(
      JSON.stringify(["legacy user", { id: "msg_2", role: "assistant", message: "structured assistant" }]),
      "thr_parse",
    ),
  ).toEqual([
    { role: "user", message: "legacy user" },
    { id: "msg_2", role: "assistant", message: "structured assistant" },
  ]);
});

test("parseCompactHandoffRecentMessages rejects corrupted records", () => {
  expect(() => parseCompactHandoffRecentMessages("not-json", "thr_bad_json")).toThrow("JSON 损坏");
  expect(() =>
    parseCompactHandoffRecentMessages(JSON.stringify([{ role: "assistant" }]), "thr_bad_entry"),
  ).toThrow("条目结构无效");
});

const sqliteAvailable = await (async () => {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

test.skipIf(!sqliteAvailable)(
  "a clear's initialization intent survives reopening and is consumed only by a persisted turn",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-clear-session-"));
    const dbPath = path.join(dir, "test.sqlite");
    const store = await createConversationStore(dbPath);
    store.saveThread({
      id: "thr_clear",
      title: "clear",
      prompt: "old context",
      workspacePath: dir,
      coreKind: "claude",
      status: "completed",
      message: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.captureSdkSessionAndConsumeCompactHandoff("thr_clear", "reset-id", dir, { resetPending: true });
    const reopened = await createConversationStore(dbPath);
    expect(reopened.getSdkSession("thr_clear")).toEqual({
      sessionId: "reset-id",
      cwd: dir,
      resetPending: true,
    });
    reopened.captureSdkSessionAndConsumeCompactHandoff("thr_clear", "reset-id", dir);
    expect(store.getSdkSession("thr_clear")).toEqual({ sessionId: "reset-id", cwd: dir });
  },
);

// These tests exercise the one-time legacy compatibility surface explicitly.
// Production callers must use the factory default, which is V2-only.
async function createLegacyConversationStore(dbPath: string) {
  return createConversationStore(dbPath, {
    freshStorageMode: "legacy_compat",
    requiredStorageMode: "legacy_compat",
  });
}

test("V2 rewind uses original receipt order after a late UUID bind and tombstones native user/output rows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-v2-rewind-bind-"));
  const store = await createConversationStore(path.join(directory, "test.sqlite"));
  const threadId = "thr_rewind_bind";
  store.saveThread({
    id: threadId,
    title: "rewind",
    prompt: "first",
    workspacePath: directory,
    status: "completed",
    message: "",
    coreKind: "claude",
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
  });
  store.upsertRunAttempt({
    threadId,
    attemptId: "run_rewind",
    phase: "execution",
    retryIndex: 0,
    status: "running",
    startedAt: "2026-10-06T00:00:00Z",
  });
  const append = (id: string, body: string, user: boolean) =>
    store.appendConversationRuntimeEvent({
      id,
      threadId,
      eventType: user ? "thread.status" : "message.final",
      scope: "main",
      role: user ? "user" : "main",
      runAttemptId: "run_rewind",
      streamState: "finalized",
      streamKey: id,
      message: body,
      observedAt: "2026-10-06T00:00:00Z",
      metadata: user ? { liveType: "thread.user_prompt", rewindTarget: { activityLineId: id } } : {},
    });
  const first = append("first", "first", true);
  const target = append("target", "target", true);
  const answer = append("answer", "answer", false);
  const future = append("future", "future", true);
  store.rebindClaudeUserMessageRecords(threadId, [
    { activityLineId: "target", upstreamMessageId: "target_sdk" },
  ]);
  const currentTarget = store
    .listConversationRuntimeSources(threadId)
    .find((source) => source.id === "target")!;
  expect(currentTarget.sequence).toBeGreaterThan(future.sequence);
  const summary = store.rewindThreadToActivityLine(threadId, "target");
  expect(summary.cutoffRunSequence).toBe(target.sequence);
  expect(
    store.conversationV2().getMessage(threadId, conversationV2ProviderMessageId(first)!)?.isDeleted,
  ).toBe(false);
  for (const removed of [target, answer, future]) {
    expect(
      store.conversationV2().getMessage(threadId, conversationV2ProviderMessageId(removed)!)?.isDeleted,
    ).toBe(true);
  }
  expect(store.listConversationRuntimeSources(threadId).map((source) => source.id)).toEqual(["first"]);
});

const presetBundle = buildResourcesFromRouteProfile(
  {
    id: "profile-a",
    name: "方案 A",
    routes: [
      { role: "main", providerId: "p1", modelId: "m1" },
      { role: "explore", providerId: "p1", modelId: "m1" },
      { role: "architect", providerId: "p1", modelId: "m1" },
      { role: "coder", providerId: "p1", modelId: "m1" },
      { role: "reviewer", providerId: "p1", modelId: "m1" },
      { role: "tester", providerId: "p1", modelId: "m1" },
    ],
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  },
  {
    mainAgentConfigId: "user.coding.main",
    subagentOrchestrationId: "user.coding.subagents",
  },
);

const settings: ModelSettingsSnapshot = {
  providers: [],
  agentTemplates: [],
  mainAgentConfigs: [presetBundle.mainAgentConfig],
  mainAgentPrompts: presetBundle.mainAgentPrompt ? [presetBundle.mainAgentPrompt] : [],
  subagentOrchestrations: [presetBundle.subagentOrchestration],
  routeProfiles: [
    {
      id: "profile-a",
      name: "方案 A",
      routes: [
        { role: "main", providerId: "p1", modelId: "m1" },
        { role: "explore", providerId: "p1", modelId: "m1" },
        { role: "architect", providerId: "p1", modelId: "m1" },
        { role: "coder", providerId: "p1", modelId: "m1" },
        { role: "reviewer", providerId: "p1", modelId: "m1" },
        { role: "tester", providerId: "p1", modelId: "m1" },
      ],
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
  ],
};

test.skipIf(!sqliteAvailable)("migrates old activity table before sdk user message index", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-activity-migration-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE thread_activity (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
  `);
  db.close();

  await createLegacyConversationStore(dbPath);

  const migrated = new sqlite.DatabaseSync(dbPath);
  const columns = migrated.prepare(`PRAGMA table_info(thread_activity)`).all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toContain("sdk_user_message_id");
  const indexes = migrated.prepare(`PRAGMA index_list(thread_activity)`).all() as Array<{ name: string }>;
  expect(indexes.map((index) => index.name)).toContain("idx_thread_activity_thread_sdk_user_message");
  migrated.close();
});

test.skipIf(!sqliteAvailable)("persists and loads thread runtime config", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-conversation-runtime-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  const runtimeConfig = buildThreadRuntimeConfigFromDefaults({
    settings,
    workflowDefaults: {
      sessionMode: "plan",
      defaultOrchestrationSelection: presetBundle.selection,
    },
  });

  const thread: ThreadSummary = {
    id: "thr_test",
    title: "Test",
    prompt: "hello",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runtimeConfig,
  };

  store.saveThread(thread);
  const loaded = store.getThread("thr_test");
  expect(loaded?.runtimeConfig).toEqual(runtimeConfig);

  store.saveThreadRuntimeConfig("thr_test", {
    ...runtimeConfig,
    sessionMode: "agent",
  });
  expect(store.getThread("thr_test")?.runtimeConfig?.sessionMode).toBe("agent");
});

test.skipIf(!sqliteAvailable)("persists the approved deferred ExitPlanMode tool id", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-pending-plan-exit-id-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  const thread: ThreadSummary = {
    id: "thr_plan",
    title: "Plan",
    prompt: "ship it",
    workspacePath: "/tmp/project",
    status: "awaiting_plan",
    message: "waiting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.saveThread(thread);
  store.savePendingPlan({
    threadId: thread.id,
    userPrompt: thread.prompt,
    analysis: "analysis",
    plan: "plan",
    workspacePath: thread.workspacePath,
    worktreePath: thread.workspacePath,
    routesJson: "[]",
    deferredExitPlanToolUseId: "tool_exit_approved",
  });

  expect(store.getPendingPlan(thread.id)?.deferredExitPlanToolUseId).toBe("tool_exit_approved");
});

test.skipIf(!sqliteAvailable)("listThreads keeps creation order when updated_at changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-thread-order-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));

  const older: ThreadSummary = {
    id: "thr_old",
    title: "Older",
    prompt: "one",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  const newer: ThreadSummary = {
    id: "thr_new",
    title: "Newer",
    prompt: "two",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
  };

  store.saveThread(older);
  store.saveThread(newer);
  store.saveThread({ ...older, updatedAt: "2025-01-01T00:00:00.000Z" });

  expect(store.listThreads().map((thread) => thread.id)).toEqual(["thr_new", "thr_old"]);
});

test.skipIf(!sqliteAvailable)("saves and lists compaction archives", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compaction-archive-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  const thread: ThreadSummary = {
    id: "thr_compact",
    title: "Compact",
    prompt: "hello",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.saveThread(thread);

  store.saveCompactionArchive("thr_compact", {
    trigger: "auto",
    sessionId: "sess_1",
    payload: { activityLineCount: 2, activityLines: [{ id: "a1", role: "system", message: "hi" }] },
  });

  const archives = store.listCompactionArchives("thr_compact");
  expect(archives).toHaveLength(1);
  expect(archives[0]?.trigger).toBe("auto");
  expect(archives[0]?.sessionId).toBe("sess_1");
  expect(archives[0]?.payload.activityLineCount).toBe(2);
});

test.skipIf(!sqliteAvailable)(
  "atomically commits compact handoff and clears main/subagent sessions",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compact-handoff-atomic-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_handoff_atomic",
      title: "Handoff",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveThread(thread);
    store.saveSdkSession(thread.id, "sess_source", "/tmp/project");
    store.upsertSubagentSessionActive({
      threadId: thread.id,
      role: "coder",
      agentId: "agent_1",
      phase: "execution",
    });

    const handoff = store.commitCompactHandoffAndClearSession(thread.id, {
      sourceSessionId: "sess_source",
      sourceStartMessageId: "msg_start",
      sourceEndMessageId: "msg_end",
      summary: "summary text",
      recentMessages: [
        { id: "u1", role: "user", message: "recent-1" },
        { id: "a1", role: "assistant", message: "recent-2" },
      ],
      preTokensEstimate: 10_000,
      preTokensSource: "sdk_context_usage",
      postTokensEstimate: 2_000,
      postTokensSource: "local_heuristic",
      compressionRatio: 0.2,
      schemaVersion: 2,
    });

    expect(handoff).toMatchObject({
      threadId: thread.id,
      schemaVersion: 2,
      generation: 1,
      sourceSessionId: "sess_source",
      preTokensEstimate: 10_000,
      preTokensSource: "sdk_context_usage",
      postTokensEstimate: 2_000,
      postTokensSource: "local_heuristic",
      compressionRatio: 0.2,
    });
    expect(handoff.summaryId).toStartWith("csm_");
    expect(store.getSdkSession(thread.id)).toBeUndefined();
    expect(store.listSubagentSessions(thread.id)).toEqual([]);
    expect(store.getCompactHandoff(thread.id)?.recentMessages).toEqual([
      { id: "u1", role: "user", message: "recent-1" },
      { id: "a1", role: "assistant", message: "recent-2" },
    ]);
  },
);

test.skipIf(!sqliteAvailable)("rolls back compact handoff when the source session changed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compact-handoff-race-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  const thread: ThreadSummary = {
    id: "thr_handoff_race",
    title: "Handoff race",
    prompt: "hello",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.saveThread(thread);
  store.saveSdkSession(thread.id, "sess_current", "/tmp/project");
  store.upsertSubagentSessionActive({
    threadId: thread.id,
    role: "coder",
    agentId: "agent_current",
    phase: "execution",
  });

  expect(() =>
    store.commitCompactHandoffAndClearSession(thread.id, {
      sourceSessionId: "sess_stale",
      sourceStartMessageId: "msg_start",
      sourceEndMessageId: "msg_end",
      summary: "stale summary",
      recentMessages: [{ role: "user", message: "recent" }],
      preTokensEstimate: 10_000,
      preTokensSource: "sdk_context_usage",
      postTokensEstimate: 2_000,
      postTokensSource: "local_heuristic",
      compressionRatio: 0.2,
    }),
  ).toThrow("源 SDK session 已变化");
  expect(store.getSdkSession(thread.id)?.sessionId).toBe("sess_current");
  expect(store.listSubagentSessions(thread.id)).toHaveLength(1);
  expect(store.getLatestCompactSummary(thread.id)).toBeUndefined();
});

test.skipIf(!sqliteAvailable)(
  "consumes a pending handoff without deleting rolling summary state",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compact-handoff-consume-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_handoff_consume",
      title: "Handoff consume",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveThread(thread);
    store.saveSdkSession(thread.id, "sess_source", "/tmp/project");
    store.commitCompactHandoffAndClearSession(thread.id, {
      sourceSessionId: "sess_source",
      sourceStartMessageId: "msg_start",
      sourceEndMessageId: "msg_end",
      summary: "summary text",
      recentMessages: [{ role: "user", message: "recent" }],
      preTokensEstimate: 10_000,
      preTokensSource: "sdk_context_usage",
      postTokensEstimate: 2_000,
      postTokensSource: "local_heuristic",
      compressionRatio: 0.2,
    });

    expect(store.getCompactHandoff(thread.id)).toBeDefined();
    expect(store.captureSdkSessionAndConsumeCompactHandoff(thread.id, "sess_target", "/tmp/project")).toBe(
      true,
    );
    expect(store.getSdkSession(thread.id)).toEqual({
      sessionId: "sess_target",
      cwd: "/tmp/project",
    });
    expect(store.getCompactHandoff(thread.id)).toBeUndefined();
    expect(store.markCompactHandoffConsumed(thread.id, "sess_other")).toBe(false);
    expect(store.getLatestCompactSummary(thread.id)).toMatchObject({
      generation: 1,
      sourceSessionId: "sess_source",
      targetSessionId: "sess_target",
    });
    expect(store.getLatestCompactSummary(thread.id)?.consumedAt).toBeTruthy();
  },
);

test.skipIf(!sqliteAvailable)(
  "rejects reinstalling the compacted source session and keeps the handoff pending",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compact-handoff-source-reuse-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_handoff_source_reuse",
      title: "Handoff source reuse",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveThread(thread);
    store.saveSdkSession(thread.id, "sess_source", "/tmp/project");
    store.commitCompactHandoffAndClearSession(thread.id, {
      sourceSessionId: "sess_source",
      sourceStartMessageId: "msg_start",
      sourceEndMessageId: "msg_end",
      summary: "summary text",
      recentMessages: [{ role: "user", message: "recent" }],
      preTokensEstimate: 10_000,
      preTokensSource: "sdk_context_usage",
      postTokensEstimate: 2_000,
      postTokensSource: "local_heuristic",
      compressionRatio: 0.2,
    });

    expect(() =>
      store.captureSdkSessionAndConsumeCompactHandoff(thread.id, "sess_source", "/tmp/project"),
    ).toThrow("新 SDK session 与源 session 相同");
    expect(store.getSdkSession(thread.id)).toBeUndefined();
    const pending = store.getCompactHandoff(thread.id);
    expect(pending?.sourceSessionId).toBe("sess_source");
    expect(pending?.targetSessionId).toBeUndefined();
    expect(pending?.consumedAt).toBeUndefined();
  },
);

test.skipIf(!sqliteAvailable)(
  "increments compact summary generation across replacement sessions",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compact-handoff-generation-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_handoff_generation",
      title: "Handoff generation",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveThread(thread);
    store.saveSdkSession(thread.id, "sess_1", "/tmp/project");
    const first = store.commitCompactHandoffAndClearSession(thread.id, {
      sourceSessionId: "sess_1",
      sourceStartMessageId: "msg_start",
      sourceEndMessageId: "msg_end",
      summary: "generation one",
      recentMessages: [{ role: "user", message: "recent one" }],
      preTokensEstimate: 10_000,
      preTokensSource: "sdk_context_usage",
      postTokensEstimate: 2_000,
      postTokensSource: "local_heuristic",
      compressionRatio: 0.2,
    });
    store.captureSdkSessionAndConsumeCompactHandoff(thread.id, "sess_2", "/tmp/project");
    const second = store.commitCompactHandoffAndClearSession(thread.id, {
      sourceSessionId: "sess_2",
      sourceStartMessageId: "msg_start",
      sourceEndMessageId: "msg_end",
      summary: "generation two",
      recentMessages: [{ role: "user", message: "recent two" }],
      preTokensEstimate: 12_000,
      preTokensSource: "sdk_context_usage",
      postTokensEstimate: 3_000,
      postTokensSource: "local_heuristic",
      compressionRatio: 0.25,
    });

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(second.summaryId).not.toBe(first.summaryId);
    expect(store.getCompactHandoff(thread.id)?.summary).toBe("generation two");
  },
);

test.skipIf(!sqliteAvailable)("migrates legacy compact handoff metadata deterministically", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compact-handoff-legacy-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE thread_compact_handoff (
      thread_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      recent_user_messages_json TEXT NOT NULL,
      post_tokens_estimate INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO thread_compact_handoff (
       thread_id, summary, recent_user_messages_json, post_tokens_estimate, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    "thr_handoff_legacy",
    "legacy summary",
    JSON.stringify(["old user 1", "old user 2"]),
    10,
    new Date().toISOString(),
  );
  db.close();

  const store = await createConversationStore(dbPath);
  expect(store.getCompactHandoff("thr_handoff_legacy")).toMatchObject({
    summaryId: "legacy-thr_handoff_legacy",
    schemaVersion: 1,
    generation: 1,
    recentMessages: [
      { role: "user", message: "old user 1" },
      { role: "user", message: "old user 2" },
    ],
    preTokensEstimate: 10,
    preTokensSource: "local_heuristic",
    postTokensEstimate: 10,
    postTokensSource: "local_heuristic",
    compressionRatio: 1,
  });
});

test.skipIf(!sqliteAvailable)(
  "rejects corrupted compact handoff version, token source, and metrics",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-compact-handoff-corrupt-"));
    const dbPath = path.join(dir, "eco-coding.sqlite");
    const store = await createConversationStore(dbPath);
    const thread: ThreadSummary = {
      id: "thr_handoff_corrupt",
      title: "Handoff corrupt",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveThread(thread);
    store.saveCompactHandoff(thread.id, {
      summary: "summary",
      recentMessages: [{ role: "user", message: "recent" }],
      preTokensEstimate: 100,
      postTokensEstimate: 50,
      compressionRatio: 0.5,
    });

    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(dbPath);
    db.prepare("UPDATE thread_compact_handoff SET pre_tokens_source = 'unknown' WHERE thread_id = ?").run(
      thread.id,
    );
    expect(() => store.getLatestCompactSummary(thread.id)).toThrow("token 来源无效");
    db.prepare(
      "UPDATE thread_compact_handoff SET pre_tokens_source = 'local_heuristic', generation = 0 WHERE thread_id = ?",
    ).run(thread.id);
    expect(() => store.getLatestCompactSummary(thread.id)).toThrow("版本信息无效");
    db.prepare(
      "UPDATE thread_compact_handoff SET generation = 1, compression_ratio = 0.9 WHERE thread_id = ?",
    ).run(thread.id);
    expect(() => store.getLatestCompactSummary(thread.id)).toThrow("压缩比例与 token 估算不一致");
    db.close();
  },
);

test.skipIf(!sqliteAvailable)("deleteThread removes thread-owned records", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-delete-thread-"));
  const store = await createLegacyConversationStore(path.join(dir, "eco-coding.sqlite"));
  const thread: ThreadSummary = {
    id: "thr_delete",
    title: "Delete",
    prompt: "hello",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  store.saveThread(thread);
  store.saveSdkSession(thread.id, "session_123", "/tmp/project");
  store.appendActivityLine(thread.id, { role: "system", message: "hello" });
  store.saveCompactionArchive(thread.id, { trigger: "auto", payload: { activityLineCount: 1 } });
  store.appendThreadRunEvent({
    id: "tre_delete",
    threadId: thread.id,
    eventType: "thread.status",
    scope: "main",
    streamState: "none",
    message: "status",
    observedAt: "2024-01-01T00:00:01.000Z",
  });

  expect(store.deleteThread(thread.id)).toBe(true);
  expect(store.getThread(thread.id)).toBeUndefined();
  expect(store.listActivityLines(thread.id)).toEqual([]);
  expect(store.listCompactionArchives(thread.id)).toEqual([]);
  expect(store.listThreadRunEvents(thread.id)).toEqual([]);
  expect(store.deleteThread(thread.id)).toBe(false);
});

test.skipIf(!sqliteAvailable)(
  "thread delete keeps its durable receipt outside the deleted conversation",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-delete-thread-command-"));
    const databasePath = path.join(dir, "eco-coding.sqlite");
    const store = await createConversationStore(databasePath);
    const thread: ThreadSummary = {
      id: "thr_delete_command",
      title: "Delete command",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    };
    store.saveThread(thread);
    store.conversationV2().ensureConversation(thread.id);
    const command = {
      principalId: "principal_delete",
      threadId: thread.id,
      clientCommandId: "delete_command_1",
      expectedHistoryRevision: 0,
    };

    expect(store.acceptThreadDeleteCommand(command)).toMatchObject({ status: "accepted" });
    expect(() => store.acceptThreadDeleteCommand({ ...command, expectedHistoryRevision: 1 })).toThrow();
    expect(() =>
      store.acceptThreadDeleteCommand({
        ...command,
        principalId: "competing_principal",
        clientCommandId: "competing_delete_command",
      }),
    ).toThrow("different accepted delete command");

    const faultDb = new DatabaseSync(databasePath);
    faultDb.exec(`
      CREATE TRIGGER fail_thread_delete_receipt_test
      BEFORE DELETE ON threads
      WHEN OLD.id = 'thr_delete_command'
      BEGIN
        SELECT RAISE(ABORT, 'forced thread delete rollback');
      END;
    `);
    faultDb.close();
    expect(() => store.completeThreadDeleteCommand(command)).toThrow("forced thread delete rollback");
    expect(store.getThread(thread.id)).toBeDefined();
    expect(store.conversationV2().hasConversation(thread.id)).toBe(true);
    expect(
      store.getThreadDeleteCommand(command.principalId, command.threadId, command.clientCommandId),
    ).toMatchObject({ status: "accepted" });

    const repairDb = new DatabaseSync(databasePath);
    repairDb.exec("DROP TRIGGER fail_thread_delete_receipt_test");
    repairDb.close();
    expect(store.completeThreadDeleteCommand(command)).toMatchObject({
      status: "completed",
      result: { ok: true, deleted: true, threadId: thread.id },
    });
    expect(store.getThread(thread.id)).toBeUndefined();
    expect(store.conversationV2().hasConversation(thread.id)).toBe(false);
    expect(store.completeThreadDeleteCommand(command)).toMatchObject({
      status: "completed",
      result: { ok: true, deleted: true, threadId: thread.id },
    });
    expect(() =>
      store.acceptThreadDeleteCommand({ ...command, clientCommandId: "delete_command_2" }),
    ).toThrow("existing V2 conversation");
  },
);

test.skipIf(!sqliteAvailable)("rewindThreadToActivityLine prunes target and later thread state", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-rewind-thread-"));
  const store = await createLegacyConversationStore(path.join(dir, "eco-coding.sqlite"));
  const thread: ThreadSummary = {
    id: "thr_rewind",
    title: "Rewind",
    prompt: "first prompt",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ok",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  store.saveThread(thread);

  const first = store.appendActivityLine(thread.id, { id: "act_first", role: "user", message: "first" });
  store.appendThreadRunEvent({
    id: "evt_first",
    threadId: thread.id,
    sequence: 1,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamKey: first.id,
    streamState: "none",
    message: "first",
    observedAt: "2024-01-01T00:00:01.000Z",
  });
  expect(store.bindLatestUserActivityToSdkMessage(thread.id, "user-first")?.rewindTarget).toEqual({
    activityLineId: "act_first",
    userMessageId: "user-first",
  });

  await new Promise((resolve) => setTimeout(resolve, 2));

  const target = store.appendActivityLine(thread.id, { id: "act_target", role: "user", message: "target" });
  store.appendThreadRunEvent({
    id: "evt_target",
    threadId: thread.id,
    sequence: 2,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamKey: target.id,
    streamState: "none",
    message: "target",
    observedAt: "2024-01-01T00:00:02.000Z",
  });
  store.bindLatestUserActivityToSdkMessage(thread.id, "user-target");
  store.appendActivityLine(thread.id, { id: "act_future", role: "main", message: "future" });
  store.appendThreadRunEvent({
    id: "evt_future",
    threadId: thread.id,
    sequence: 3,
    eventType: "thread.status",
    scope: "main",
    streamState: "none",
    message: "future",
    observedAt: "2024-01-01T00:00:03.000Z",
  });
  store.savePendingPlan({
    threadId: thread.id,
    userPrompt: "target",
    analysis: "analysis",
    plan: "plan",
    workspacePath: "/tmp/project",
    worktreePath: "/tmp/project",
    routesJson: "[]",
  });
  store.replaceCoderTodos(thread.id, [
    {
      id: "todo_future",
      threadId: thread.id,
      title: "future",
      detail: "",
      status: "pending",
      position: 0,
      updatedAt: new Date().toISOString(),
    },
  ]);
  store.saveThreadMetrics(thread.id, {
    context: { occupied: 1, limit: 10, occupancyPct: 10, limitsResolved: true, segments: [] },
  });
  store.saveAppliedDiff(thread.id, "/tmp/project", "diff --git a/a b/a", ["a"]);
  store.saveCompactionArchive(thread.id, { trigger: "auto", payload: { activityLineCount: 3 } });
  store.upsertRunAttempt({
    threadId: thread.id,
    attemptId: "attempt_future",
    phase: "execution",
    retryIndex: 0,
    status: "running",
    startedAt: new Date().toISOString(),
  });
  store.upsertAgentInstance({
    threadId: thread.id,
    agentId: "agent_future",
    role: "coder",
    kind: "subagent",
    status: "active",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.appendUsageLedgerEvent({
    id: "usage_future",
    idempotencyKey: "usage_future",
    threadId: thread.id,
    source: "sdk",
    sourceEventId: "evt_usage_future",
    usageKind: "request_final",
    role: "main",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    observedAt: new Date().toISOString(),
    attribution: { status: "unattributed", reason: "test" },
  });
  store.upsertSubagentSessionActive({
    threadId: thread.id,
    role: "coder",
    agentId: "subagent_future",
    phase: "execution",
  });
  store.upsertSubagentMetrics(thread.id, {
    agentId: "subagent_future",
    role: "coder",
    status: "active",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    contextOccupied: 2,
    contextLimit: 10,
    ecoCostUsd: 0,
    ecoCostBreakdown: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreationUsd: 0, totalUsd: 0 },
  });

  const summary = store.rewindThreadToActivityLine(thread.id, target.id);

  expect(summary.activityLineId).toBe("act_target");
  expect(summary.userMessageId).toBe("user-target");
  expect(store.listActivityLines(thread.id).map((line) => line.id)).toEqual(["act_first"]);
  expect(store.listActivityLines(thread.id)[0]?.rewindTarget).toEqual({
    activityLineId: "act_first",
    userMessageId: "user-first",
  });
  expect(store.listThreadRunEvents(thread.id).map((event) => event.id)).toEqual(["evt_first"]);
  expect(store.getUserMessageRecord(thread.id, "act_first")?.upstreamMessageId).toBe("user-first");
  expect(store.getPendingPlan(thread.id)).toBeUndefined();
  expect(store.listCoderTodos(thread.id)).toEqual([]);
  expect(store.getThreadMetrics(thread.id)).toBeUndefined();
  expect(store.getAppliedDiff(thread.id)).toBeUndefined();
  expect(store.listCompactionArchives(thread.id)).toEqual([]);
  // Rewind tombstones display history; execution facts remain recoverable in V2.
  expect(store.listRunAttempts(thread.id)).toEqual([
    expect.objectContaining({ attemptId: "attempt_future" }),
  ]);
  expect(store.listAgentInstances(thread.id)).toEqual([expect.objectContaining({ agentId: "agent_future" })]);
  expect(store.listUsageLedgerEvents(thread.id)).toEqual([]);
  expect(store.listSubagentSessions(thread.id)).toEqual([]);
  expect(store.listSubagentMetrics(thread.id)).toEqual([]);
});

test.skipIf(!sqliteAvailable)(
  "discardThreadTurnFromActivityLine drops the user turn but keeps earlier history and todos",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-discard-unstarted-"));
    const store = await createLegacyConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_discard",
      title: "Discard",
      prompt: "first prompt",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    store.saveThread(thread);

    const first = store.appendActivityLine(thread.id, { id: "user:first", role: "user", message: "first" });
    store.appendThreadRunEvent({
      id: "evt_first",
      threadId: thread.id,
      sequence: 1,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamKey: first.id,
      streamState: "none",
      message: "first",
      observedAt: "2024-01-01T00:00:01.000Z",
    });
    store.saveUserMessageRecord({
      threadId: thread.id,
      activityLineId: first.id,
      text: "first",
    });
    store.replaceCoderTodos(thread.id, [
      {
        id: "todo_keep",
        threadId: thread.id,
        title: "keep",
        detail: "",
        status: "pending",
        position: 0,
        updatedAt: new Date().toISOString(),
      },
    ]);

    const target = store.appendActivityLine(thread.id, {
      id: "user:target",
      role: "user",
      message: "target",
    });
    store.appendThreadRunEvent({
      id: "evt_target",
      threadId: thread.id,
      sequence: 2,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamKey: target.id,
      streamState: "none",
      message: "target",
      observedAt: "2024-01-01T00:00:02.000Z",
    });
    store.saveUserMessageRecord({
      threadId: thread.id,
      activityLineId: target.id,
      text: "target",
    });
    store.appendThreadRunEvent({
      id: "evt_exhaust",
      threadId: thread.id,
      sequence: 3,
      eventType: "message.final",
      scope: "main",
      streamState: "none",
      message: "Error: RetriableError: [resource_exhausted] Error",
      observedAt: "2024-01-01T00:00:03.000Z",
    });

    const summary = store.discardThreadTurnFromActivityLine(thread.id, target.id);

    expect(summary.activityLineId).toBe("user:target");
    expect(store.listActivityLines(thread.id).map((line) => line.id)).toEqual(["user:first"]);
    expect(store.listThreadRunEvents(thread.id).map((event) => event.id)).toEqual(["evt_first"]);
    expect(store.listUserMessageRecords(thread.id).map((record) => record.activityLineId)).toEqual([
      "user:first",
    ]);
    expect(store.listCoderTodos(thread.id).map((todo) => todo.id)).toEqual(["todo_keep"]);
  },
);

test.skipIf(!sqliteAvailable)(
  "rewindThreadToActivityLine supports SDK-derived virtual activity ids",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-rewind-sdk-thread-"));
    const store = await createLegacyConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_rewind_sdk",
      title: "Rewind SDK",
      prompt: "first prompt",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    store.saveThread(thread);

    store.appendThreadRunEvent({
      id: "evt_first",
      threadId: thread.id,
      sequence: 1,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "first",
      observedAt: "2024-01-01T00:00:01.000Z",
    });
    expect(store.bindLatestUserRunEventToSdkMessage(thread.id, "user-first")?.rewindTarget).toEqual({
      activityLineId: "sdk:user-first",
      userMessageId: "user-first",
    });

    const keepEvent = store.appendThreadRunEvent({
      id: "evt_keep_v2_message",
      threadId: thread.id,
      sequence: 2,
      eventType: "message.final",
      scope: "main",
      role: "assistant",
      streamKey: "assistant-before-target",
      streamState: "finalized",
      message: "must keep",
      // Deliberately after the rewind timestamp: time is not an ownership boundary.
      observedAt: "3000-01-01T00:00:01.000Z",
    });
    const keepMessageId = keepEvent.metadata?.conversationV2MessageId;
    expect(typeof keepMessageId).toBe("string");

    store.appendThreadRunEvent({
      id: "evt_target",
      threadId: thread.id,
      sequence: 3,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "target",
      observedAt: "2999-01-01T00:00:02.000Z",
    });
    store.bindLatestUserRunEventToSdkMessage(thread.id, "user-target");
    const removedEvent = store.appendThreadRunEvent({
      id: "evt_future",
      threadId: thread.id,
      sequence: 4,
      eventType: "message.final",
      scope: "main",
      role: "assistant",
      streamKey: "assistant-after-target",
      streamState: "finalized",
      message: "must remove",
      observedAt: "3001-01-01T00:00:03.000Z",
    });
    const removedMessageId = removedEvent.metadata?.conversationV2MessageId;
    expect(typeof removedMessageId).toBe("string");

    const command = store.conversationV2().acceptCommand({
      principalId: "user_rewind",
      conversationId: thread.id,
      clientCommandId: "command_rewind_1",
      commandType: "history.rewrite",
      request: { activityLineId: "sdk:user-target", prompt: "replacement" },
      expectedHistoryRevision: 0,
    });
    store
      .conversationV2()
      .beginCommandExecution(command.principalId, command.conversationId, command.clientCommandId);
    store
      .conversationV2()
      .recordCommandCheckpoint(
        command.principalId,
        command.conversationId,
        command.clientCommandId,
        "history.sdk_fork_skipped",
        { reason: "test" },
      );

    const summary = store.rewindThreadToActivityLine(thread.id, "sdk:user-target", {
      principalId: command.principalId,
      clientCommandId: command.clientCommandId,
    });

    expect(summary).toMatchObject({
      activityLineId: "sdk:user-target",
      userMessageId: "user-target",
      cutoffRunSequence: 3,
      removedActivityCount: 0,
      removedRunEventCount: 2,
    });
    expect(store.listThreadRunEvents(thread.id).map((event) => event.id)).toEqual([
      "evt_first",
      "evt_keep_v2_message",
    ]);
    expect(store.listThreadRunEvents(thread.id)[0]?.streamKey).toBe("sdk:user-first");
    expect(store.getUserMessageRecord(thread.id, "sdk:user-first")?.upstreamMessageId).toBe("user-first");
    expect(store.conversationV2().getMessage(thread.id, keepMessageId as string)).toMatchObject({
      body: "must keep",
      isDeleted: false,
    });
    expect(store.conversationV2().getMessage(thread.id, removedMessageId as string)).toMatchObject({
      body: "must remove",
      isDeleted: true,
      status: "deleted",
    });
    expect(
      store
        .conversationV2()
        .getCommandJob(command.principalId, command.conversationId, command.clientCommandId)
        ?.checkpoints.at(-1),
    ).toMatchObject({
      name: "history.local_rewrite_committed",
      payload: {
        activityLineId: "sdk:user-target",
        cutoffRunSequence: 3,
        historyRevision: 1,
      },
    });
    expect(store.listActivityLines(thread.id)).toEqual([]);
  },
);

test.skipIf(!sqliteAvailable)("atomically clears a pending plan with its V2 command checkpoint", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-plan-command-clear-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  const thread: ThreadSummary = {
    id: "thr_plan_command_clear",
    title: "Plan command clear",
    prompt: "Implement the plan",
    workspacePath: "/repo",
    status: "awaiting_plan",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    message: "",
    coreKind: "codex",
  };
  store.saveThread(thread);
  store.savePendingPlan({
    threadId: thread.id,
    userPrompt: thread.prompt,
    analysis: "analysis",
    plan: "1. implement",
    workspacePath: thread.workspacePath,
    worktreePath: thread.workspacePath,
    routesJson: "[]",
  });
  const v2 = store.conversationV2();
  v2.ensureConversation(thread.id);
  const command = v2.acceptCommand({
    principalId: "principal_plan_clear",
    conversationId: thread.id,
    clientCommandId: "plan_clear_1",
    commandType: "plan.resolve",
    request: { resolution: "approve", input: {}, context: { pendingPlan: { plan: "1. implement" } } },
    expectedHistoryRevision: 0,
  });
  v2.beginCommandExecution(command.principalId, command.conversationId, command.clientCommandId);
  v2.recordCommandCheckpoint(
    command.principalId,
    command.conversationId,
    command.clientCommandId,
    "plan.context_frozen",
    { contextHash: "hash_1" },
  );
  const agentRuntimeConfig = {
    ...buildThreadRuntimeConfigFromDefaults({
      settings,
      workflowDefaults: {
        sessionMode: "plan",
        defaultOrchestrationSelection: presetBundle.selection,
      },
    }),
    sessionMode: "agent" as const,
  };
  store.saveThreadRuntimeConfigForPlanCommand(
    thread.id,
    agentRuntimeConfig,
    { principalId: command.principalId, clientCommandId: command.clientCommandId },
    { coreKind: "codex", sessionMode: "agent" },
  );
  expect(store.getThreadRuntimeConfig(thread.id)?.sessionMode).toBe("agent");
  v2.recordCommandCheckpoint(
    command.principalId,
    command.conversationId,
    command.clientCommandId,
    "plan.snapshot_persisted",
    { snapshotPath: "/repo/.eco/approved-plans/thr_plan_command_clear.md" },
  );

  store.clearPendingPlanForCommand(thread.id, {
    principalId: command.principalId,
    clientCommandId: command.clientCommandId,
  });
  expect(store.getPendingPlan(thread.id)).toBeUndefined();
  expect(
    v2.getCommandJob(command.principalId, thread.id, command.clientCommandId)?.checkpoints.at(-1),
  ).toMatchObject({
    name: "plan.pending_cleared",
  });

  store.savePendingPlan({
    threadId: thread.id,
    userPrompt: thread.prompt,
    analysis: "analysis",
    plan: "2. keep after rollback",
    workspacePath: thread.workspacePath,
    worktreePath: thread.workspacePath,
    routesJson: "[]",
  });
  const wrongCommand = v2.acceptCommand({
    principalId: "principal_plan_clear",
    conversationId: thread.id,
    clientCommandId: "history_clear_wrong_type",
    commandType: "history.delete",
    request: { activityLineId: "line_1" },
    expectedHistoryRevision: 0,
  });
  v2.beginCommandExecution(
    wrongCommand.principalId,
    wrongCommand.conversationId,
    wrongCommand.clientCommandId,
  );
  expect(() =>
    store.saveThreadRuntimeConfigForPlanCommand(
      thread.id,
      { ...agentRuntimeConfig, sessionMode: "plan" },
      { principalId: wrongCommand.principalId, clientCommandId: wrongCommand.clientCommandId },
      { coreKind: "codex", sessionMode: "plan" },
    ),
  ).toThrow();
  expect(store.getThreadRuntimeConfig(thread.id)?.sessionMode).toBe("agent");
  expect(() =>
    store.clearPendingPlanForCommand(thread.id, {
      principalId: wrongCommand.principalId,
      clientCommandId: wrongCommand.clientCommandId,
    }),
  ).toThrow();
  expect(store.getPendingPlan(thread.id)?.plan).toBe("2. keep after rollback");
});

test.skipIf(!sqliteAvailable)(
  "atomically binds plan dispatch without letting attempt terminal overwrite its receipt",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-plan-command-dispatch-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_plan_command_dispatch",
      title: "Plan command dispatch",
      prompt: "Implement",
      workspacePath: "/repo",
      status: "awaiting_plan",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
      message: "",
      coreKind: "codex",
    };
    store.saveThread(thread);
    store.savePendingPlan({
      threadId: thread.id,
      userPrompt: thread.prompt,
      analysis: "analysis",
      plan: "Implement",
      workspacePath: thread.workspacePath,
      worktreePath: thread.workspacePath,
      routesJson: "[]",
    });
    const v2 = store.conversationV2();
    v2.ensureConversation(thread.id);
    const command = v2.acceptCommand({
      principalId: "principal_plan_dispatch",
      conversationId: thread.id,
      clientCommandId: "plan_dispatch_1",
      commandType: "plan.resolve",
      request: { resolution: "approve", input: {}, context: { pendingPlan: { plan: "Implement" } } },
      expectedHistoryRevision: 0,
    });
    v2.beginCommandExecution(command.principalId, command.conversationId, command.clientCommandId);
    v2.recordCommandCheckpoint(
      command.principalId,
      command.conversationId,
      command.clientCommandId,
      "plan.context_frozen",
      { contextHash: "hash_1" },
    );
    const prepared = prepareConversationCommandDispatch({
      v2,
      job: command,
      coreKind: "claude",
      actionKind: "plan_approval",
      phase: "execution",
      checkpointScope: "plan",
    });
    store.upsertRunAttempt(
      {
        threadId: thread.id,
        attemptId: prepared.plannedAttemptId,
        phase: "execution",
        retryIndex: 0,
        status: "running",
        startedAt: "2026-09-17T00:00:01.000Z",
        metadata: { commandDispatch: prepared.commandDispatch },
      },
      prepared.commandDispatch,
    );
    expect(
      v2.getCommandJob(command.principalId, thread.id, command.clientCommandId)?.checkpoints.at(-1),
    ).toMatchObject({
      name: "plan.runtime_dispatched",
      payload: {
        dispatchId: prepared.commandDispatch.dispatchId,
        runAttemptId: prepared.plannedAttemptId,
      },
    });
    store.clearPendingPlanForCommand(thread.id, {
      principalId: command.principalId,
      clientCommandId: command.clientCommandId,
    });
    expect(store.getPendingPlan(thread.id)).toBeUndefined();
    expect(
      v2
        .getCommandJob(command.principalId, thread.id, command.clientCommandId)
        ?.checkpoints.map((checkpoint) => checkpoint.name),
    ).toEqual([
      "execution.claimed",
      "plan.context_frozen",
      "plan.runtime_dispatch_prepared",
      "plan.runtime_dispatched",
      "plan.pending_cleared",
    ]);

    v2.completeCommand(command.principalId, thread.id, command.clientCommandId, {
      ok: true,
      resolution: "approve",
      thread: { id: thread.id, status: "running" },
    });
    store.upsertRunAttempt({
      threadId: thread.id,
      attemptId: prepared.plannedAttemptId,
      phase: "execution",
      retryIndex: 0,
      status: "completed",
      startedAt: "2026-09-17T00:00:01.000Z",
      endedAt: "2026-09-17T00:00:02.000Z",
      metadata: { commandDispatch: prepared.commandDispatch },
    });
    expect(v2.getCommandJob(command.principalId, thread.id, command.clientCommandId)).toMatchObject({
      status: "completed",
      result: { ok: true, resolution: "approve" },
    });
    expect(store.listRunAttempts(thread.id)).toContainEqual(
      expect.objectContaining({ attemptId: prepared.plannedAttemptId, status: "completed" }),
    );
  },
);

test.skipIf(!sqliteAvailable)(
  "atomically binds a prepared history command to its first V2 run attempt",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-command-dispatch-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_command_dispatch",
      title: "Command dispatch",
      prompt: "rewrite",
      workspacePath: "/tmp/project",
      status: "running",
      message: "",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    };
    store.saveThread(thread);
    const v2 = store.conversationV2();
    v2.ensureConversation(thread.id);
    const command = v2.acceptCommand({
      principalId: "principal_dispatch",
      conversationId: thread.id,
      clientCommandId: "command_dispatch_1",
      commandType: "history.retry",
      request: { rewind: false, activityLineId: "sdk:user-1", prompt: "retry", attachments: [] },
      expectedHistoryRevision: 0,
    });
    v2.beginCommandExecution(command.principalId, command.conversationId, command.clientCommandId);
    const commandDispatch = {
      principalId: command.principalId,
      clientCommandId: command.clientCommandId,
      dispatchId: "dispatch_1",
    };
    v2.recordCommandCheckpoint(
      command.principalId,
      command.conversationId,
      command.clientCommandId,
      "history.runtime_dispatch_prepared",
      { dispatchId: commandDispatch.dispatchId, plannedAttemptId: "attempt_planned" },
    );

    store.upsertRunAttempt(
      {
        threadId: thread.id,
        attemptId: "attempt_planned",
        phase: "continuation",
        retryIndex: 0,
        status: "running",
        startedAt: "2026-09-17T00:00:01.000Z",
        metadata: { commandDispatch },
      },
      commandDispatch,
    );

    expect(store.listRunAttempts(thread.id)).toEqual([
      expect.objectContaining({
        attemptId: "attempt_planned",
        status: "running",
        metadata: { commandDispatch },
      }),
    ]);
    expect(v2.getRun(thread.id, "attempt_planned")).toMatchObject({
      runId: "attempt_planned",
      status: "running",
    });
    expect(
      v2
        .getCommandJob(command.principalId, command.conversationId, command.clientCommandId)
        ?.checkpoints.at(-1),
    ).toMatchObject({
      name: "history.runtime_dispatched",
      payload: {
        dispatchId: "dispatch_1",
        runAttemptId: "attempt_planned",
        phase: "continuation",
        retryIndex: 0,
      },
    });
    expect(() =>
      store.upsertRunAttempt(
        {
          threadId: thread.id,
          attemptId: "attempt_planned",
          phase: "continuation",
          retryIndex: 0,
          status: "running",
          startedAt: "2026-09-17T00:00:02.000Z",
          metadata: { commandDispatch },
        },
        commandDispatch,
      ),
    ).toThrow("must be recovered, not dispatched again");

    store.upsertRunAttempt({
      threadId: thread.id,
      attemptId: "attempt_planned",
      phase: "continuation",
      retryIndex: 0,
      status: "completed",
      startedAt: "2026-09-17T00:00:01.000Z",
      endedAt: "2026-09-17T00:00:04.000Z",
      metadata: { commandDispatch },
    });
    expect(v2.getRun(thread.id, "attempt_planned")).toMatchObject({
      runId: "attempt_planned",
      status: "completed",
      endedAt: "2026-09-17T00:00:04.000Z",
    });
    expect(
      v2.getCommandJob(command.principalId, command.conversationId, command.clientCommandId),
    ).toMatchObject({
      status: "completed",
      result: {
        dispatchId: "dispatch_1",
        runAttemptId: "attempt_planned",
        status: "completed",
        endedAt: "2026-09-17T00:00:04.000Z",
      },
    });
    expect(() =>
      store.upsertRunAttempt({
        threadId: thread.id,
        attemptId: "attempt_bad_command_metadata",
        phase: "continuation",
        retryIndex: 0,
        status: "failed",
        startedAt: "2026-09-17T00:00:05.000Z",
        endedAt: "2026-09-17T00:00:06.000Z",
        metadata: { commandDispatch: { dispatchId: "missing-command-owner" } },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "integrity_failure",
      }),
    );
    expect(
      store
        .listRunAttempts(thread.id)
        .some((attempt) => attempt.attemptId === "attempt_bad_command_metadata"),
    ).toBe(false);

    const rollbackCommand = v2.acceptCommand({
      principalId: "principal_dispatch",
      conversationId: thread.id,
      clientCommandId: "command_dispatch_rollback",
      commandType: "history.retry",
      request: { activityLineId: "sdk:user-2" },
      expectedHistoryRevision: 0,
    });
    v2.beginCommandExecution(
      rollbackCommand.principalId,
      rollbackCommand.conversationId,
      rollbackCommand.clientCommandId,
    );
    v2.recordCommandCheckpoint(
      rollbackCommand.principalId,
      rollbackCommand.conversationId,
      rollbackCommand.clientCommandId,
      "history.sdk_fork_skipped",
      { reason: "test" },
    );
    v2.recordCommandCheckpoint(
      rollbackCommand.principalId,
      rollbackCommand.conversationId,
      rollbackCommand.clientCommandId,
      "history.local_rewrite_committed",
      { historyRevision: 2 },
    );
    const rollbackDispatch = {
      principalId: rollbackCommand.principalId,
      clientCommandId: rollbackCommand.clientCommandId,
      dispatchId: "dispatch_rollback",
    };
    v2.recordCommandCheckpoint(
      rollbackCommand.principalId,
      rollbackCommand.conversationId,
      rollbackCommand.clientCommandId,
      "history.runtime_dispatch_prepared",
      {
        dispatchId: rollbackDispatch.dispatchId,
        plannedAttemptId: "attempt_conflict",
      },
    );
    v2.ensureConversation("thr_other_command_dispatch");
    v2.append({
      conversationId: "thr_other_command_dispatch",
      eventId: "existing_conflicting_run",
      type: "run.started",
      turnId: "attempt_conflict",
      runId: "attempt_conflict",
      occurredAt: "2026-09-17T00:00:00.000Z",
      payload: {
        status: "running",
        authority: "lifecycle",
        timingQuality: "recorded",
        startedAt: "2026-09-17T00:00:00.000Z",
      },
    });

    expect(() =>
      store.upsertRunAttempt(
        {
          threadId: thread.id,
          attemptId: "attempt_conflict",
          phase: "continuation",
          retryIndex: 0,
          status: "running",
          startedAt: "2026-09-17T00:00:03.000Z",
          metadata: { commandDispatch: rollbackDispatch },
        },
        rollbackDispatch,
      ),
    ).toThrow();
    expect(store.listRunAttempts(thread.id).some((attempt) => attempt.attemptId === "attempt_conflict")).toBe(
      false,
    );
    expect(
      v2
        .getCommandJob(
          rollbackCommand.principalId,
          rollbackCommand.conversationId,
          rollbackCommand.clientCommandId,
        )
        ?.checkpoints.at(-1)?.name,
    ).toBe("history.runtime_dispatch_prepared");

    const missingAttemptCommand = v2.acceptCommand({
      principalId: "principal_dispatch",
      conversationId: thread.id,
      clientCommandId: "command_missing_attempt",
      commandType: "history.retry",
      request: { activityLineId: "sdk:user-3" },
      expectedHistoryRevision: 0,
    });
    v2.beginCommandExecution(
      missingAttemptCommand.principalId,
      missingAttemptCommand.conversationId,
      missingAttemptCommand.clientCommandId,
    );
    for (const [name, payload] of [
      ["history.sdk_fork_skipped", { reason: "test" }],
      ["history.local_rewrite_committed", { historyRevision: 3 }],
      [
        "history.runtime_dispatch_prepared",
        { dispatchId: "dispatch_missing", plannedAttemptId: "attempt_missing" },
      ],
      ["history.runtime_dispatched", { dispatchId: "dispatch_missing", runAttemptId: "attempt_missing" }],
    ] as const) {
      v2.recordCommandCheckpoint(
        missingAttemptCommand.principalId,
        missingAttemptCommand.conversationId,
        missingAttemptCommand.clientCommandId,
        name,
        payload,
      );
    }

    expect(store.reconcileRecoverableHistoryCommands(thread.id)).toEqual([
      expect.objectContaining({
        kind: "redispatch_prepared",
        plannedAttemptId: "attempt_conflict",
      }),
      expect.objectContaining({
        kind: "integrity_failure",
        reason: "Dispatched command is missing its durable run attempt.",
      }),
    ]);
    expect(
      v2.getCommandJob(
        missingAttemptCommand.principalId,
        missingAttemptCommand.conversationId,
        missingAttemptCommand.clientCommandId,
      ),
    ).toMatchObject({
      status: "failed",
      error: {
        code: "integrity_failure",
        reason: "Dispatched command is missing its durable run attempt.",
      },
    });
  },
);

test.skipIf(!sqliteAvailable)(
  "rekeys thread run events when provider request id replaces local placeholder",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-run-event-rekey-"));
    const store = await createLegacyConversationStore(path.join(dir, "eco-coding.sqlite"));
    const thread: ThreadSummary = {
      id: "thr_rekey",
      title: "Rekey",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "running",
      message: "ok",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.saveThread(thread);

    store.appendThreadRunEvent({
      id: "evt_start",
      threadId: thread.id,
      eventType: "request.started",
      scope: "main",
      streamState: "final",
      message: "Requesting model…",
      observedAt: "2026-01-01T00:00:01.000Z",
      role: "main",
      requestId: "req_local_placeholder",
    });
    store.appendThreadRunEvent({
      id: "evt_delta",
      threadId: thread.id,
      eventType: "message.delta",
      scope: "main",
      streamState: "partial",
      message: "Hello",
      observedAt: "2026-01-01T00:00:02.000Z",
      role: "main",
      requestId: "req_local_placeholder",
    });

    expect(store.rekeyThreadRunRequestId(thread.id, "req_local_placeholder", "msgreq_provider_123")).toBe(2);
    expect(store.listThreadRunEvents(thread.id).map((event) => event.requestId)).toEqual([
      "msgreq_provider_123",
      "msgreq_provider_123",
    ]);
  },
);

test.skipIf(!sqliteAvailable)("derives hostUiFeatures for acp cursor and claude threads", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-host-ui-features-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  const now = new Date().toISOString();
  store.saveThread({
    id: "thr_cursor",
    title: "Cursor",
    prompt: "hi",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "",
    createdAt: now,
    updatedAt: now,
    coreKind: "acp",
    acpAgentId: "cursor",
  });
  store.saveThread({
    id: "thr_claude",
    title: "Claude",
    prompt: "hi",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "",
    createdAt: now,
    updatedAt: now,
    coreKind: "claude",
  });
  expect(store.getThread("thr_cursor")?.hostUiFeatures).toEqual({
    contextUsage: "hide",
    billing: "hide",
  });
  expect(store.getThread("thr_claude")?.hostUiFeatures).toEqual({
    contextUsage: "show",
    billing: "show",
  });
});

test.skipIf(!sqliteAvailable)("surfaces ACP core session id on thread summaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-acp-session-summary-"));
  const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
  const now = new Date().toISOString();
  store.saveThread({
    id: "thr_acp_session",
    title: "ACP",
    prompt: "hi",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "",
    createdAt: now,
    updatedAt: now,
    coreKind: "acp",
    acpAgentId: "cursor",
  });
  expect(store.getThread("thr_acp_session")?.externalSessionId).toBeUndefined();

  store.saveThreadCoreSession({
    threadId: "thr_acp_session",
    coreKind: "acp",
    externalSessionId: "  cursor-acp-sess-1  ",
    cwd: "/tmp/project",
  });
  expect(store.getThread("thr_acp_session")?.externalSessionId).toBe("cursor-acp-sess-1");
  expect(store.listThreads().find((thread) => thread.id === "thr_acp_session")?.externalSessionId).toBe(
    "cursor-acp-sess-1",
  );
});

test.skipIf(!sqliteAvailable)("native Claude user-message rebind stays entirely in V2 storage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-native-claude-rebind-"));
  const dbPath = path.join(dir, "eco-coding.sqlite");
  const store = await createConversationStore(dbPath);
  const now = "2026-08-11T00:00:00.000Z";
  const threadId = "thr_native_claude_rebind";
  store.saveThread({
    id: threadId,
    title: "Native Claude rebind",
    prompt: "native prompt",
    workspacePath: "/tmp/project",
    status: "running",
    message: "working",
    createdAt: now,
    updatedAt: now,
    coreKind: "claude",
    coreLockedAt: now,
  });

  store.appendConversationRuntimeEvent({
    id: "native_user_prompt",
    threadId,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamState: "none",
    message: "native prompt",
    observedAt: now,
    metadata: { liveType: "thread.user_prompt" },
  });

  const bound = store.bindLatestUserActivityToSdkMessage(threadId, "claude-sdk-user");
  expect(bound?.rewindTarget).toEqual({
    activityLineId: "native_user_prompt",
    userMessageId: "claude-sdk-user",
  });
  expect(store.getUserMessageForEdit(threadId, "native_user_prompt")).toMatchObject({
    text: "native prompt",
    upstreamMessageId: "claude-sdk-user",
    provider: "claude",
  });
  expect(store.listConversationUserMessageRecords(threadId)).toEqual([
    expect.objectContaining({
      activityLineId: "native_user_prompt",
      text: "native prompt",
      upstreamMessageId: "claude-sdk-user",
      provider: "claude",
    }),
  ]);
  expect(() => store.listConversationUserMessageRecords("thr_missing_v2_stream")).toThrow(
    /Conversation V2 user-message stream is unavailable/,
  );

  const inspection = new DatabaseSync(dbPath, { readOnly: true });
  const legacyCounts = inspection
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('thread_activity', 'thread_user_messages')
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  expect(legacyCounts).toEqual([]);
  inspection.close();
});

test.skipIf(!sqliteAvailable)(
  "native Codex SDK binding assigns the first immutable history target after a pending prompt",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-native-codex-bind-"));
    const dbPath = path.join(dir, "eco-coding.sqlite");
    const store = await createConversationStore(dbPath);
    const now = "2026-09-18T00:00:00.000Z";
    const threadId = "thr_native_codex_bind";
    store.saveThread({
      id: threadId,
      title: "Native Codex bind",
      prompt: "bind me",
      workspacePath: "/tmp/project",
      status: "running",
      message: "working",
      createdAt: now,
      updatedAt: now,
      coreKind: "codex",
      coreLockedAt: now,
    });
    store.conversationV2().append({
      conversationId: threadId,
      eventId: "codex_message_created",
      sourceEventKey: "desktop:user:codex:message",
      type: "message.created",
      occurredAt: now,
      turnId: "turn_codex_bind",
      messageId: "message_user_pending",
      payload: { role: "user", body: "bind me", status: "final" },
    });
    store.appendConversationRuntimeEvent({
      id: "codex_prompt_source",
      threadId,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "bind me",
      observedAt: now,
      metadata: {
        liveType: "thread.user_prompt",
        conversationV2MessageId: "message_user_pending",
        rewindTarget: { activityLineId: "codex-pending:one" },
      },
    });

    const bound = store.bindLatestUserRunEventToSdkMessage(threadId, "codex-item-1");
    const boundHead = store.conversationV2().head(threadId).lastSeq;

    expect(bound?.rewindTarget).toEqual({
      activityLineId: "sdk:codex-item-1",
      userMessageId: "codex-item-1",
    });
    expect(store.bindLatestUserRunEventToSdkMessage(threadId, "codex-item-1")).toEqual(bound);
    expect(store.conversationV2().head(threadId).lastSeq).toBe(boundHead);
    expect(store.conversationV2().getMessage(threadId, "message_user_pending")).toMatchObject({
      historyTarget: {
        activityLineId: "sdk:codex-item-1",
        userMessageId: "codex-item-1",
      },
    });
    expect(store.listConversationRuntimeSources(threadId)).toEqual([
      expect.objectContaining({
        id: "codex_prompt_source",
        streamKey: "sdk:codex-item-1",
        metadata: expect.objectContaining({
          rewindTarget: {
            activityLineId: "sdk:codex-item-1",
            userMessageId: "codex-item-1",
          },
        }),
      }),
    ]);
    expect(store.conversationV2().listUserMessages(threadId)).toHaveLength(1);
  },
);

test.skipIf(!sqliteAvailable)(
  "startup repair removes an old Codex user-item echo without deleting the accepted prompt",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-native-codex-duplicate-repair-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const now = "2026-09-18T00:00:00.000Z";
    const threadId = "thr_native_codex_duplicate_repair";
    store.saveThread({
      id: threadId,
      title: "Native Codex duplicate repair",
      prompt: "same prompt",
      workspacePath: "/tmp/project",
      status: "running",
      message: "working",
      createdAt: now,
      updatedAt: now,
      coreKind: "codex",
      coreLockedAt: now,
    });
    store.conversationV2().append({
      conversationId: threadId,
      eventId: "accepted-message",
      sourceEventKey: "desktop:user:accepted-message",
      type: "message.created",
      occurredAt: now,
      turnId: "turn_local",
      messageId: "message_user_local",
      payload: { role: "user", body: "same prompt", status: "final" },
    });
    store.appendConversationRuntimeEvent({
      id: "local-prompt",
      threadId,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "same prompt",
      observedAt: now,
      metadata: {
        liveType: "thread.user_prompt",
        conversationV2MessageId: "message_user_local",
        rewindTarget: { activityLineId: "codex-pending:local" },
      },
    });
    store.appendConversationRuntimeEvent({
      id: "sdk-user-echo",
      threadId,
      eventType: "message.final",
      scope: "main",
      role: "user",
      streamState: "finalized",
      message: "same prompt",
      observedAt: "2026-09-18T00:00:01.000Z",
      streamKey: "codex-user-item",
      metadata: {
        liveType: "message.user",
        itemType: "userMessage",
        rewindTarget: { activityLineId: "codex-user-item", userMessageId: "codex-user-item" },
      },
    });

    expect(store.conversationV2().listUserMessages(threadId)).toHaveLength(2);
    expect(store.reconcileConversationV2CodexUserMessageDuplicates(threadId)).toEqual({
      scanned: 1,
      repaired: 1,
      ambiguous: 0,
    });
    expect(store.conversationV2().listUserMessages(threadId)).toEqual([
      expect.objectContaining({
        messageId: "message_user_local",
        historyTarget: { activityLineId: "sdk:codex-user-item", userMessageId: "codex-user-item" },
      }),
    ]);
    expect(store.listConversationRuntimeSources(threadId)).toEqual([
      expect.objectContaining({ id: "local-prompt" }),
    ]);
  },
);

test.skipIf(!sqliteAvailable)(
  "startup repair removes only the queued accepted row when an older runtime created a second prompt",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-accepted-prompt-duplicate-repair-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const now = "2026-09-18T00:00:00.000Z";
    const threadId = "thr_accepted_prompt_duplicate_repair";
    store.saveThread({
      id: threadId,
      title: "Accepted prompt duplicate repair",
      prompt: "same prompt",
      workspacePath: "/tmp/project",
      status: "running",
      message: "working",
      createdAt: now,
      updatedAt: now,
      coreKind: "codex",
      coreLockedAt: now,
    });
    const accepted = store.conversationV2().sendMessage({
      principalId: "desktop-local",
      conversationId: threadId,
      clientCommandId: "command-accepted-duplicate",
      text: "same prompt",
    });
    store.conversationV2().append({
      conversationId: threadId,
      eventId: "runtime-created-duplicate",
      sourceEventKey: "desktop:user:accepted-duplicate-runtime",
      type: "message.created",
      occurredAt: now,
      turnId: "turn_runtime_duplicate",
      messageId: "message_user_runtime_duplicate",
      payload: { role: "user", body: "same prompt", status: "final" },
    });
    store.appendConversationRuntimeEvent({
      id: "runtime-duplicate-prompt-source",
      threadId,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "same prompt",
      observedAt: now,
      streamKey: "codex-pending:duplicate",
      metadata: {
        liveType: "thread.user_prompt",
        conversationV2MessageId: "message_user_runtime_duplicate",
        rewindTarget: { activityLineId: "codex-pending:duplicate" },
      },
    });

    expect(store.conversationV2().listUserMessages(threadId)).toHaveLength(2);
    expect(store.reconcileConversationV2AcceptedPromptDuplicates(threadId)).toEqual({
      scanned: 1,
      repaired: 1,
      ambiguous: 0,
    });
    expect(store.conversationV2().listUserMessages(threadId)).toEqual([
      expect.objectContaining({ messageId: "message_user_runtime_duplicate" }),
    ]);
    expect(store.conversationV2().getMessage(threadId, accepted.messageId)).toMatchObject({
      isDeleted: true,
      status: "deleted",
    });
  },
);

test.skipIf(!sqliteAvailable)(
  "startup repair scans only the conversations that still hold a queued prompt",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-accepted-prompt-duplicate-scan-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const now = "2026-09-18T00:00:00.000Z";
    const duplicateThreadId = "thr_accepted_prompt_duplicate_scan";
    const idleThreadId = "thr_accepted_prompt_duplicate_idle";
    for (const id of [duplicateThreadId, idleThreadId]) {
      store.saveThread({
        id,
        title: "Accepted prompt duplicate scan",
        prompt: "same prompt",
        workspacePath: "/tmp/project",
        status: "running",
        message: "working",
        createdAt: now,
        updatedAt: now,
        coreKind: "codex",
        coreLockedAt: now,
      });
    }
    store.conversationV2().ensureConversation(idleThreadId);

    const accepted = store.conversationV2().sendMessage({
      principalId: "desktop-local",
      conversationId: duplicateThreadId,
      clientCommandId: "command-accepted-duplicate-scan",
      text: "same prompt",
    });
    store.conversationV2().append({
      conversationId: duplicateThreadId,
      eventId: "runtime-created-duplicate-scan",
      sourceEventKey: "desktop:user:accepted-duplicate-scan-runtime",
      type: "message.created",
      occurredAt: now,
      turnId: "turn_runtime_duplicate_scan",
      messageId: "message_user_runtime_duplicate_scan",
      payload: { role: "user", body: "same prompt", status: "final" },
    });
    store.appendConversationRuntimeEvent({
      id: "runtime-duplicate-prompt-source-scan",
      threadId: duplicateThreadId,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "same prompt",
      observedAt: now,
      streamKey: "codex-pending:duplicate-scan",
      metadata: {
        liveType: "thread.user_prompt",
        conversationV2MessageId: "message_user_runtime_duplicate_scan",
        rewindTarget: { activityLineId: "codex-pending:duplicate-scan" },
      },
    });

    // The idle stream is skipped because its prompt is no longer queued, so the
    // startup sweep never walks that conversation's event log.
    expect(store.reconcileAllConversationV2AcceptedPromptDuplicates()).toEqual({
      conversations: 1,
      scanned: 1,
      repaired: 1,
      ambiguous: 0,
    });
    expect(store.conversationV2().getMessage(duplicateThreadId, accepted.messageId)).toMatchObject({
      isDeleted: true,
      status: "deleted",
    });
  },
);

test.skipIf(!sqliteAvailable)(
  "one-time conversation repairs are recorded and never scanned twice",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-v2-repair-bookkeeping-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const now = "2026-09-18T00:00:00.000Z";
    const threadId = "thr_v2_repair_bookkeeping";
    store.saveThread({
      id: threadId,
      title: "Repair bookkeeping",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "",
      createdAt: now,
      updatedAt: now,
      coreKind: "codex",
      coreLockedAt: now,
    });
    store.conversationV2().append({
      conversationId: threadId,
      eventId: "bookkeeping-message",
      sourceEventKey: "desktop:user:bookkeeping-message",
      type: "message.created",
      occurredAt: now,
      turnId: "turn_bookkeeping",
      messageId: "message_user_bookkeeping",
      payload: { role: "user", body: "hello", status: "final" },
    });

    // Nothing queued and no runtime echo: both repairs record the conversation
    // as done instead of leaving it in the scan set.
    expect(store.reconcileConversationV2AcceptedPromptDuplicates(threadId)).toEqual({
      scanned: 0,
      repaired: 0,
      ambiguous: 0,
    });
    expect(store.reconcileConversationV2CodexUserMessageDuplicates(threadId)).toEqual({
      scanned: 0,
      repaired: 0,
      ambiguous: 0,
    });
    expect(store.reconcileAllConversationV2AcceptedPromptDuplicates()).toEqual({
      conversations: 0,
      scanned: 0,
      repaired: 0,
      ambiguous: 0,
    });
    expect(store.reconcileAllConversationV2CodexUserMessageDuplicates()).toEqual({
      conversations: 0,
      scanned: 0,
      repaired: 0,
      ambiguous: 0,
    });
  },
);

test.skipIf(!sqliteAvailable)(
  "native Claude prompt without provider identity never gets a synthetic rewind target",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-native-claude-unbound-"));
    const store = await createConversationStore(path.join(dir, "eco-coding.sqlite"));
    const now = "2026-08-11T00:00:00.000Z";
    const threadId = "thr_native_claude_unbound";
    store.saveThread({
      id: threadId,
      title: "Native Claude unbound",
      prompt: "unbound prompt",
      workspacePath: "/tmp/project",
      status: "failed",
      message: "failed",
      createdAt: now,
      updatedAt: now,
      coreKind: "claude",
      coreLockedAt: now,
    });
    store.appendConversationRuntimeEvent({
      id: "native_unbound_prompt",
      threadId,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "unbound prompt",
      observedAt: now,
      metadata: { liveType: "thread.user_prompt" },
    });

    expect(store.getActivityRewindTarget(threadId, "native_unbound_prompt")).toBeUndefined();
    expect(store.getActivityRewindTarget(threadId, "sdk:provider-only")).toBeUndefined();
    expect(store.listConversationUserMessageRecords(threadId)).toEqual([
      expect.objectContaining({
        activityLineId: "native_unbound_prompt",
        text: "unbound prompt",
      }),
    ]);
  },
);

test.skipIf(!sqliteAvailable)(
  "getUserMessageForEdit recovers Codex image prompts before SDK bind",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-image-retry-"));
    const store = await createLegacyConversationStore(path.join(dir, "eco-coding.sqlite"));
    const now = new Date().toISOString();
    const threadId = "thr_codex_image_retry";
    store.saveThread({
      id: threadId,
      title: "Codex image retry",
      prompt: "inspect screenshot",
      workspacePath: "/tmp/project",
      status: "failed",
      message: "failed",
      createdAt: now,
      updatedAt: now,
      coreKind: "codex",
      coreLockedAt: now,
    });

    store.saveUserMessageRecord({
      threadId,
      activityLineId: "codex-pending:img-1",
      text: "请根据截图修复样式",
      provider: "codex",
      attachments: [{ mediaType: "image/png", data: "full-image-payload" }],
    });
    store.appendThreadRunEvent({
      id: "live_codex_prompt",
      threadId,
      sequence: 1,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "请根据截图修复样式",
      observedAt: "2026-08-11T00:00:01.000Z",
      metadata: {
        liveType: "thread.user_prompt",
        promptImagePreviews: [{ id: "preview-1", mediaType: "image/jpeg", data: "preview-payload" }],
      },
    });

    const byPendingId = store.getUserMessageForEdit(threadId, "codex-pending:img-1");
    expect(byPendingId?.attachments).toEqual([{ mediaType: "image/png", data: "full-image-payload" }]);

    const byRunEventId = store.getUserMessageForEdit(threadId, "live_codex_prompt");
    expect(byRunEventId?.attachments).toEqual([{ mediaType: "image/png", data: "full-image-payload" }]);
  },
);

test.skipIf(!sqliteAvailable)(
  "getUserMessageForEdit falls back to prompt previews when Codex pending attachments are missing",
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-codex-image-preview-fallback-"));
    const store = await createLegacyConversationStore(path.join(dir, "eco-coding.sqlite"));
    const now = new Date().toISOString();
    const threadId = "thr_codex_preview_only";
    store.saveThread({
      id: threadId,
      title: "Codex preview only",
      prompt: "inspect screenshot",
      workspacePath: "/tmp/project",
      status: "failed",
      message: "failed",
      createdAt: now,
      updatedAt: now,
      coreKind: "codex",
      coreLockedAt: now,
    });
    store.appendThreadRunEvent({
      id: "live_codex_preview_only",
      threadId,
      sequence: 1,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "只看预览图",
      observedAt: "2026-08-11T00:00:01.000Z",
      metadata: {
        liveType: "thread.user_prompt",
        promptImagePreviews: [{ id: "preview-1", mediaType: "image/jpeg", data: "preview-payload" }],
      },
    });

    const record = store.getUserMessageForEdit(threadId, "live_codex_preview_only");
    expect(record?.attachments).toEqual([{ mediaType: "image/jpeg", data: "preview-payload" }]);
  },
);
