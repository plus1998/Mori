import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { removeTempDirectorySync } from "./helpers/temp-directory";
import { ConversationStore } from "../src/main/conversation-store";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
} from "../src/renderer/conversation-v2-renderer-state";
import { corpusBootstrap, loadCorpus, WHOLE_CONVERSATION_MAX_BYTES } from "./support/v2-corpus";

const projectionExtraFields = "requestSpans billing ledgerEvents context subagentTimings subagentMetrics";

// Explicit inventory: adding a wire field requires deciding how it survives each consumer.
const fields = {
  ConversationDetailItem:
    "itemId conversationId runId agentId agentInstanceId parentAgentInstanceId parentAgentId parentToolCallId toolCallId type createdSeq versionSeq content ref",
  ConversationSendMessageResult:
    "protocolVersion conversationId clientCommandId messageId turnId acceptedSeq status",
  ConversationMessage:
    "messageId conversationId turnId runId role channel createdSeq versionSeq contentVersion body origin attachments agentId agentInstanceId occurredAt historyTarget providerRole status isDeleted",
  ConversationRun:
    "runId conversationId turnId status startedAt endedAt versionSeq timingQuality retryOfRunId regenerationOfRunId",
  ConversationToolCall:
    "toolCallId conversationId runId agentId agentInstanceId parentAgentInstanceId parentToolCallId name status createdSeq versionSeq occurredAt providerRole input output",
  ConversationAgent:
    "agentId conversationId role kind status runId parentAgentInstanceId parentToolCallId startedAt endedAt mission taskName delegationSummary delegationPrompt todoId versionSeq",
};

test("scheduled message provenance survives replay and rebuild without changing provider text", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    const origin = { kind: "scheduled_message" as const, scheduleId: "schedule-hi", name: "hi" };
    const input = { principalId: "eco-scheduler", conversationId: "scheduled-origin", clientCommandId: "occ-hi",
      text: "[定时消息：用户正文里的文字]\n请检查日志。", origin };
    const receipt = store.sendMessage(input);
    store.appendRuntime({ conversationId: input.conversationId, eventId: "scheduled-final", type: "message.finalized",
      occurredAt: "2026-10-08T00:00:00Z", messageId: receipt.messageId, payload: { status: "final" } });
    const bootstrap = store.bootstrap(input.conversationId);
    const empty = installConversationV2Bootstrap({ ...bootstrap, snapshotSeq: 0, messages: [], turns: [] });
    const effects = store.sync(input.conversationId, bootstrap.storeEpoch, 0).effects;
    const replay = applyConversationV2Effects(empty, effects);
    const message = replay.messages.get(receipt.messageId);
    expect(message?.body).toBe(input.text);
    expect(message?.origin).toEqual(origin);
    const projected = buildConversationV2OnlyProjection(replay).timeline.find(item => item.role === "user");
    expect(projected?.text).toBe(input.text);
    expect(projected?.metadata?.messageOrigin).toEqual(origin);
    expect(() => store.sendMessage({ ...input, origin: { ...origin, name: "changed" } })).toThrow("different request");
    const reopened = new ConversationV2Store(db);
    reopened.initialize();
    reopened.rebuildReadModels(input.conversationId);
    expect(reopened.getMessage(input.conversationId, receipt.messageId)).toEqual(message);
    expect(reopened.sendMessage(input)).toEqual(receipt);
  } finally {
    db.close();
  }
});

test("detail fields survive durable effects, renderer replay and read-model rebuild", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    store.append({
      conversationId: "detail-fields",
      eventId: "detail-event",
      type: "detail.upserted",
      occurredAt: "2026-09-17T00:00:00.000Z",
      runId: "run",
      agentId: "agent",
      agentInstanceId: "instance",
      parentAgentInstanceId: "parent-instance",
      parentAgentId: "parent-agent",
      parentToolCallId: "parent-tool",
      toolCallId: "tool",
      payload: { itemId: "item", detailType: "tool.output", content: "", ref: "ref" },
    });
    const expected = {
      itemId: "item",
      conversationId: "detail-fields",
      runId: "run",
      agentId: "agent",
      agentInstanceId: "instance",
      parentAgentInstanceId: "parent-instance",
      parentAgentId: "parent-agent",
      parentToolCallId: "parent-tool",
      toolCallId: "tool",
      type: "tool.output",
      createdSeq: 1,
      versionSeq: 1,
      content: "",
      ref: "ref",
    };
    expect(store.detailsPage("detail-fields", "run").items).toEqual([expected]);
    const bootstrap = store.bootstrap("detail-fields");
    const empty = installConversationV2Bootstrap({ ...bootstrap, snapshotSeq: 0 });
    const replay = applyConversationV2Effects(
      empty,
      store.sync("detail-fields", bootstrap.storeEpoch, 0).effects,
    );
    expect(replay.details.get("item")).toEqual(expected);
    store.rebuildReadModels("detail-fields");
    expect(store.getDetail("detail-fields", "item")).toEqual(expected);
  } finally {
    db.close();
  }
});

