import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CONVERSATION_V2_ERROR, ConversationV2Error } from "@eco/shared";
import { removeTempDirectory } from "../test/helpers/temp-directory";
import { createAgentOrchestrationStore } from "../src/main/agent-orchestration-store";
import { createConversationStore } from "../src/main/conversation-store";
import { migrateCodexCompactionDetails } from "../src/main/conversation-v2-compaction-migration";
import { conversationV2ProviderReceipt } from "../src/main/conversation-v2-runtime-writer";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { FEED_SKELETON_RULES_VERSION } from "../src/main/legacy-feed-skeleton-store";
import { createProjectMcpSettingsStore } from "../src/main/project-mcp-settings-store";
import { createProjectSkillsSettingsStore } from "../src/main/project-skills-settings-store";
import type { ThreadSummary } from "../src/shared/ipc";

async function createTestDirectory(t: test.TestContext, prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await removeTempDirectory(directory);
  });
  return directory;
}

// These node:test cases exercise the retired V1 reader/writer or migration
// input directly. Keeping the mode explicit prevents a compatibility fixture
// from silently becoming a production default.
async function createLegacyConversationStore(dbPath: string) {
  return createConversationStore(dbPath, {
    freshStorageMode: "legacy_compat",
    requiredStorageMode: "legacy_compat",
  });
}

test("Node SQLite upgrades native compaction receipts atomically and reopens their latest state", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-compaction-");
  const filename = path.join(directory, "compaction.sqlite");
  let db = new DatabaseSync(filename);
  try {
    let v2 = new ConversationV2Store(db);
    v2.initialize();
    v2.append({
      conversationId: "thread",
      eventId: "run-start",
      runId: "run",
      turnId: "run",
      type: "run.started",
      occurredAt: "2026-10-07T03:28:00.000Z",
      payload: { status: "running" },
    });
    for (const stage of ["started", "completed"] as const) {
      v2.append(
        conversationV2ProviderReceipt(
          {
            id: `compaction-${stage}`,
            threadId: "thread",
            runAttemptId: "run",
            eventType: `context.compaction.${stage}`,
            scope: "main",
            streamState: "none",
          observedAt: stage === "started" ? "2026-10-07T03:28:39.020Z" : "2026-10-07T03:28:52.297Z",
            message: stage,
            sequence: 0,
            metadata: { itemType: "contextCompaction" },
          },
          "runtime-input",
        ),
      );
    }
    assert.equal(migrateCodexCompactionDetails(db, v2), 2);
    assert.equal(v2.bootstrap("thread").details?.length, 2);
    assert.equal(JSON.parse(v2.bootstrap("thread").details![1]!.content!).timing.durationMs, 13_277);
    db.close();
    db = new DatabaseSync(filename);
    v2 = new ConversationV2Store(db);
    v2.initialize();
    assert.equal(migrateCodexCompactionDetails(db, v2), 0);
    v2.rebuildReadModels("thread");
    assert.deepEqual(
      v2.bootstrap("thread").details?.map((detail) => detail.type),
      ["context.compaction.started", "context.compaction.completed"],
    );
    assert.equal(JSON.parse(v2.bootstrap("thread").details![1]!.content!).timing.durationMs, 13_277);
    const head = v2.head("thread").lastSeq;
    assert.equal(head, 5);
    assert.equal(v2.sync("thread", v2.getStoreEpoch(), 3).effects[0]?.effect.type, "detail.upsert");
  } finally {
    db.close();
  }
});

test("Node SQLite remembers Skills independently for each project", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-project-skills-");
  const store = await createProjectSkillsSettingsStore(path.join(directory, "eco-coding.sqlite"));
  const projectA = path.join(directory, "a");
  const projectB = path.join(directory, "b");

  store.save({ workspacePath: projectA, enabledByPath: { "user:a": true } });
  store.save({ workspacePath: projectB, enabledByPath: { "user:a": false } });

  assert.deepEqual(store.get(projectA).enabledByPath, { "user:a": true });
  assert.deepEqual(store.get(projectB).enabledByPath, { "user:a": false });
});

test("Node SQLite remembers MCP switches independently for each project", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-project-mcp-");
  const store = await createProjectMcpSettingsStore(path.join(directory, "eco-coding.sqlite"));
  const projectA = path.join(directory, "a");
  const projectB = path.join(directory, "b");

  store.save({ workspacePath: projectA, enabledByServer: { github: true, browser: false } });
  store.save({ workspacePath: projectB, enabledByServer: { github: false, browser: true } });

  assert.deepEqual(store.get(projectA).enabledByServer, { github: true, browser: false });
  assert.deepEqual(store.get(projectB).enabledByServer, { github: false, browser: true });
});

test("Node SQLite stores independent orchestration resources and deletes them independently", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-orchestration-store-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createAgentOrchestrationStore(databasePath);
  const updatedAt = "2026-01-01T00:00:00.000Z";

  store.saveMainAgentConfig({
    id: "main_1",
    name: "Main",
    agentKey: "main",
    modelRef: { providerId: "provider_1", modelId: "model_1" },
    tools: { allowed: [], disallowed: [] },
    skills: [],
    source: "user",
    updatedAt,
  });
  store.saveMainAgentPrompt({
    id: "prompt_1",
    name: "Prompt",
    mode: "custom_append",
    prompt: "Follow the project conventions.",
    source: "user",
    updatedAt,
  });
  store.saveSubagentOrchestration({
    id: "subagents_1",
    name: "Subagents",
    strategy: { kind: "autonomous" },
    agents: [],
    source: "user",
    updatedAt,
  });

  const selection = {
    mainAgentConfigId: "main_1",
    mainPrompt: { mode: "custom_append" as const, promptId: "prompt_1" },
    subagents: { mode: "orchestration" as const, orchestrationId: "subagents_1" },
  };
  assert.equal(store.listMainAgentConfigs().length, 1);
  assert.equal(store.listMainAgentPrompts().length, 1);
  assert.equal(store.listSubagentOrchestrations().length, 1);
  // Deleting a resource is no longer refused when a remembered default selection points at
  // it: the callers clear that reference first and then delete. Both halves are asserted —
  // the clearing in workflow-settings-store.test.ts, the deletion here.
  assert.equal(selection.mainAgentConfigId, "main_1");
  assert.equal(store.deleteMainAgentConfig("main_1"), undefined);
  assert.deepEqual(
    store.listMainAgentConfigs().map((config) => config.id),
    [],
  );
  assert.deepEqual(
    store.listMainAgentPrompts().map((prompt) => prompt.id),
    ["prompt_1"],
  );
  assert.deepEqual(
    store.listSubagentOrchestrations().map((orchestration) => orchestration.id),
    ["subagents_1"],
  );
  store.saveSubagentOrchestration({
    id: "subagents_1",
    name: "Subagents",
    strategy: { kind: "autonomous" },
    agents: [],
    source: "user",
    updatedAt,
  });

  store.deleteMainAgentConfig("main_1");
  store.deleteMainAgentPrompt("prompt_1");
  store.deleteSubagentOrchestration("subagents_1");
  assert.deepEqual(store.listMainAgentConfigs(), []);
  assert.deepEqual(store.listMainAgentPrompts(), []);
  assert.deepEqual(store.listSubagentOrchestrations(), []);

  const inspection = new DatabaseSync(databasePath);
  t.after(() => inspection.close());
  const tables = inspection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(tables, [
    "agent_templates",
    "main_agent_configs",
    "main_agent_prompts",
    "subagent_orchestrations",
  ]);
});

test("Node SQLite persists an Eco thread and Claude session binding", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-sqlite-store-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath);
  const now = new Date().toISOString();
  const thread: ThreadSummary = {
    id: "thr_node_sqlite",
    title: "Node SQLite",
    prompt: "verify persistence",
    workspacePath: "/tmp/eco-node-sqlite",
    status: "idle",
    message: "ready",
    createdAt: now,
    updatedAt: now,
  };

  store.saveThread(thread);
  store.saveSdkSession(thread.id, "sdk_session_node", thread.workspacePath);

  assert.deepEqual(store.getSdkSession(thread.id), {
    sessionId: "sdk_session_node",
    cwd: thread.workspacePath,
  });
  assert.equal(store.getThread(thread.id)?.title, thread.title);
  assert.equal(store.getThread(thread.id)?.coreKind, "claude");
  assert.equal(store.getThread(thread.id)?.externalSessionId, "sdk_session_node");
  assert.ok(store.getThread(thread.id)?.coreLockedAt);
  assert.deepEqual(
    {
      coreKind: store.getThreadCoreSession(thread.id)?.coreKind,
      externalSessionId: store.getThreadCoreSession(thread.id)?.externalSessionId,
      cwd: store.getThreadCoreSession(thread.id)?.cwd,
    },
    {
      coreKind: "claude",
      externalSessionId: "sdk_session_node",
      cwd: thread.workspacePath,
    },
  );

  const inspection = new DatabaseSync(databasePath);
  const row = inspection
    .prepare("SELECT title, core_kind, core_locked_at, sdk_session_id, sdk_cwd FROM threads WHERE id = ?")
    .get(thread.id) as
    | {
        title: string;
        core_kind: string;
        core_locked_at: string;
        sdk_session_id: string;
        sdk_cwd: string;
      }
    | undefined;
  assert.equal(row?.title, thread.title);
  assert.equal(row?.core_kind, "claude");
  assert.ok(row?.core_locked_at);
  assert.equal(row?.sdk_session_id, "sdk_session_node");
  assert.equal(row?.sdk_cwd, thread.workspacePath);
  inspection.close();
});