test("persisted command receipts survive disk reopen and rebuild without accepting twice", () => {
  const directory = mkdtempSync(join(tmpdir(), "eco-conversation-v2-receipt-"));
  const databasePath = join(directory, "conversation.sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(databasePath);
    const firstStore = new ConversationV2Store(db);
    firstStore.initialize();
    const input = {
      principalId: "user",
      conversationId: "receipt-fields",
      clientCommandId: "command",
      text: "hello",
    };
    const first = firstStore.sendMessage(input);
    db.close();
    db = new DatabaseSync(databasePath);
    const reopened = new ConversationV2Store(db);
    reopened.initialize();
    reopened.rebuildReadModels("receipt-fields");
    expect(reopened.sendMessage(input)).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(fields.ConversationSendMessageResult.split(" ").sort());
    expect(reopened.head("receipt-fields").lastSeq).toBe(first.acceptedSeq);
    expect(reopened.bootstrap("receipt-fields").messages).toHaveLength(1);

    db.prepare(
      `UPDATE conversation_command_receipts_v2 SET result_json = ?
       WHERE conversation_id = ? AND client_command_id = ?`,
    ).run("{}", input.conversationId, input.clientCommandId);
    expect(() => reopened.sendMessage(input)).toThrow("receipt");
    expect(reopened.head("receipt-fields").lastSeq).toBe(first.acceptedSeq);
    expect(reopened.bootstrap("receipt-fields").messages).toHaveLength(1);
  } finally {
    db?.close();
    removeTempDirectorySync(directory);
  }
});

test("accepted command receipts survive SIGKILL without a graceful database close", async () => {
  const directory = mkdtempSync(join(tmpdir(), "eco-conversation-v2-sigkill-"));
  const databasePath = join(directory, "conversation.sqlite");
  const workerPath = fileURLToPath(new URL("./support/conversation-v2-crash-worker.ts", import.meta.url));
  const worker = Bun.spawn([process.execPath, workerPath, databasePath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let db: DatabaseSync | undefined;
  try {
    const reader = worker.stdout.getReader();
    const firstChunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Crash worker did not publish its receipt.")), 5_000),
      ),
    ]);
    expect(firstChunk.done).toBe(false);
    const first = JSON.parse(new TextDecoder().decode(firstChunk.value).trim()) as {
      protocolVersion: number;
      conversationId: string;
      clientCommandId: string;
      messageId: string;
      turnId: string;
      acceptedSeq: number;
      status: string;
    };

    worker.kill("SIGKILL");
    expect(await worker.exited).not.toBe(0);

    db = new DatabaseSync(databasePath);
    const recovered = new ConversationV2Store(db);
    recovered.initialize();
    recovered.rebuildReadModels("receipt-crash");
    expect(
      recovered.sendMessage({
        principalId: "user",
        conversationId: "receipt-crash",
        clientCommandId: "command",
        text: "survive SIGKILL",
      }),
    ).toEqual(first);
    expect(recovered.head("receipt-crash").lastSeq).toBe(first.acceptedSeq);
    expect(recovered.bootstrap("receipt-crash").messages).toHaveLength(1);
  } finally {
    worker.kill("SIGKILL");
    await worker.exited;
    db?.close();
    removeTempDirectorySync(directory);
  }
}, 10_000);