test("Node SQLite pages the initial and older remote thread lists independently", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-thread-list-page-");
  const store = await createConversationStore(path.join(directory, "eco-coding.sqlite"));
  const workspacePath = "/tmp/eco-thread-list-page";
  for (let index = 0; index < 7; index += 1) {
    const day = String(index + 1).padStart(2, "0");
    store.saveThread({
      id: `thr_page_${index}`,
      title: `Thread ${index}`,
      prompt: `prompt ${index}`,
      workspacePath,
      status: index === 0 ? "running" : "idle",
      message: "",
      createdAt: `2026-01-${day}T00:00:00.000Z`,
      updatedAt: `2026-01-${day}T00:00:00.000Z`,
    });
  }
  store.saveThread({
    id: "thr_other_workspace",
    title: "Other workspace",
    prompt: "other",
    workspacePath: "/tmp/other-workspace",
    status: "idle",
    message: "",
    createdAt: "2026-01-20T00:00:00.000Z",
    updatedAt: "2026-01-20T00:00:00.000Z",
  });

  const initial = store.listInitialThreads(5);
  assert.deepEqual(
    initial.threads.map((thread) => thread.id),
    [
      "thr_page_6",
      "thr_page_5",
      "thr_page_4",
      "thr_page_3",
      "thr_page_2",
      "thr_page_0",
      "thr_other_workspace",
    ],
  );
  assert.equal(initial.pages[workspacePath]?.totalCount, 7);
  assert.equal(initial.pages[workspacePath]?.hasMore, true);
  assert.equal(initial.pages[workspacePath]?.nextCursor?.id, "thr_page_2");

  const cursor = initial.pages[workspacePath]?.nextCursor;
  assert.ok(cursor);
  const older = store.listThreadPage(workspacePath, cursor, 20);
  assert.deepEqual(
    older.threads.map((thread) => thread.id),
    ["thr_page_1", "thr_page_0"],
  );
  assert.equal(older.hasMore, false);
  assert.equal(older.totalCount, 7);
});

test("Node SQLite atomically claims and reconciles streaming follow-ups", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-streaming-follow-up-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath);
  const threadId = "thr_streaming_follow_up";
  store.saveThread({
    id: threadId,
    title: "Streaming follow-up",
    prompt: "verify delivery state",
    workspacePath: "/tmp/eco-streaming-follow-up",
    status: "running",
    message: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const accepted = store.enqueueThreadFollowUp({ threadId, prompt: "accepted" });
  const claimed = store.claimThreadFollowUpStreamingPush(threadId, accepted.id, {
    targetRunAttemptId: "attempt_push",
  });
  assert.equal(claimed?.status, "delivered");
  assert.equal(claimed?.deliveryMode, "streaming_push");
  assert.equal(claimed?.appliedAt, undefined);
  assert.equal(store.cancelThreadFollowUp(threadId, accepted.id), undefined);
  assert.equal(
    store.updateThreadFollowUp(threadId, accepted.id, { prompt: "must not replace sent text" }),
    undefined,
  );
  assert.equal(store.markThreadFollowUpStreamingPushApplied(threadId, accepted.id)?.status, "applied");

  const rejected = store.enqueueThreadFollowUp({
    threadId,
    prompt: "explicitly rejected",
    priority: "escalated",
  });
  store.claimThreadFollowUpStreamingPush(threadId, rejected.id);
  const requeued = store.requeueThreadFollowUpStreamingPush(threadId, rejected.id, {
    error: "no active turn",
  });
  assert.equal(requeued?.status, "queued");
  assert.equal(requeued?.deliveryMode, "interrupt_resume");
  assert.equal(requeued?.deliveredAt, undefined);

  const uncertain = store.enqueueThreadFollowUp({ threadId, prompt: "uncertain" });
  store.claimThreadFollowUpStreamingPush(threadId, uncertain.id);
  const failed = store.markThreadFollowUpDeliveryUnknown(
    threadId,
    uncertain.id,
    "transport closed after send",
  );
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.deliveryMode, "streaming_push");
  assert.equal(
    store.claimQueuedThreadFollowUps(threadId).some((item) => item.id === uncertain.id),
    false,
  );

  const orphaned = store.enqueueThreadFollowUp({ threadId, prompt: "crashed in flight" });
  store.claimThreadFollowUpStreamingPush(threadId, orphaned.id);
  const reopened = await createConversationStore(databasePath);
  const recovered = reopened
    .listThreadFollowUps(threadId, { statuses: ["delivered"] })
    .find((followUp) => followUp.id === orphaned.id);
  assert.equal(recovered?.deliveryMode, "streaming_push");
  assert.equal(
    reopened.markThreadFollowUpDeliveryUnknown(threadId, orphaned.id, "application exited during push")
      ?.status,
    "failed",
  );
});

test("Node SQLite updates Codex cumulative stream events in place", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-codex-stream-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const threadId = "thr_node_codex_stream";
  store.saveThread({
    id: threadId,
    title: "Codex stream",
    prompt: "verify cumulative output",
    workspacePath: "/tmp/eco-node-codex-stream",
    status: "running",
    message: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const id = "tre:codex:message.delta:codex-thread:turn:item";
  const baseEvent = {
    id,
    threadId,
    eventType: "message.delta" as const,
    scope: "main" as const,
    role: "assistant",
    requestId: "codex-turn",
    streamKey: "msg_codex",
    streamState: "streaming" as const,
  };
  const first = store.appendThreadRunEvent({
    ...baseEvent,
    message: "对，",
    observedAt: "2026-01-01T00:00:01.000Z",
  });
  const updated = store.appendThreadRunEvent({
    ...baseEvent,
    message: "对，这是完整的累计流文本。",
    observedAt: "2026-01-01T00:00:02.000Z",
  });

  const events = store.listThreadRunEvents(threadId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.message, "对，这是完整的累计流文本。");
  assert.ok(updated.sequence > first.sequence);
});

test("Node SQLite projects tool metadata and migrates legacy output exactly once", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-tool-output-projection-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const threadId = "thr_tool_output_projection";
  const store = await createLegacyConversationStore(databasePath);
  store.saveThread({
    id: threadId,
    title: "Tool output projection",
    prompt: "verify migration",
    workspacePath: "/tmp/tool-output-projection",
    status: "idle",
    message: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const projectedRead = store.appendThreadRunEvent({
    id: "projected_read",
    threadId,
    eventType: "tool.completed",
    scope: "main",
    streamState: "finalized",
    message: "Tool: Read",
    observedAt: "2026-01-01T00:00:01.000Z",
    metadata: {
      tool: {
        name: "Read",
        toolUseId: "read_1",
        output: "secret contents",
        outputPreview: "secret preview",
        outputPreviewTruncated: true,
      },
    },
  });
  assert.deepEqual(projectedRead.metadata?.tool, { name: "Read", toolUseId: "read_1" });

  const projectedBash = store.appendThreadRunEvent({
    id: "projected_bash",
    threadId,
    eventType: "tool.completed",
    scope: "main",
    streamState: "finalized",
    message: "Tool: Bash",
    observedAt: "2026-01-01T00:00:02.000Z",
    metadata: {
      tool: {
        name: "Bash",
        detail: "bun test",
        output: "raw field must not persist",
        outputPreview: `head\n${"x".repeat(20_000)}\ntail`,
        exitCode: 0,
      },
    },
  });
  const projectedBashTool = projectedBash.metadata?.tool as Record<string, unknown>;
  assert.equal("output" in projectedBashTool, false);
  assert.equal(projectedBashTool.outputPreviewTruncated, true);
  assert.ok(String(projectedBashTool.outputPreview).startsWith("head\n"));
  assert.ok(String(projectedBashTool.outputPreview).endsWith("\ntail"));
  assert.ok(String(projectedBashTool.outputPreview).length <= 8_000);

  (store as unknown as { db: DatabaseSync }).db.close();
  const legacyDb = new DatabaseSync(databasePath);
  const insertLegacy = legacyDb.prepare(`
    INSERT INTO thread_run_events (
      id, thread_id, sequence, event_type, scope, stream_state, message, metadata_json, observed_at
    ) VALUES (?, ?, ?, ?, 'main', 'finalized', ?, ?, ?)
  `);
  insertLegacy.run(
    "legacy_bash",
    threadId,
    3,
    "tool.completed",
    "Tool: Bash",
    JSON.stringify({
      tool: {
        name: "Bash",
        output: `${"a".repeat(10_000)}\n\n…（输出已截断，完整内容未写入上下文；详见运行日志提示）`,
        outputTruncated: true,
        outputOriginalChars: 10_000,
        outputKeptChars: 8_000,
      },
    }),
    "2026-01-01T00:00:03.000Z",
  );
  insertLegacy.run(
    "legacy_search",
    threadId,
    4,
    "tool.completed",
    "Tool: Grep",
    JSON.stringify({
      tool: {
        name: "Grep",
        detail: "needle",
        output: "matching source text",
        outputPreview: "matching source preview",
      },
    }),
    "2026-01-01T00:00:04.000Z",
  );
  insertLegacy.run(
    "legacy_notice",
    threadId,
    5,
    "context.tool_output_truncated",
    "Read output truncated",
    JSON.stringify({ liveType: "context.tool_output_truncated" }),
    "2026-01-01T00:00:05.000Z",
  );
  insertLegacy.run(
    "legacy_invalid",
    threadId,
    6,
    "tool.completed",
    "Tool: Read",
    "{bad json",
    "2026-01-01T00:00:06.000Z",
  );
  legacyDb
    .prepare("DELETE FROM conversation_store_migrations WHERE id = ?")
    .run("thread-run-tool-output-projection-v1");
  legacyDb.close();

  const originalStderrWrite = process.stderr.write;
  let migrationWarning = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    migrationWarning += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let migrated: Awaited<ReturnType<typeof createConversationStore>>;
  try {
    migrated = await createLegacyConversationStore(databasePath);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  assert.match(migrationWarning, /count=1/);
  assert.match(migrationWarning, /eventIds=legacy_invalid/);

  const migratedEvents = migrated.listThreadRunEvents(threadId);
  assert.equal(
    migratedEvents.some((event) => event.id === "legacy_notice"),
    false,
  );
  const legacyBash = migratedEvents.find((event) => event.id === "legacy_bash");
  const legacyBashTool = legacyBash?.metadata?.tool as Record<string, unknown>;
  assert.equal("output" in legacyBashTool, false);
  assert.equal("outputOriginalChars" in legacyBashTool, false);
  assert.equal(legacyBashTool.outputPreviewTruncated, true);
  assert.ok(!String(legacyBashTool.outputPreview).includes("完整内容未写入上下文"));
  assert.ok(String(legacyBashTool.outputPreview).length <= 8_000);
  assert.deepEqual(migratedEvents.find((event) => event.id === "legacy_search")?.metadata?.tool, {
    name: "Grep",
    detail: "needle",
  });

  (migrated as unknown as { db: DatabaseSync }).db.close();
  const inspection = new DatabaseSync(databasePath);
  assert.equal(
    (
      inspection
        .prepare("SELECT COUNT(*) AS count FROM thread_run_events WHERE event_type = ?")
        .get("context.tool_output_truncated") as { count: number }
    ).count,
    0,
  );
  assert.equal(
    (
      inspection
        .prepare("SELECT COUNT(*) AS count FROM conversation_store_migrations WHERE id = ?")
        .get("thread-run-tool-output-projection-v1") as { count: number }
    ).count,
    1,
  );
  const storedMetadata = inspection
    .prepare("SELECT id, metadata_json FROM thread_run_events WHERE metadata_json IS NOT NULL")
    .all() as Array<{ id: string; metadata_json: string }>;
  for (const row of storedMetadata) {
    if (row.id === "legacy_invalid") continue;
    const metadata = JSON.parse(row.metadata_json) as { tool?: Record<string, unknown> };
    assert.equal(metadata.tool && "output" in metadata.tool, false, row.id);
    if (metadata.tool?.name !== "Bash") {
      assert.equal(metadata.tool && "outputPreview" in metadata.tool, false, row.id);
      assert.equal(metadata.tool && "outputPreviewTruncated" in metadata.tool, false, row.id);
    }
  }
  inspection.close();

  const reopened = await createLegacyConversationStore(databasePath);
  assert.equal(
    reopened.listThreadRunEvents(threadId).some((event) => event.id === "legacy_notice"),
    false,
  );
  (reopened as unknown as { db: DatabaseSync }).db.close();
});

test("Node SQLite incrementally maintains bounded projection reads in WAL mode", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-projection-cache-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createLegacyConversationStore(databasePath);
  const threadId = "thr_projection_cache";
  const streamId = "tre:stream:thr_projection_cache:message.delta:stream_1";
  store.saveThread({
    id: threadId,
    title: "Projection cache",
    prompt: "stream",
    workspacePath: "/tmp/projection-cache",
    status: "running",
    message: "working",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const appendStream = (id: string, message: string, observedAt: string) =>
    store.appendThreadRunEvent({
      id,
      threadId,
      eventType: "message.delta",
      scope: "agent",
      role: "coder",
      agentId: "agent_coder_a",
      runAttemptId: "attempt_1",
      requestId: "request_1",
      streamKey: "stream_1",
      streamState: "streaming",
      message,
      observedAt,
    });

  const initialStream = appendStream(streamId, "一", "2026-01-01T00:00:01.000Z");
  store.appendThreadRunEvent({
    id: "final_before_cache",
    threadId,
    eventType: "message.final",
    scope: "agent",
    role: "coder",
    agentId: "agent_coder_a",
    streamState: "finalized",
    message: "第一轮完成",
    observedAt: "2026-01-01T00:00:02.000Z",
  });

  const first = store.listThreadRunEventsForProjection(threadId, 10);
  assert.strictEqual(store.listThreadRunEventsForProjection(threadId, 10), first);

  const updatedStream = appendStream(streamId, "一段增量文字", "2026-01-01T00:00:03.000Z");
  assert.ok(updatedStream.sequence > initialStream.sequence);
  const afterStableUpdate = store.listThreadRunEventsForProjection(threadId, 10);
  assert.notStrictEqual(afterStableUpdate, first);
  assert.equal(afterStableUpdate.find((event) => event.id === streamId)?.message, "一段增量文字");

  appendStream("legacy_stream_replacement", "旧格式的新累计行", "2026-01-01T00:00:04.000Z");
  assert.deepEqual(
    store.listThreadRunEventsForProjection(threadId, 10).map((event) => event.id),
    ["final_before_cache", "legacy_stream_replacement"],
  );
  assert.equal(store.compactLegacyThreadRunStreamEvents(), 1);
  assert.deepEqual(
    store.listThreadRunEvents(threadId).map((event) => event.id),
    ["final_before_cache", "legacy_stream_replacement"],
  );

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const journal = inspection.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(journal.journal_mode, "wal");
  inspection.close();

  store.clearThreadRunEvents(threadId);
  assert.equal(appendStream("after_clear", "重新开始", "2026-01-01T00:00:05.000Z").sequence, 1);
  assert.deepEqual(
    store.listThreadRunEventsForProjection(threadId, 10).map((event) => event.id),
    ["after_clear"],
  );
});

test("Node SQLite persists composer drafts and clears deleted thread drafts", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-composer-draft-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath);

  store.saveComposerDraft("landing:/tmp/project", "draft on landing", [
    { mediaType: "image/png", data: "base64-image" },
  ]);
  const reloaded = await createConversationStore(databasePath);
  assert.deepEqual(reloaded.getComposerDraft("landing:/tmp/project"), {
    contextKey: "landing:/tmp/project",
    prompt: "draft on landing",
    attachments: [{ mediaType: "image/png", data: "base64-image" }],
    revision: reloaded.getComposerDraft("landing:/tmp/project")?.revision,
    updatedAt: reloaded.getComposerDraft("landing:/tmp/project")?.updatedAt,
  });

  const now = new Date().toISOString();
  reloaded.saveThread({
    id: "thr_composer_draft",
    title: "Composer draft",
    prompt: "initial",
    workspacePath: "/tmp/project",
    status: "idle",
    message: "ready",
    createdAt: now,
    updatedAt: now,
  });
  const versioned = reloaded.saveComposerDraft(
    "thread:thr_composer_draft",
    "thread draft",
    undefined,
    "Cursor session failed",
  );
  assert.equal(reloaded.getComposerDraft("thread:thr_composer_draft")?.prompt, "thread draft");
  const autosaved = reloaded.saveComposerDraft("thread:thr_composer_draft", "thread draft");
  assert.equal(autosaved?.recoveryReason, "Cursor session failed");
  assert.equal(autosaved?.revision, versioned?.revision);
  const edited = reloaded.saveComposerDraft("thread:thr_composer_draft", "thread draft edited");
  assert.equal(edited?.recoveryReason, "Cursor session failed");
  assert.notEqual(edited?.revision, versioned?.revision);
  assert.equal(reloaded.deleteComposerDraft("thread:thr_composer_draft", "stale-version"), false);
  assert.equal(reloaded.getComposerDraft("thread:thr_composer_draft")?.revision, edited?.revision);
  assert.equal(reloaded.deleteComposerDraft("thread:thr_composer_draft", edited?.revision), true);
  reloaded.saveComposerDraft("thread:thr_composer_draft", "thread draft");

  reloaded.deleteThread("thr_composer_draft");
  assert.equal(reloaded.getComposerDraft("thread:thr_composer_draft"), undefined);

  reloaded.saveComposerDraft("landing:/tmp/project", "");
  assert.equal(reloaded.getComposerDraft("landing:/tmp/project"), undefined);
});

test("Node SQLite migrates legacy composer drafts to opaque revisions", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-composer-draft-migration-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE composer_drafts (
      context_key TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  legacy
    .prepare(
      `INSERT INTO composer_drafts (context_key, prompt, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run("thread:legacy", "legacy recovery", "2026-08-22T00:00:00.000Z");
  legacy.close();

  const store = await createConversationStore(databasePath);
  const migrated = store.getComposerDraft("thread:legacy");
  assert.equal(migrated?.prompt, "legacy recovery");
  assert.ok(migrated?.revision);
  assert.equal(migrated?.attachments, undefined);
  assert.equal(migrated?.recoveryReason, undefined);
  assert.equal(store.deleteComposerDraft("thread:legacy", "stale-revision"), false);
  assert.equal(store.deleteComposerDraft("thread:legacy", migrated?.revision), true);
});

test("Node SQLite persists reordered follow-ups", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-follow-up-reorder-");
  const store = await createConversationStore(path.join(directory, "eco-coding.sqlite"));
  const now = new Date().toISOString();
  store.saveThread({
    id: "thr_followup_reorder",
    title: "Follow-up reorder",
    prompt: "start",
    workspacePath: "/tmp/follow-up-reorder",
    status: "running",
    message: "working",
    createdAt: now,
    updatedAt: now,
  });
  const first = store.enqueueThreadFollowUp({ threadId: "thr_followup_reorder", prompt: "第一条" });
  const second = store.enqueueThreadFollowUp({ threadId: "thr_followup_reorder", prompt: "第二条" });

  const reordered = store.reorderQueuedThreadFollowUps("thr_followup_reorder", [second.id, first.id]);

  assert.deepEqual(
    reordered.map((item) => item.id),
    [second.id, first.id],
  );
  assert.deepEqual(
    store.listThreadFollowUps("thr_followup_reorder", { statuses: ["queued"] }).map((item) => item.id),
    [second.id, first.id],
  );
});

test("Node SQLite claims queued follow-ups one at a time by default", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-follow-up-queue-");
  const store = await createConversationStore(path.join(directory, "eco-coding.sqlite"));
  const now = new Date().toISOString();
  store.saveThread({
    id: "thr_followup_queue",
    title: "Follow-up queue",
    prompt: "start",
    workspacePath: "/tmp/follow-up-queue",
    status: "running",
    message: "working",
    createdAt: now,
    updatedAt: now,
  });
  const first = store.enqueueThreadFollowUp({
    threadId: "thr_followup_queue",
    prompt: "第一条",
  });
  const second = store.enqueueThreadFollowUp({
    threadId: "thr_followup_queue",
    prompt: "第二条",
  });

  const claimed = store.claimQueuedThreadFollowUps("thr_followup_queue", {
    deliveryMode: "resume",
    deliveryBoundary: "safe_boundary",
  });

  assert.deepEqual(
    claimed.map((item) => item.id),
    [first.id],
  );
  assert.equal(store.getThreadFollowUp("thr_followup_queue", first.id)?.status, "delivered");
  assert.equal(store.getThreadFollowUp("thr_followup_queue", second.id)?.status, "queued");
});

test("Node SQLite migrates the legacy thread activity schema", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-sqlite-migration-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sdk_session_id TEXT,
      sdk_cwd TEXT
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
  legacy
    .prepare(
      `INSERT INTO threads (
         id, title, prompt, workspace_path, status, message, created_at, updated_at,
         sdk_session_id, sdk_cwd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "thr_legacy_claude",
      "Legacy Claude",
      "legacy prompt",
      "/tmp/legacy-claude",
      "idle",
      "ready",
      "2026-01-01T00:00:00.000Z",
      "2026-01-02T00:00:00.000Z",
      "sdk_legacy",
      "/tmp/legacy-claude",
    );
  legacy.close();

  await createLegacyConversationStore(databasePath);

  const migrated = new DatabaseSync(databasePath);
  const columns = migrated.prepare("PRAGMA table_info(thread_activity)").all() as Array<{ name: string }>;
  assert.ok(columns.some((column) => column.name === "sdk_user_message_id"));
  const indexes = migrated.prepare("PRAGMA index_list(thread_activity)").all() as Array<{ name: string }>;
  assert.ok(indexes.some((index) => index.name === "idx_thread_activity_thread_sdk_user_message"));
  const thread = migrated
    .prepare("SELECT core_kind, core_locked_at FROM threads WHERE id = 'thr_legacy_claude'")
    .get() as { core_kind: string; core_locked_at: string } | undefined;
  assert.equal(thread?.core_kind, "claude");
  assert.equal(thread?.core_locked_at, "2026-01-01T00:00:00.000Z");
  const binding = migrated
    .prepare(
      `SELECT core_kind, external_session_id, cwd
       FROM thread_core_sessions
       WHERE thread_id = 'thr_legacy_claude'`,
    )
    .get() as { core_kind: string; external_session_id: string; cwd: string } | undefined;
  assert.equal(binding?.core_kind, "claude");
  assert.equal(binding?.external_session_id, "sdk_legacy");
  assert.equal(binding?.cwd, "/tmp/legacy-claude");
  migrated.close();
});

test("Node SQLite rejects a Claude session binding for a Codex thread", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-sqlite-core-mismatch-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath);
  const now = new Date().toISOString();
  store.saveThread({
    id: "thr_codex",
    title: "Codex",
    prompt: "codex prompt",
    workspacePath: "/tmp/codex",
    status: "idle",
    message: "ready",
    createdAt: now,
    updatedAt: now,
    coreKind: "codex",
    coreLockedAt: now,
  });

  assert.throws(
    () => store.saveSdkSession("thr_codex", "sdk_wrong_core", "/tmp/codex"),
    /Thread Core mismatch/,
  );
  assert.equal(store.getSdkSession("thr_codex"), undefined);
  assert.equal(store.getThreadCoreSession("thr_codex"), undefined);

  store.saveThreadCoreSession({
    threadId: "thr_codex",
    coreKind: "codex",
    externalSessionId: "codex_thread_1",
    cwd: "/tmp/codex",
    metadata: { schemaVersion: 1 },
  });
  assert.deepEqual(store.getThreadCoreSession("thr_codex")?.metadata, { schemaVersion: 1 });
  assert.equal(store.getThreadCoreSession("thr_codex")?.externalSessionId, "codex_thread_1");
  assert.equal(store.getThread("thr_codex")?.externalSessionId, "codex_thread_1");
});

test("Node SQLite leaves ambiguous mixed-product thread ownership unknown", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-sqlite-mixed-migration-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sdk_session_id TEXT,
      sdk_cwd TEXT
    );
    CREATE TABLE eco_thread_codex_map (
      eco_thread_id TEXT PRIMARY KEY,
      codex_thread_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const insertThread = legacy.prepare(
    `INSERT INTO threads (
       id, title, prompt, workspace_path, status, message, created_at, updated_at,
       sdk_session_id, sdk_cwd
     ) VALUES (?, ?, '', '/tmp/project', 'idle', 'ready', ?, ?, ?, ?)`,
  );
  const createdAt = "2026-02-01T00:00:00.000Z";
  insertThread.run("thr_only_codex", "Codex", createdAt, createdAt, null, null);
  insertThread.run("thr_only_claude", "Claude", createdAt, createdAt, "sdk_claude", "/tmp/project");
  insertThread.run("thr_conflict", "Conflict", createdAt, createdAt, "sdk_conflict", "/tmp/project");
  insertThread.run("thr_unknown", "Unknown", createdAt, createdAt, null, null);
  const insertMap = legacy.prepare(
    `INSERT INTO eco_thread_codex_map (eco_thread_id, codex_thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  insertMap.run("thr_only_codex", "codex_only", createdAt, createdAt);
  insertMap.run("thr_conflict", "codex_conflict", createdAt, createdAt);
  legacy.close();

  const store = await createLegacyConversationStore(databasePath);

  assert.equal(store.getThread("thr_only_codex")?.coreKind, "codex");
  assert.equal(store.getThread("thr_only_claude")?.coreKind, "claude");
  assert.equal(store.getThread("thr_conflict")?.coreKind, undefined);
  assert.equal(store.getThread("thr_unknown")?.coreKind, undefined);
  assert.throws(
    () =>
      store.saveThreadCoreSession({
        threadId: "thr_conflict",
        coreKind: "codex",
        externalSessionId: "codex_conflict",
        cwd: "/tmp/project",
      }),
    /Thread Core mismatch/,
  );
});

test("Node SQLite keeps the unified Claude binding in sync across compaction", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-sqlite-compact-binding-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath);
  const now = new Date().toISOString();
  store.saveThread({
    id: "thr_compact_binding",
    title: "Compact binding",
    prompt: "compact",
    workspacePath: "/tmp/compact-binding",
    status: "idle",
    message: "ready",
    createdAt: now,
    updatedAt: now,
    coreKind: "claude",
    coreLockedAt: now,
  });
  store.saveSdkSession("thr_compact_binding", "sdk_source", "/tmp/compact-binding");

  store.commitCompactHandoffAndClearSession("thr_compact_binding", {
    sourceSessionId: "sdk_source",
    sourceStartMessageId: "msg_start",
    sourceEndMessageId: "msg_end",
    summary: "summary",
    recentMessages: [{ role: "user", message: "recent" }],
    preTokensEstimate: 10_000,
    preTokensSource: "sdk_context_usage",
    postTokensEstimate: 2_000,
    postTokensSource: "local_heuristic",
    compressionRatio: 0.2,
  });
  assert.equal(store.getSdkSession("thr_compact_binding"), undefined);
  assert.equal(store.getThreadCoreSession("thr_compact_binding"), undefined);

  assert.equal(
    store.captureSdkSessionAndConsumeCompactHandoff(
      "thr_compact_binding",
      "sdk_target",
      "/tmp/compact-binding",
    ),
    true,
  );
  assert.equal(store.getSdkSession("thr_compact_binding")?.sessionId, "sdk_target");
  assert.equal(store.getThreadCoreSession("thr_compact_binding")?.externalSessionId, "sdk_target");
  assert.equal(store.getCompactHandoff("thr_compact_binding"), undefined);
});

test("Node SQLite binds projection-only Claude prompts to SDK messages", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-claude-projection-bind-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const now = "2026-08-11T00:00:00.000Z";
  store.saveThread({
    id: "thr_claude_projection",
    title: "Claude projection",
    prompt: "first prompt",
    workspacePath: "/tmp/project",
    status: "completed",
    message: "ok",
    coreKind: "claude",
    coreLockedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  store.appendThreadRunEvent({
    id: "evt_claude_prompt",
    threadId: "thr_claude_projection",
    sequence: 1,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamKey: "user:local-prompt",
    streamState: "none",
    message: "first prompt",
    observedAt: "2026-08-11T00:00:01.000Z",
    metadata: {
      liveType: "thread.user_prompt",
      rewindTarget: { activityLineId: "user:local-prompt" },
    },
  });
  store.saveUserMessageRecord({
    threadId: "thr_claude_projection",
    activityLineId: "user:local-prompt",
    text: "first prompt",
    provider: "claude",
  });

  assert.deepEqual(
    store.bindLatestUserActivityToSdkMessage("thr_claude_projection", "sdk-user-1")?.rewindTarget,
    { activityLineId: "user:local-prompt", userMessageId: "sdk-user-1" },
  );
  assert.equal(
    store.getUserMessageRecord("thr_claude_projection", "user:local-prompt")?.upstreamMessageId,
    "sdk-user-1",
  );
  assert.deepEqual(store.listThreadRunEvents("thr_claude_projection")[0]?.metadata?.rewindTarget, {
    activityLineId: "user:local-prompt",
    userMessageId: "sdk-user-1",
  });
});

test("Node SQLite rewinds projection-only Claude user activity lines", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-claude-projection-rewind-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const now = "2026-08-11T00:00:00.000Z";
  store.saveThread({
    id: "thr_claude_proj_rewind",
    title: "Claude projection rewind",
    prompt: "first prompt",
    workspacePath: "/tmp/project",
    status: "completed",
    message: "ok",
    coreKind: "claude",
    coreLockedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  store.appendThreadRunEvent({
    id: "evt_prompt_a",
    threadId: "thr_claude_proj_rewind",
    sequence: 1,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamKey: "user:local-a",
    streamState: "none",
    message: "first prompt",
    observedAt: "2026-08-11T00:00:01.000Z",
    metadata: {
      liveType: "thread.user_prompt",
      rewindTarget: { activityLineId: "user:local-a" },
    },
  });
  store.saveUserMessageRecord({
    threadId: "thr_claude_proj_rewind",
    activityLineId: "user:local-a",
    text: "first prompt",
    provider: "claude",
  });
  store.bindLatestUserActivityToSdkMessage("thr_claude_proj_rewind", "sdk-user-a");

  store.appendThreadRunEvent({
    id: "evt_prompt_b",
    threadId: "thr_claude_proj_rewind",
    sequence: 2,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamKey: "user:local-b",
    streamState: "none",
    message: "second prompt",
    observedAt: "2999-01-01T00:00:02.000Z",
    metadata: {
      liveType: "thread.user_prompt",
      rewindTarget: { activityLineId: "user:local-b" },
    },
  });
  store.saveUserMessageRecord({
    threadId: "thr_claude_proj_rewind",
    activityLineId: "user:local-b",
    text: "second prompt",
    provider: "claude",
    createdAt: "2999-01-01T00:00:02.000Z",
  });
  store.bindLatestUserActivityToSdkMessage("thr_claude_proj_rewind", "sdk-user-b");

  store.appendThreadRunEvent({
    id: "evt_future",
    threadId: "thr_claude_proj_rewind",
    sequence: 3,
    eventType: "thread.status",
    scope: "main",
    streamState: "none",
    message: "future",
    observedAt: "3000-01-01T00:00:03.000Z",
  });

  const summary = store.rewindThreadToActivityLine("thr_claude_proj_rewind", "user:local-b");
  assert.deepEqual(
    {
      activityLineId: summary.activityLineId,
      userMessageId: summary.userMessageId,
      cutoffRunSequence: summary.cutoffRunSequence,
      removedRunEventCount: summary.removedRunEventCount,
    },
    {
      activityLineId: "user:local-b",
      userMessageId: "sdk-user-b",
      cutoffRunSequence: 2,
      removedRunEventCount: 2,
    },
  );
  assert.deepEqual(
    store.listThreadRunEvents("thr_claude_proj_rewind").map((event) => event.id),
    ["evt_prompt_a"],
  );
  assert.equal(store.getUserMessageRecord("thr_claude_proj_rewind", "user:local-b"), undefined);
  assert.equal(
    store.getUserMessageRecord("thr_claude_proj_rewind", "user:local-a")?.upstreamMessageId,
    "sdk-user-a",
  );
});

test("Node SQLite discards an unstarted ACP user turn without clearing earlier todos", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-acp-discard-unstarted-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const now = "2026-08-11T00:00:00.000Z";
  store.saveThread({
    id: "thr_acp_discard",
    title: "ACP discard",
    prompt: "first",
    workspacePath: "/tmp/project",
    status: "completed",
    message: "",
    coreKind: "acp",
    coreLockedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  store.appendActivityLine("thr_acp_discard", { id: "user:first", role: "user", message: "first" });
  store.appendThreadRunEvent({
    id: "evt_first",
    threadId: "thr_acp_discard",
    sequence: 1,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamKey: "user:first",
    streamState: "none",
    message: "first",
    observedAt: "2026-08-11T00:00:01.000Z",
  });
  store.saveUserMessageRecord({
    threadId: "thr_acp_discard",
    activityLineId: "user:first",
    text: "first",
    provider: "acp",
  });
  store.replaceCoderTodos("thr_acp_discard", [
    {
      id: "todo_keep",
      threadId: "thr_acp_discard",
      title: "keep",
      detail: "",
      status: "pending",
      position: 0,
      updatedAt: now,
    },
  ]);
  store.appendActivityLine("thr_acp_discard", { id: "user:target", role: "user", message: "target" });
  store.appendThreadRunEvent({
    id: "evt_target",
    threadId: "thr_acp_discard",
    sequence: 2,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamKey: "user:target",
    streamState: "none",
    message: "target",
    observedAt: "2026-08-11T00:00:02.000Z",
  });
  store.saveUserMessageRecord({
    threadId: "thr_acp_discard",
    activityLineId: "user:target",
    text: "target",
    provider: "acp",
  });
  store.appendThreadRunEvent({
    id: "evt_exhaust",
    threadId: "thr_acp_discard",
    sequence: 3,
    eventType: "message.final",
    scope: "main",
    streamState: "none",
    message: "Error: RetriableError: [resource_exhausted] Error",
    observedAt: "2026-08-11T00:00:03.000Z",
  });

  const summary = store.discardThreadTurnFromActivityLine("thr_acp_discard", "user:target");
  assert.equal(summary.activityLineId, "user:target");
  assert.deepEqual(
    store.listActivityLines("thr_acp_discard").map((line) => line.id),
    ["user:first"],
  );
  assert.deepEqual(
    store.listThreadRunEvents("thr_acp_discard").map((event) => event.id),
    ["evt_first"],
  );
  assert.deepEqual(
    store.listUserMessageRecords("thr_acp_discard").map((record) => record.activityLineId),
    ["user:first"],
  );
  assert.deepEqual(
    store.listCoderTodos("thr_acp_discard").map((todo) => todo.id),
    ["todo_keep"],
  );
});

test("Node SQLite repairs projection-only Claude history from transcript mappings", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-claude-history-rebind-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const now = "2026-08-11T00:00:00.000Z";
  store.saveThread({
    id: "thr_claude_legacy",
    title: "Claude legacy",
    prompt: "legacy prompt",
    workspacePath: "/tmp/project",
    status: "completed",
    message: "ok",
    coreKind: "claude",
    coreLockedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  store.appendThreadRunEvent({
    id: "evt_legacy_prompt",
    threadId: "thr_claude_legacy",
    sequence: 1,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamState: "none",
    message: "legacy prompt",
    observedAt: "2026-08-11T00:00:01.000Z",
    metadata: { liveType: "thread.user_prompt" },
  });

  const records = store.ensureClaudeUserMessageRecordsFromRunEvents("thr_claude_legacy");
  assert.equal(records.length, 1);
  assert.equal(records[0]?.activityLineId, "evt_legacy_prompt");

  store.rebindClaudeUserMessageRecords("thr_claude_legacy", [
    { activityLineId: "evt_legacy_prompt", upstreamMessageId: "sdk-user-legacy" },
  ]);

  assert.equal(
    store.getUserMessageRecord("thr_claude_legacy", "evt_legacy_prompt")?.upstreamMessageId,
    "sdk-user-legacy",
  );
  assert.deepEqual(store.listThreadRunEvents("thr_claude_legacy")[0]?.metadata?.rewindTarget, {
    activityLineId: "evt_legacy_prompt",
    userMessageId: "sdk-user-legacy",
  });
});

test("Node SQLite attributeThreadRunEventsByLogicalRequestId patches started+terminal atomically", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-late-bind-attr-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const threadId = "thr_late_bind_db";
  const logicalRequestId = "req_late_bind_1";
  store.saveThread({
    id: threadId,
    title: "Late bind",
    prompt: "hi",
    workspacePath: "/tmp/late-bind",
    status: "running",
    message: "working",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  store.appendThreadRunEvent({
    id: "evt_started",
    threadId,
    eventType: "request.started",
    scope: "main",
    role: "coder",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "Requesting model…",
    observedAt: "2026-01-01T00:00:01.000Z",
  });
  store.appendThreadRunEvent({
    id: "evt_terminal",
    threadId,
    eventType: "request.completed",
    scope: "main",
    role: "coder",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "Request completed",
    observedAt: "2026-01-01T00:00:02.000Z",
  });

  const patched = store.attributeThreadRunEventsByLogicalRequestId(threadId, logicalRequestId, {
    agentId: "agent_a",
    role: "coder",
  });
  assert.deepEqual(patched, { updated: 2, conflict: false });

  const events = store.listThreadRunEvents(threadId);
  assert.equal(events.find((e) => e.id === "evt_started")?.agentId, "agent_a");
  assert.equal(events.find((e) => e.id === "evt_terminal")?.agentId, "agent_a");
  assert.equal(events.find((e) => e.id === "evt_started")?.scope, "agent");
  assert.equal(events.find((e) => e.id === "evt_terminal")?.scope, "agent");
});

test("Node SQLite attributeThreadRunEventsByLogicalRequestId conflict fail closed keeps all rows", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-late-bind-conflict-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const threadId = "thr_late_bind_conflict";
  const logicalRequestId = "req_conflict_1";
  store.saveThread({
    id: threadId,
    title: "Late bind conflict",
    prompt: "hi",
    workspacePath: "/tmp/late-bind-conflict",
    status: "running",
    message: "working",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  store.appendThreadRunEvent({
    id: "evt_started",
    threadId,
    eventType: "request.started",
    scope: "agent",
    role: "coder",
    agentId: "agent_existing",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "Requesting model…",
    observedAt: "2026-01-01T00:00:01.000Z",
  });
  store.appendThreadRunEvent({
    id: "evt_terminal",
    threadId,
    eventType: "request.completed",
    scope: "main",
    role: "coder",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "Request completed",
    observedAt: "2026-01-01T00:00:02.000Z",
  });

  const patched = store.attributeThreadRunEventsByLogicalRequestId(threadId, logicalRequestId, {
    agentId: "agent_new",
    role: "coder",
  });
  assert.deepEqual(patched, { updated: 0, conflict: true });

  const events = store.listThreadRunEvents(threadId);
  assert.equal(events.find((e) => e.id === "evt_started")?.agentId, "agent_existing");
  assert.equal(events.find((e) => e.id === "evt_terminal")?.agentId, undefined);
  assert.equal(events.find((e) => e.id === "evt_terminal")?.scope, "main");
});

test("Node SQLite attributeThreadRunEventsByLogicalRequestId role conflict fail closed", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-late-bind-role-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const threadId = "thr_late_bind_role";
  const logicalRequestId = "req_role_conflict";
  store.saveThread({
    id: threadId,
    title: "Late bind role",
    prompt: "hi",
    workspacePath: "/tmp/late-bind-role",
    status: "running",
    message: "working",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  store.appendThreadRunEvent({
    id: "evt_started",
    threadId,
    eventType: "request.started",
    scope: "main",
    role: "planner",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "Requesting model…",
    observedAt: "2026-01-01T00:00:01.000Z",
  });

  const patched = store.attributeThreadRunEventsByLogicalRequestId(threadId, logicalRequestId, {
    agentId: "agent_a",
    role: "coder",
  });
  assert.deepEqual(patched, { updated: 0, conflict: true });
  assert.equal(store.listThreadRunEvents(threadId)[0]?.agentId, undefined);
});

test("Node SQLite late-bind normalizes scope/role when agent_id already matches (idempotent replay)", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-late-bind-idempotent-");
  const store = await createLegacyConversationStore(path.join(directory, "eco-coding.sqlite"));
  const threadId = "thr_late_bind_idempotent";
  const logicalRequestId = "req_idempotent_1";
  store.saveThread({
    id: threadId,
    title: "Late bind idempotent",
    prompt: "hi",
    workspacePath: "/tmp/late-bind-idempotent",
    status: "running",
    message: "working",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  store.appendThreadRunEvent({
    id: "evt_started_main_scope",
    threadId,
    eventType: "request.started",
    scope: "main",
    role: "coder",
    agentId: "agent_a",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "Requesting model…",
    observedAt: "2026-01-01T00:00:01.000Z",
  });
  store.appendThreadRunEvent({
    id: "evt_thinking",
    threadId,
    eventType: "thinking.final",
    scope: "main",
    role: "thinking",
    agentId: "agent_a",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "…",
    observedAt: "2026-01-01T00:00:01.500Z",
  });
  store.appendThreadRunEvent({
    id: "evt_terminal_missing_role",
    threadId,
    eventType: "request.completed",
    scope: "main",
    agentId: "agent_a",
    requestId: logicalRequestId,
    streamState: "finalized",
    message: "Request completed",
    observedAt: "2026-01-01T00:00:02.000Z",
  });

  const first = store.attributeThreadRunEventsByLogicalRequestId(threadId, logicalRequestId, {
    agentId: "agent_a",
    role: "coder",
  });
  assert.ok(first.updated >= 2);
  assert.equal(first.conflict, false);

  const events = store.listThreadRunEvents(threadId);
  assert.equal(events.find((e) => e.id === "evt_started_main_scope")?.scope, "agent");
  assert.equal(events.find((e) => e.id === "evt_started_main_scope")?.role, "coder");
  assert.equal(events.find((e) => e.id === "evt_thinking")?.role, "thinking");
  assert.equal(events.find((e) => e.id === "evt_thinking")?.scope, "agent");
  assert.equal(events.find((e) => e.id === "evt_terminal_missing_role")?.role, "coder");
  assert.equal(events.find((e) => e.id === "evt_terminal_missing_role")?.scope, "agent");

  const replay = store.attributeThreadRunEventsByLogicalRequestId(threadId, logicalRequestId, {
    agentId: "agent_a",
    role: "coder",
  });
  assert.deepEqual(replay, { updated: 0, conflict: false });
});

test("Node SQLite persists thread feed skeleton snapshots", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-feed-skeleton-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createLegacyConversationStore(databasePath);
  const threadId = "thr_feed_skeleton";
  store.saveThread({
    id: threadId,
    title: "Feed skeleton",
    prompt: "hello",
    workspacePath: path.join(directory, "project"),
    status: "idle",
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.appendThreadRunEvent({
    id: "evt_user",
    threadId,
    eventType: "message.final",
    scope: "thread",
    role: "user",
    streamState: "finalized",
    message: "hello",
    observedAt: "2026-01-01T00:00:01.000Z",
    metadata: { liveType: "thread.user_prompt" },
  });

  const snapshot = {
    thread: {
      threadId,
      status: "idle",
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    attempts: [],
    agents: [],
    requestSpans: [],
    timeline: [
      {
        id: "evt_user",
        sequence: 1,
        eventType: "message.final",
        scope: "thread",
        role: "user",
        text: "hello",
        at: "2026-01-01T00:00:01.000Z",
      },
    ],
    diagnostics: [],
    sourceEventCount: 1,
    historyRevision: 0,
  };

  store.saveThreadFeedSkeleton(threadId, {
    historyRevision: 0,
    maxEventSequence: store.getThreadRunEventMaxSequence(threadId),
    snapshot,
    patchState: {
      trackedItems: snapshot.timeline,
      finalizedSdkBlocks: [],
      rulesVersion: FEED_SKELETON_RULES_VERSION,
    },
  });

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const v2Cache = inspection
    .prepare(`SELECT COUNT(*) AS count FROM conversation_feed_skeletons_v2 WHERE conversation_id = ?`)
    .get(threadId) as { count: number };
  const legacyCache = inspection
    .prepare(`SELECT COUNT(*) AS count FROM thread_feed_skeleton WHERE thread_id = ?`)
    .get(threadId) as { count: number };
  assert.equal(v2Cache.count, 1);
  assert.equal(legacyCache.count, 0);
  inspection.close();

  const loaded = store.getThreadFeedSkeleton(threadId);
  assert.ok(loaded);
  assert.equal(loaded?.historyRevision, 0);
  assert.equal(loaded?.maxEventSequence, 1);
  assert.equal(loaded?.snapshot.timeline[0]?.text, "hello");
  assert.equal(loaded?.patchState?.trackedItems.length, 1);
  assert.equal(loaded?.patchState?.rulesVersion, FEED_SKELETON_RULES_VERSION);

  // Patch state written by an older rules version must not be trusted: the caller then
  // rebuilds from events instead of patching with incompatible semantics.
  store.saveThreadFeedSkeleton(threadId, {
    historyRevision: 0,
    maxEventSequence: 1,
    snapshot,
    patchState: {
      trackedItems: snapshot.timeline,
      finalizedSdkBlocks: [],
      rulesVersion: FEED_SKELETON_RULES_VERSION - 1,
    },
  });
  assert.equal(store.getThreadFeedSkeleton(threadId)?.patchState, undefined);

  store.saveThreadFeedSkeleton(threadId, {
    historyRevision: 0,
    maxEventSequence: 1,
    snapshot,
    patchState: {
      trackedItems: snapshot.timeline,
      finalizedSdkBlocks: [],
      rulesVersion: FEED_SKELETON_RULES_VERSION,
    },
  });

  store.touchThreadFeedSkeletonSequence(threadId, 4);
  const touched = store.getThreadFeedSkeleton(threadId);
  assert.equal(touched?.maxEventSequence, 4);
  assert.equal(touched?.snapshot.timeline[0]?.text, "hello");

  store.appendThreadRunEvent({
    id: "evt_tool",
    threadId,
    eventType: "tool.completed",
    scope: "agent",
    role: "tool",
    streamState: "finalized",
    message: "ignored for skeleton",
    observedAt: "2026-01-01T00:00:02.000Z",
  });
  assert.equal(store.getThreadRunEventMaxSequence(threadId), 2);
  assert.ok(store.getThreadFeedSkeleton(threadId));

  store.deleteThread(threadId);
  assert.equal(store.getThreadFeedSkeleton(threadId), undefined);
});

test("production fresh conversation stores start V2-only without recreating V1 tables", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-v2-only-fresh-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath, { freshStorageMode: "v2_only" });

  assert.equal(store.getConversationStorageMode(), "v2_only");
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const retiredTables = inspection
    .prepare(
      `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('thread_activity', 'thread_agent_instances', 'thread_coder_todos',
                        'thread_run_events', 'thread_user_messages', 'thread_feed_skeleton',
                        'thread_metrics_snapshots', 'thread_usage_ledger_events',
                        'thread_subagent_sessions', 'thread_subagent_metrics',
                        'thread_run_attempts', 'thread_pending_followups', 'thread_pending_plans')
         ORDER BY name`,
    )
    .all();
  assert.deepEqual(retiredTables, []);
  assert.equal(
    (
      inspection
        .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'`)
        .get() as { value: string }
    ).value,
    "v2_only",
  );
  inspection.close();
});