test("V2 projection extras round-trip every stored panel fact after reopen", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    store.ensureConversation("projection-extra-fields");
    const snapshot = {
      requestSpans: [
        {
          requestId: "request-1",
          ownerAgentId: "agent-1",
          role: "coder",
          source: "sdk",
          status: "completed",
          startedAt: "2026-09-17T00:00:00.000Z",
          firstTokenAt: "2026-09-17T00:00:00.010Z",
          endedAt: "2026-09-17T00:00:00.100Z",
          providerRequestId: "provider-1",
          outputTokens: 8,
          reasoningTokens: 2,
          ttftMs: 10,
          generationMs: 90,
          firstHeadersMs: 4,
          firstTokenMs: 10,
          inputTokens: 13,
          cacheReadTokens: 3,
        },
      ],
      // Ledger events are derived from the V2 usage ledger at the IPC boundary;
      // keep the empty wire field in the snapshot inventory so it cannot vanish.
      ledgerEvents: [],
      billing: {
        totalTokens: { input: 13, output: 8, cacheRead: 3, cacheCreation: 1 },
        sourceReportedCostUsd: 0.12,
        plannerTokenCostUsd: 0.04,
        ecoCostUsd: 0.08,
        savedUsd: 0.01,
        savedPct: 11.11,
        pricingResolved: true,
        primarySource: "sdk",
        displaySource: "sdk",
      },
      context: {
        occupied: 42,
        limit: 100,
        occupancyPct: 42,
        limitsResolved: true,
        displayRole: "coder",
        modelId: "claude-test",
        segments: [{ key: "conversation", label: "会话", tokens: 42, color: "#ea580c" }],
        updatedAt: 123,
      },
      subagentTimings: [
        {
          agentId: "agent-1",
          role: "coder",
          phase: "execution",
          status: "stopped",
          startedAt: "2026-09-17T00:00:00.000Z",
          lastActiveAt: "2026-09-17T00:00:00.050Z",
          endedAt: "2026-09-17T00:00:00.100Z",
          accumulatedMs: 50,
          durationMs: 100,
        },
      ],
      subagentMetrics: [
        {
          agentId: "agent-1",
          role: "coder",
          status: "stopped",
          inputTokens: 13,
          outputTokens: 8,
          cacheReadTokens: 3,
          cacheCreationTokens: 1,
          contextOccupied: 42,
          contextLimit: 100,
          ecoCostUsd: 0.08,
          modelId: "claude-test",
          lastRequestKey: "request-1",
        },
      ],
    };
    store.saveProjectionSnapshot("projection-extra-fields", snapshot);
    expect(store.getProjectionSnapshot("projection-extra-fields")).toEqual(snapshot);

    const reopened = new ConversationV2Store(db);
    reopened.initialize();
    expect(reopened.getProjectionSnapshot("projection-extra-fields")).toEqual(snapshot);
  } finally {
    db.close();
  }
});

test("ConversationStore exposes all mutable V2 projection extras without legacy hydration", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationStore(db);
    store.initialize();
    store.saveThread({
      id: "projection-extra-boundary",
      title: "Projection extras",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "ok",
      createdAt: "2026-09-17T00:00:00.000Z",
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
    const billing = {
      totalTokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      sourceReportedCostUsd: 0.1,
      plannerTokenCostUsd: 0.05,
      ecoCostUsd: 0.06,
      savedUsd: 0.01,
      savedPct: 10,
      pricingResolved: true,
    };
    const context = {
      occupied: 12,
      limit: 100,
      occupancyPct: 12,
      limitsResolved: true,
      segments: [{ key: "conversation", label: "会话", tokens: 12, color: "#ea580c" }],
      updatedAt: 456,
    };
    const subagentTimings = [
      {
        agentId: "agent-boundary",
        role: "coder" as const,
        status: "active" as const,
        startedAt: "2026-09-17T00:00:00.000Z",
        lastActiveAt: "2026-09-17T00:00:00.010Z",
        accumulatedMs: 10,
        durationMs: 10,
      },
    ];
    const subagentMetrics = [
      {
        agentId: "agent-boundary",
        role: "coder" as const,
        status: "active" as const,
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 4,
        contextOccupied: 12,
        ecoCostUsd: 0.06,
      },
    ];
    store.updateConversationV2ProjectionExtras("projection-extra-boundary", {
      billing,
      context,
      subagentTimings,
      subagentMetrics,
    });
    expect(store.getConversationV2ProjectionExtras("projection-extra-boundary")).toMatchObject({
      requestSpans: [],
      billing,
      context,
      subagentTimings,
      subagentMetrics,
      ledgerEvents: [],
    });
  } finally {
    db.close();
  }
});