test("V2-only reopen migrates and retires a recreated legacy pending-plan table", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-v2-only-pending-plan-reopen-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath, { freshStorageMode: "v2_only" });
  const threadId = "thr_v2_only_pending_plan_reopen";
  store.saveThread({
    id: threadId,
    title: "Pending plan reopen",
    prompt: "hello",
    workspacePath: path.join(directory, "project"),
    status: "awaiting_plan",
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const rawDb = (store as unknown as { db: DatabaseSync }).db;
  rawDb.exec(`
    CREATE TABLE thread_pending_plans (
      thread_id TEXT PRIMARY KEY,
      user_prompt TEXT NOT NULL,
      analysis TEXT NOT NULL,
      plan TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      routes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  rawDb
    .prepare(
      `INSERT INTO thread_pending_plans
       (thread_id, user_prompt, analysis, plan, workspace_path, worktree_path, routes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      threadId,
      "reopen prompt",
      "reopen analysis",
      "1. reopen",
      path.join(directory, "project"),
      path.join(directory, "project"),
      "[]",
      "2026-01-01T00:00:01.000Z",
    );
  rawDb.close();

  const reopened = await createConversationStore(databasePath, {
    requiredStorageMode: "v2_only",
  });
  t.after(() => (reopened as unknown as { db: DatabaseSync }).db.close());

  assert.deepEqual(reopened.getPendingPlan(threadId), {
    threadId,
    userPrompt: "reopen prompt",
    analysis: "reopen analysis",
    plan: "1. reopen",
    workspacePath: path.join(directory, "project"),
    worktreePath: path.join(directory, "project"),
    routesJson: "[]",
  });
  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const legacyTable = inspection
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_pending_plans'`)
    .all();
  const v2Table = inspection
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_pending_plans_v2'`)
    .all() as Array<{ name: string }>;
  assert.deepEqual(legacyTable, []);
  assert.deepEqual(
    v2Table.map((row) => row.name),
    ["conversation_pending_plans_v2"],
  );
  inspection.close();
});

test("V2-only read entry points fail closed when a thread loses its V2 stream", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-v2-only-missing-stream-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createConversationStore(databasePath);
  const threadId = "thr_v2_only_missing_stream";
  store.saveThread({
    id: threadId,
    title: "Missing V2 stream",
    prompt: "hello",
    workspacePath: path.join(directory, "project"),
    status: "idle",
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.switchToV2OnlyStorage();

  const rawDb = (store as unknown as { db: DatabaseSync }).db;
  rawDb.prepare(`DELETE FROM conversation_streams_v2 WHERE conversation_id = ?`).run(threadId);

  const assertIntegrityFailure = (error: unknown): boolean =>
    error instanceof ConversationV2Error && error.code === CONVERSATION_V2_ERROR.integrityFailure;
  assert.throws(() => store.listActivityLines(threadId), assertIntegrityFailure);
  assert.throws(() => store.listUserMessageRecords(threadId), assertIntegrityFailure);
  assert.throws(() => store.getUserMessageRecord(threadId, "missing"), assertIntegrityFailure);
  assert.throws(() => store.getUserMessageForEdit(threadId, "missing"), assertIntegrityFailure);
  assert.throws(() => store.getActivityRewindTarget(threadId, "missing"), assertIntegrityFailure);
  assert.throws(() => store.bindLatestUserActivityToSdkMessage(threadId, "user"), assertIntegrityFailure);
  assert.throws(() => store.bindLatestUserRunEventToSdkMessage(threadId, "user"), assertIntegrityFailure);
  assert.throws(() => store.listThreadRunEvents(threadId), assertIntegrityFailure);
  assert.throws(() => store.clearThreadRunEvents(threadId), assertIntegrityFailure);
  assert.throws(() => store.listConversationUserMessageRecords(threadId), assertIntegrityFailure);
});

test("prompt image content references are authorized by their V2 conversation or landing draft", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-prompt-image-auth-");
  const store = await createConversationStore(path.join(directory, "eco-coding.sqlite"));
  const now = "2026-01-01T00:00:00.000Z";
  const threadA = "thr_prompt_image_auth_a";
  const threadB = "thr_prompt_image_auth_b";
  for (const threadId of [threadA, threadB]) {
    store.saveThread({
      id: threadId,
      title: threadId,
      prompt: "prompt",
      workspacePath: path.join(directory, threadId),
      status: "idle",
      message: "",
      createdAt: now,
      updatedAt: now,
    });
  }
  const refA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const refB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const appendImageMessage = (conversationId: string, eventId: string, contentRef: string) =>
    store.conversationV2().append({
      conversationId,
      eventId,
      sourceEventKey: eventId,
      type: "message.created",
      occurredAt: now,
      turnId: `${eventId}:turn`,
      messageId: `${eventId}:message`,
      payload: {
        role: "user",
        channel: "answer",
        body: "图片",
        status: "final",
        attachments: [{ mediaType: "image/png", contentRef, byteLength: 3 }],
      },
    });
  appendImageMessage(threadA, "prompt_image_auth_a_event", refA);
  appendImageMessage(threadB, "prompt_image_auth_b_event", refB);

  const landingKey = `landing:${path.join(directory, "landing")}`;
  const landingRef = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  store.saveComposerDraft(landingKey, "", [
    { mediaType: "image/png", contentRef: landingRef, byteLength: 3 },
  ]);

  assert.equal(store.isPromptImageContentRefAuthorized(`thread:${threadA}`, refA), true);
  assert.equal(store.isPromptImageContentRefAuthorized(`thread:${threadA}`, refB), false);
  assert.equal(store.isPromptImageContentRefAuthorized(`thread:${threadB}`, refA), false);
  assert.equal(store.isPromptImageContentRefAuthorized(landingKey, landingRef), true);
  assert.equal(store.isPromptImageContentRefAuthorized(landingKey, refA), false);

  store.switchToV2OnlyStorage();
  assert.equal(store.isPromptImageContentRefAuthorized(`thread:${threadA}`, refA), true);
  assert.equal(store.isPromptImageContentRefAuthorized(`thread:${threadA}`, refB), false);
  assert.equal(store.isPromptImageContentRefAuthorized(landingKey, landingRef), true);

  const rawDb = (store as unknown as { db: DatabaseSync }).db;
  rawDb.prepare(`DELETE FROM conversation_streams_v2 WHERE conversation_id = ?`).run(threadA);
  assert.equal(store.isPromptImageContentRefAuthorized(`thread:${threadA}`, refA), false);
});

test("a fresh V2 preference never auto-cuts over an existing legacy source", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-v2-only-existing-legacy-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const legacy = await createLegacyConversationStore(databasePath);
  (legacy as unknown as { db: DatabaseSync }).db.close();

  // A fresh-storage preference never cuts over an existing legacy source;
  // explicitly require legacy mode because this is a migration fixture.
  const reopened = await createConversationStore(databasePath, {
    freshStorageMode: "v2_only",
    requiredStorageMode: "legacy_compat",
  });
  assert.equal(reopened.getConversationStorageMode(), "legacy_compat");
});