test("V2 append fails closed on SQLite SQLITE_FULL and leaves the cursor unchanged", () => {
  const directory = mkdtempSync(join(tmpdir(), "eco-conversation-v2-sqlite-full-"));
  const databasePath = join(directory, "conversation.sqlite");
  const db = new DatabaseSync(databasePath);
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    store.ensureConversation("sqlite-full");
    db.exec("VACUUM");
    const pageSize = Number((db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size);
    const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
    const freelistCount = Number(
      (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count,
    );
    expect(pageSize).toBeGreaterThan(0);
    expect(pageCount).toBeGreaterThan(0);
    expect(freelistCount).toBe(0);
    db.exec(`PRAGMA max_page_count = ${pageCount}`);

    expect(() =>
      store.append({
        conversationId: "sqlite-full",
        eventId: "sqlite-full-event",
        type: "message.created",
        occurredAt: "2026-09-17T00:00:00.000Z",
        turnId: "sqlite-full-turn",
        messageId: "sqlite-full-message",
        payload: { role: "assistant", body: "x".repeat(pageSize * 4) },
      }),
    ).toThrow(/full|disk/i);

    const stream = db
      .prepare(`SELECT last_seq FROM conversation_streams_v2 WHERE conversation_id = ?`)
      .get("sqlite-full") as { last_seq: number };
    assert.equal(stream.last_seq, 0);
    assert.equal(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM conversation_events_v2 WHERE conversation_id = ?`)
          .get("sqlite-full") as { count: number }
      ).count,
      0,
    );
    assert.equal(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM conversation_sync_effects_v2 WHERE conversation_id = ?`)
          .get("sqlite-full") as { count: number }
      ).count,
      0,
    );
    expect(store.head("sqlite-full").lastSeq).toBe(0);
  } finally {
    db.close();
    removeTempDirectorySync(directory);
  }
});

test("agent lifecycle effects conserve the complete registry without bootstrap refresh", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    const ownership = {
      conversationId: "agent-fields",
      agentInstanceId: "instance",
      runId: "run",
      parentAgentInstanceId: "parent",
      parentToolCallId: "parent-tool",
    };
    store.append({
      ...ownership,
      eventId: "start",
      type: "agent.started",
      occurredAt: "2026-09-17T00:00:00.000Z",
      payload: {
        role: "subagent",
        kind: "worker",
        mission: "",
        taskName: "task",
        delegationSummary: "summary",
        delegationPrompt: "prompt",
        todoId: "todo",
      },
    });
    store.append({
      ...ownership,
      eventId: "complete",
      type: "agent.completed",
      occurredAt: "2026-09-17T00:00:01.000Z",
    });
    const bootstrap = store.bootstrap("agent-fields");
    const empty = installConversationV2Bootstrap({ ...bootstrap, snapshotSeq: 0, agents: [] });
    const effects = store.sync("agent-fields", bootstrap.storeEpoch, 0).effects;
    expect(effects.map((row) => row.effect.type)).toEqual(["agent.upsert", "agent.upsert"]);
    const replay = applyConversationV2Effects(empty, effects);
    const expected = {
      agentId: "instance",
      conversationId: "agent-fields",
      role: "subagent",
      kind: "worker",
      status: "completed",
      runId: "run",
      parentAgentInstanceId: "parent",
      parentToolCallId: "parent-tool",
      startedAt: "2026-09-17T00:00:00.000Z",
      endedAt: "2026-09-17T00:00:01.000Z",
      mission: "",
      taskName: "task",
      delegationSummary: "summary",
      delegationPrompt: "prompt",
      todoId: "todo",
      versionSeq: 2,
    };
    expect([...replay.agents.values()]).toEqual([expected]);
    expect(bootstrap.agents).toEqual([expected]);
    expect(applyConversationV2Effects(replay, effects).agents).toEqual(replay.agents);
    const projected = buildConversationV2OnlyProjection(replay, {
      createdAt: "2026-09-17T00:00:00.000Z",
      status: "completed",
    }).agents[0];
    expect(
      projected && {
        agentId: projected.agentId,
        role: projected.role,
        kind: projected.kind,
        status: projected.status,
        startedAt: projected.startedAt,
        endedAt: projected.endedAt,
        durationMs: projected.durationMs,
        mission: projected.mission,
        taskName: projected.taskName,
        delegationSummary: projected.delegationSummary,
        delegationPrompt: projected.delegationPrompt,
        todoId: projected.todoId,
        parentAgentId: projected.parentAgentId,
        parentToolUseId: projected.parentToolUseId,
        runAttemptId: projected.runAttemptId,
      },
    ).toEqual({
      agentId: "instance",
      role: "subagent",
      kind: "subagent",
      status: "stopped",
      startedAt: "2026-09-17T00:00:00.000Z",
      endedAt: "2026-09-17T00:00:01.000Z",
      durationMs: 1_000,
      mission: "",
      taskName: "task",
      delegationSummary: "summary",
      delegationPrompt: "prompt",
      todoId: "todo",
      parentAgentId: "parent",
      parentToolUseId: "parent-tool",
      runAttemptId: "run",
    });
    store.rebuildReadModels("agent-fields");
    expect(store.agentsOf("agent-fields")).toEqual([expected]);
    expect(() =>
      store.append({
        ...ownership,
        runId: "other",
        eventId: "bad-owner",
        type: "agent.completed",
        occurredAt: "2026-09-17T00:00:02.000Z",
      }),
    ).toThrow();
    expect(store.head("agent-fields").lastSeq).toBe(2);
  } finally {
    db.close();
  }
});

test("the conservation inventory names every shared entity field", () => {
  const source = ts.createSourceFile(
    "conversation-v2.ts",
    readFileSync(new URL("../../../packages/shared/src/conversation-v2.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const [name, inventory] of Object.entries(fields)) {
    const declaration = source.statements.find(
      (node) => ts.isInterfaceDeclaration(node) && node.name.text === name,
    );
    if (!declaration || !ts.isInterfaceDeclaration(declaration)) throw new Error(`Missing ${name}`);
    const names = declaration.members.map((member) => {
      if (!member.name) throw new Error(`Unnamed member in ${name}`);
      return member.name.getText(source);
    });
    expect(names.sort()).toEqual(inventory.split(" ").sort());
  }
});

test("the G-5 inventory names every V2 projection extra field", () => {
  const source = ts.createSourceFile(
    "ipc.ts",
    readFileSync(new URL("../src/shared/ipc.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "ConversationV2ProjectionExtras",
  );
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) {
    throw new Error("Missing ConversationV2ProjectionExtras");
  }
  const names = declaration.members.map((member) => {
    if (!member.name) throw new Error("Unnamed projection extra member");
    return member.name.getText(source);
  });
  expect(names.sort()).toEqual(projectionExtraFields.split(" ").sort());
});

for (const conversation of loadCorpus().conversations) {
  test(`${conversation.conversationId}: durable effects conserve every message, run, tool and agent field`, () => {
    const { v2, session } = corpusBootstrap(conversation);
    const id = conversation.conversationId;
    const empty = installConversationV2Bootstrap({
      protocolVersion: 2,
      storeEpoch: session.storeEpoch,
      conversationId: id,
      snapshotSeq: 0,
      historyRevision: 0,
      messages: [],
      turns: [],
      runs: [],
      tools: [],
      agents: [],
      hasOlder: false,
    });
    let replay = empty;
    while (replay.appliedSeq < session.appliedSeq) {
      const page = v2.sync(
        id,
        session.storeEpoch,
        replay.appliedSeq,
        session.appliedSeq,
        500,
        WHOLE_CONVERSATION_MAX_BYTES,
      );
      expect(page.effects.length).toBeGreaterThan(0);
      replay = applyConversationV2Effects(replay, page.effects);
    }
    const sorted = (map: ReadonlyMap<string, unknown>) =>
      [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
    expect(sorted(replay.messages)).toEqual(sorted(session.messages));
    expect(sorted(replay.runs)).toEqual(sorted(session.runs));
    expect(sorted(replay.tools)).toEqual(sorted(session.tools));
    expect(sorted(replay.agents)).toEqual(sorted(session.agents));
    v2.rebuildReadModels(id);
    for (const message of session.messages.values())
      expect(v2.getMessage(id, message.messageId)).toEqual(message);
    for (const run of session.runs.values()) expect(v2.getRun(id, run.runId)).toEqual(run);
    expect(v2.agentsOf(id)).toEqual(
      [...session.agents.values()].sort(
        (left, right) => left.versionSeq - right.versionSeq || left.agentId.localeCompare(right.agentId),
      ),
    );
  }, 60_000);
}