test("a V2-only runtime refuses to open an existing legacy source", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-v2-only-required-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const legacy = await createLegacyConversationStore(databasePath);
  (legacy as unknown as { db: DatabaseSync }).db.close();

  await assert.rejects(
    createConversationStore(databasePath, {
      freshStorageMode: "v2_only",
      requiredStorageMode: "v2_only",
    }),
    (error: unknown) =>
      error instanceof ConversationV2Error && error.code === CONVERSATION_V2_ERROR.migrationIncomplete,
  );
});

test("cutover migrates pending plans from an older schema without optional columns", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-pending-plan-old-schema-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createLegacyConversationStore(databasePath);
  const threadId = "thr_pending_plan_old_schema";
  const now = "2026-01-01T00:00:00.000Z";
  store.saveThread({
    id: threadId,
    title: "Old pending plan schema",
    prompt: "hello",
    workspacePath: path.join(directory, "project"),
    status: "awaiting_plan",
    message: "",
    createdAt: now,
    updatedAt: now,
  });

  const rawDb = (store as unknown as { db: DatabaseSync }).db;
  rawDb.exec(`DROP TABLE thread_pending_plans`);
  rawDb.exec(`
    CREATE TABLE thread_pending_plans (
      thread_id TEXT PRIMARY KEY,
      user_prompt TEXT NOT NULL,
      analysis TEXT NOT NULL,
      plan TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      routes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  rawDb
    .prepare(
      `INSERT INTO thread_pending_plans
         (thread_id, user_prompt, analysis, plan, workspace_path, worktree_path, routes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      threadId,
      "hello",
      "legacy analysis",
      "1. keep it",
      path.join(directory, "project"),
      path.join(directory, "project"),
      "[]",
      now,
    );

  store.switchToV2OnlyStorage();
  assert.deepEqual(store.getPendingPlan(threadId), {
    threadId,
    userPrompt: "hello",
    analysis: "legacy analysis",
    plan: "1. keep it",
    workspacePath: path.join(directory, "project"),
    worktreePath: path.join(directory, "project"),
    routesJson: "[]",
  });
  const table = rawDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_pending_plans'`)
    .get();
  assert.equal(table, undefined);
  t.after(() => rawDb.close());
});

test("Node SQLite enforces the V2-only storage boundary after an atomic cutover", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-v2-only-cutover-");
  const databasePath = path.join(directory, "eco-coding.sqlite");
  const store = await createLegacyConversationStore(databasePath);
  const threadId = "thr_v2_only_cutover";
  store.saveThread({
    id: threadId,
    title: "V2-only cutover",
    prompt: "hello",
    workspacePath: path.join(directory, "project"),
    status: "idle",
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.savePendingPlan({
    threadId,
    userPrompt: "hello",
    analysis: "The request is ready.",
    plan: "1. Keep the durable plan",
    workspacePath: path.join(directory, "project"),
    worktreePath: path.join(directory, "project"),
    routesJson: "[]",
    planFilePath: path.join(directory, "plan.md"),
    deferredExitPlanToolUseId: "tool_exit_v2",
  });
  store.appendConversationRuntimeEvent({
    id: "native_v2_prompt",
    threadId,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamState: "none",
    message: "hello",
    observedAt: "2026-01-01T00:00:01.000Z",
    metadata: { liveType: "thread.user_prompt" },
  });
  const queuedFollowUp = store.enqueueThreadFollowUp({
    threadId,
    prompt: "保留到 V2 队列",
    priority: "escalated",
    deliveryMode: "interrupt_resume",
    queuedDuringPhase: "execution",
  });

  store.conversationV2().saveFeedSkeletonRow({
    conversationId: threadId,
    historyRevision: 0,
    maxEventSequence: 1,
    snapshotJson: "{}",
    auxiliaryJson: null,
    updatedAt: "2026-01-01T00:00:01.500Z",
  });

  assert.equal(store.getConversationStorageMode(), "legacy_compat");
  store.switchToV2OnlyStorage();
  assert.equal(store.getConversationStorageMode(), "v2_only");
  const migratedPendingPlan = store.getPendingPlan(threadId);
  assert.ok(migratedPendingPlan);
  assert.deepEqual(
    { ...migratedPendingPlan, createdAt: undefined },
    {
      threadId,
      userPrompt: "hello",
      analysis: "The request is ready.",
      plan: "1. Keep the durable plan",
      workspacePath: path.join(directory, "project"),
      worktreePath: path.join(directory, "project"),
      routesJson: "[]",
      planFilePath: path.join(directory, "plan.md"),
      deferredExitPlanToolUseId: "tool_exit_v2",
      createdAt: undefined,
    },
  );
  const v2MigratedPendingPlan = store.conversationV2().getPendingPlan(threadId);
  assert.ok(v2MigratedPendingPlan);
  assert.equal(typeof v2MigratedPendingPlan.createdAt, "string");
  assert.deepEqual(store.getThreadFollowUp(threadId, queuedFollowUp.id), queuedFollowUp);
  const migratedFollowUpInspection = new DatabaseSync(databasePath, { readOnly: true });
  const migratedFollowUpCount = migratedFollowUpInspection
    .prepare(`SELECT COUNT(*) AS count FROM conversation_followups_v2 WHERE thread_id = ?`)
    .get(threadId) as { count: number };
  const retiredSkeletonCount = migratedFollowUpInspection
    .prepare(`SELECT COUNT(*) AS count FROM conversation_feed_skeletons_v2 WHERE conversation_id = ?`)
    .get(threadId) as { count: number };
  migratedFollowUpInspection.close();
  assert.equal(migratedFollowUpCount.count, 1);
  assert.equal(retiredSkeletonCount.count, 0);
  assert.deepEqual(store.listActivityLines(threadId), [
    { id: "native_v2_prompt", role: "user", message: "hello", stream: false },
  ]);
  assert.deepEqual(store.listThreadRunEvents(threadId), []);
  const v2UserMessages = store.listUserMessageRecords(threadId);
  assert.equal(v2UserMessages.length, 1);
  assert.equal(v2UserMessages[0]?.text, "hello");
  assert.deepEqual(store.listSubagentSessions(threadId), []);
  assert.deepEqual(store.listSubagentMetrics(threadId), []);
  assert.equal(store.getThreadMetrics(threadId), undefined);
  assert.deepEqual(store.listUsageLedgerEvents(threadId), []);
  assert.equal(store.getThreadFeedSkeleton(threadId), undefined);
  // A provider receipt produced by an older adapter may still carry the
  // compatibility marker. After cutover that marker must not reopen any
  // retired V1 mirror query (the tables are physically gone).
  store.appendConversationRuntimeEvent({
    id: "native_v2_marker",
    threadId,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamState: "none",
    message: "",
    observedAt: "2026-01-01T00:00:02.500Z",
    metadata: { liveType: "runtime.marker" },
  });
  const rawDb = (store as unknown as { db: DatabaseSync }).db;
  // Recreating a retired table must not turn a V2-only command into a V1 write.
  // This simulates a damaged/partially restored database while keeping the
  // authoritative V2 stream intact.
  rawDb.exec(`
    CREATE TABLE thread_activity (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
    CREATE TABLE thread_usage_ledger_events (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
    CREATE TABLE thread_pending_followups (attachments_json TEXT);
    CREATE TABLE thread_subagent_sessions (thread_id TEXT NOT NULL);
  `);
  rawDb
    .prepare(`INSERT INTO thread_activity (id, thread_id) VALUES (?, ?)`)
    .run("legacy_row_after_cutover", threadId);
  rawDb
    .prepare(`INSERT INTO thread_usage_ledger_events (id, thread_id) VALUES (?, ?)`)
    .run("legacy_usage_after_cutover", threadId);
  const legacyFollowUpRef = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  rawDb
    .prepare(`INSERT INTO thread_pending_followups (attachments_json) VALUES (?)`)
    .run(JSON.stringify({ contentRef: legacyFollowUpRef }));
  rawDb.prepare(`INSERT INTO thread_subagent_sessions (thread_id) VALUES (?)`).run(threadId);
  assert.equal((await store.listReferencedPromptImageContentRefs()).has(legacyFollowUpRef), false);
  store.clearUsageLedger(threadId);
  const legacyRowsAfterV2Clear = rawDb
    .prepare(`SELECT COUNT(*) AS count FROM thread_usage_ledger_events WHERE thread_id = ?`)
    .get(threadId) as { count: number };
  assert.equal(legacyRowsAfterV2Clear.count, 1);
  store.saveSdkSession(threadId, "sdk_v2_only_compaction_probe", path.join(directory, "project"));
  store.commitCompactHandoffAndClearSession(threadId, {
    sourceSessionId: "sdk_v2_only_compaction_probe",
    sourceStartMessageId: "compact_start",
    sourceEndMessageId: "compact_end",
    summary: "V2-only compaction probe",
    recentMessages: [{ role: "user", message: "recent" }],
    preTokensEstimate: 100,
    preTokensSource: "sdk_context_usage",
    postTokensEstimate: 20,
    postTokensSource: "local_heuristic",
    compressionRatio: 0.2,
  });
  const legacyRowsAfterV2Compaction = rawDb
    .prepare(`SELECT COUNT(*) AS count FROM thread_subagent_sessions WHERE thread_id = ?`)
    .get(threadId) as { count: number };
  assert.equal(legacyRowsAfterV2Compaction.count, 1);
  const deleteProbeThreadId = "thr_v2_only_delete_probe";
  store.saveThread({
    id: deleteProbeThreadId,
    title: "V2-only delete probe",
    prompt: "probe",
    workspacePath: path.join(directory, "project"),
    status: "idle",
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  rawDb
    .prepare(`INSERT INTO thread_activity (id, thread_id) VALUES (?, ?)`)
    .run("legacy_delete_probe", deleteProbeThreadId);
  assert.equal(store.deleteThread(deleteProbeThreadId), true);
  const legacyRowsAfterV2Delete = rawDb
    .prepare(`SELECT COUNT(*) AS count FROM thread_activity WHERE thread_id = ?`)
    .get(deleteProbeThreadId) as { count: number };
  assert.equal(legacyRowsAfterV2Delete.count, 1);
  const deleteCommandProbeThreadId = "thr_v2_only_delete_command_probe";
  store.saveThread({
    id: deleteCommandProbeThreadId,
    title: "V2-only delete command probe",
    prompt: "probe",
    workspacePath: path.join(directory, "project"),
    status: "idle",
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.conversationV2().ensureConversation(deleteCommandProbeThreadId);
  rawDb
    .prepare(`INSERT INTO thread_activity (id, thread_id) VALUES (?, ?)`)
    .run("legacy_delete_command_probe", deleteCommandProbeThreadId);
  const deleteCommand = {
    principalId: "principal_v2_only_delete_probe",
    threadId: deleteCommandProbeThreadId,
    clientCommandId: "delete_command_v2_only_probe",
    expectedHistoryRevision: 0,
  };
  assert.equal(store.acceptThreadDeleteCommand(deleteCommand).status, "accepted");
  assert.equal(store.completeThreadDeleteCommand(deleteCommand).status, "completed");
  const legacyRowsAfterV2DeleteCommand = rawDb
    .prepare(`SELECT COUNT(*) AS count FROM thread_activity WHERE thread_id = ?`)
    .get(deleteCommandProbeThreadId) as { count: number };
  assert.equal(legacyRowsAfterV2DeleteCommand.count, 1);
  rawDb.exec(
    `DROP TABLE thread_activity; DROP TABLE thread_usage_ledger_events; DROP TABLE thread_pending_followups; DROP TABLE thread_subagent_sessions;`,
  );
  const providerSource = rawDb
    .prepare(
      `SELECT source_json FROM conversation_provider_inputs_v2 WHERE conversation_id = ? AND input_id = ?`,
    )
    .get(threadId, "native_v2_marker") as { source_json: string } | undefined;
  assert.ok(providerSource);
  if (!providerSource) throw new Error("expected V2 provider source marker");
  const markedSource = JSON.parse(providerSource.source_json) as Record<string, unknown>;
  markedSource.metadata = {
    ...((markedSource.metadata as Record<string, unknown> | undefined) ?? {}),
    legacyCompat: true,
  };
  rawDb
    .prepare(
      `UPDATE conversation_provider_inputs_v2 SET source_json = ? WHERE conversation_id = ? AND input_id = ?`,
    )
    .run(JSON.stringify(markedSource), threadId, "native_v2_marker");
  assert.doesNotThrow(() => store.bindLatestUserRunEventToSdkMessage(threadId, "user-after-cutover"));
  assert.doesNotThrow(() =>
    store.rebindClaudeUserMessageRecords(threadId, [
      { activityLineId: "sdk:user-after-cutover", upstreamMessageId: "upstream-after-cutover" },
    ]),
  );
  // V2-only must also reject accidental writes from transitional maintenance
  // helpers, otherwise a second skeleton read model can silently reappear.
  store.saveThreadFeedSkeleton(threadId, undefined as never);
  store.touchThreadFeedSkeletonSequence(threadId, 99);
  store.deleteThreadFeedSkeleton(threadId);
  const skeletonInspection = new DatabaseSync(databasePath, { readOnly: true });
  const skeletonRows = skeletonInspection
    .prepare(`SELECT COUNT(*) AS count FROM conversation_feed_skeletons_v2 WHERE conversation_id = ?`)
    .get(threadId) as { count: number };
  skeletonInspection.close();
  assert.equal(skeletonRows.count, 0);
  assert.equal(store.getThreadRunEventMaxSequence(threadId), 5);
  assert.throws(
    () =>
      store.appendThreadRunEvent({
        id: "legacy_after_cutover",
        threadId,
        eventType: "message.final",
        scope: "main",
        role: "assistant",
        streamState: "finalized",
        message: "must fail",
        observedAt: "2026-01-01T00:00:02.000Z",
      }),
    /Legacy thread run event writes are disabled after the V2 storage cutover/,
  );
  assert.throws(
    () => store.appendActivityLine(threadId, { role: "assistant", message: "must fail" }),
    /Legacy activity-line writes are disabled after the V2 storage cutover/,
  );
  store.saveUserMessageRecord({
    threadId,
    activityLineId: "legacy_user_after_cutover",
    text: "must not recreate V1",
    provider: "claude",
  });
  store.saveThreadMetrics(threadId, {
    context: { occupied: 1, limit: 100, occupancyPct: 1, limitsResolved: true, segments: [], updatedAt: 2 },
  });
  store.clearSubagentSessions(threadId);
  store.clearSubagentMetrics(threadId);
  const rewrite = store.rewindThreadToActivityLine(threadId, "native_v2_prompt");
  assert.equal(rewrite.cutoffRunSequence, 2);
  assert.equal(rewrite.removedActivityCount, 0);
  assert.equal(rewrite.removedRunEventCount, 0);
  const durableImageRef = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
  store.conversationV2().append({
    conversationId: threadId,
    eventId: "v2_image_message",
    sourceEventKey: "v2_image_message",
    type: "message.created",
    occurredAt: "2026-01-01T00:00:03.000Z",
    turnId: "turn_image",
    messageId: "message_image",
    payload: {
      role: "user",
      channel: "answer",
      body: "图片",
      status: "final",
      historyTarget: { activityLineId: "image:1" },
      attachments: [{ mediaType: "image/png", contentRef: durableImageRef, byteLength: 3 }],
    },
  });
  assert.equal((await store.listReferencedPromptImageContentRefs()).has(durableImageRef), true);

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  const retired = inspection
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('thread_activity', 'thread_agent_instances', 'thread_coder_todos',
                      'thread_run_events', 'thread_user_messages', 'thread_feed_skeleton',
                      'thread_metrics_snapshots', 'thread_usage_ledger_events',
                      'thread_subagent_sessions', 'thread_subagent_metrics',
                      'thread_run_attempts', 'thread_pending_followups', 'thread_pending_plans')
       ORDER BY name`,
    )
    .all();
  assert.deepEqual(retired, []);
  assert.equal(
    (
      inspection
        .prepare(`SELECT value FROM conversation_store_meta_v2 WHERE key = 'conversation_v2_storage_mode'`)
        .get() as { value: string }
    ).value,
    "v2_only",
  );
  const v2FollowUpCount = inspection
    .prepare(`SELECT COUNT(*) AS count FROM conversation_followups_v2 WHERE thread_id = ?`)
    .get(threadId) as { count: number };
  assert.equal(v2FollowUpCount.count, 0);
  inspection.close();

  (store as unknown as { db: DatabaseSync }).db.close();
  const staleSkeletonSeed = new DatabaseSync(databasePath);
  staleSkeletonSeed
    .prepare(
      `INSERT INTO conversation_feed_skeletons_v2
         (conversation_id, history_revision, max_event_sequence, snapshot_json, auxiliary_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(threadId, 0, 1, "{}", null, "2026-01-01T00:00:04.000Z");
  staleSkeletonSeed.close();
  const reopened = await createConversationStore(databasePath);
  t.after(() => (reopened as unknown as { db: DatabaseSync }).db.close());
  assert.equal(reopened.getConversationStorageMode(), "v2_only");
  assert.deepEqual(reopened.listActivityLines(threadId), []);
  const reopenedInspection = new DatabaseSync(databasePath, { readOnly: true });
  const retiredAfterReopen = reopenedInspection
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('thread_activity', 'thread_agent_instances', 'thread_coder_todos',
                      'thread_run_events', 'thread_user_messages', 'thread_feed_skeleton',
                      'thread_metrics_snapshots', 'thread_usage_ledger_events',
                      'thread_subagent_sessions', 'thread_subagent_metrics',
                      'thread_run_attempts', 'thread_pending_followups', 'thread_pending_plans')
       ORDER BY name`,
    )
    .all();
  assert.deepEqual(retiredAfterReopen, []);
  const retiredSkeletonAfterReopen = reopenedInspection
    .prepare(`SELECT COUNT(*) AS count FROM conversation_feed_skeletons_v2 WHERE conversation_id = ?`)
    .get(threadId) as { count: number };
  assert.equal(retiredSkeletonAfterReopen.count, 0);
  reopenedInspection.close();
  assert.equal(reopened.getThreadFollowUp(threadId, queuedFollowUp.id), undefined);
  assert.equal(reopened.deleteThread(threadId), true);
});

test("prompt image references are collected from the first payload row of a source table", async (t) => {
  const directory = await createTestDirectory(t, "eco-node-prompt-image-refs-");
  const store = await createConversationStore(path.join(directory, "eco-coding.sqlite"));
  const threadId = "thr_prompt_image_first_row";
  const durableRef = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  store.conversationV2().append({
    conversationId: threadId,
    eventId: "v2_first_row_image",
    sourceEventKey: "v2_first_row_image",
    type: "message.created",
    occurredAt: "2026-01-01T00:00:00.000Z",
    turnId: "turn_image",
    messageId: "message_image",
    payload: {
      role: "user",
      channel: "answer",
      body: "图片",
      status: "final",
      historyTarget: { activityLineId: "image:1" },
      attachments: [{ mediaType: "image/png", contentRef: durableRef, byteLength: 3 }],
    },
  });
  const refs = await store.listReferencedPromptImageContentRefs();
  assert.equal(refs.has(durableRef), true);
  assert.deepEqual([...refs], [durableRef]);
});
