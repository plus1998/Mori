import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CONVERSATION_V2_ERROR, ConversationV2Error, estimateConversationBytes } from "@eco/shared";
import { removeTempDirectorySync } from "./helpers/temp-directory";
import { appendLegacyThreadRunEventToConversationV2 } from "../src/main/conversation-v2-legacy-adapter";
import { ConversationV2Store } from "../src/main/conversation-v2-store";

function createStore(): { db: DatabaseSync; store: ConversationV2Store } {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db, {
    idFactory: (() => {
      let counter = 0;
      return () => `id_${++counter}`;
    })(),
    now: (() => {
      let counter = 0;
      return () => `2026-09-14T00:00:0${++counter}.000Z`;
    })(),
  });
  store.initialize();
  return { db, store };
}

function createProviderPatchStore() {
  const { db, store } = createStore();
  const conversationId = "thread_provider_patch_guard";
  store.appendRuntime({
    conversationId,
    eventId: "message",
    type: "message.created",
    occurredAt: "2026-10-21T00:00:00.000Z",
    messageId: "message",
    turnId: "turn",
    payload: { role: "user", body: "bind me" },
  });
  store.appendRuntime({
    conversationId,
    eventId: "receipt",
    type: "noop",
    occurredAt: "2026-10-21T00:00:01.000Z",
    messageId: "message",
    payload: {
      reason: "runtime.input",
      source: { id: "provider_input", threadId: conversationId },
      message: "bind me",
    },
  });
  const input = {
    conversationId,
    eventId: "patch",
    sourceEventKey: "provider:patch:guard",
    occurredAt: "2026-10-21T00:00:02.000Z",
    inputIds: ["provider_input"],
    patch: { metadataMerge: { rewindTarget: { activityLineId: "sdk:item", userMessageId: "item" } } },
    reason: "codex-bind",
  };
  return { db, store, input };
}

const providerPatchMethods = ["appendProviderInputPatch", "appendRuntimeProviderInputPatch"] as const;

describe("conversation storage V2", () => {
  test("hashes the persisted JSON snapshot and survives replay with optional SDK metadata", () => {
    const { db, store } = createStore();
    const input = {
      conversationId: "thread_json_snapshot",
      eventId: "sdk_notice",
      type: "noop" as const,
      occurredAt: "2026-10-12T06:10:12.033Z",
      payload: {
        reason: "snapshot.test",
        source: { metadata: { activityOrigin: "sdk.informational", level: "warning", tag: undefined } },
        items: [undefined, { absent: undefined, value: "kept" }],
      },
    };
    const first = store.append(input);
    expect(first.event.payload).toEqual(JSON.parse(JSON.stringify(input.payload)));
    expect(Object.hasOwn((first.event.payload.source as typeof input.payload.source).metadata, "tag")).toBe(
      false,
    );
    input.payload.source.metadata.level = "mutated after commit";
    expect((first.event.payload.source as typeof input.payload.source).metadata.level).toBe("warning");
    store.validateIntegrity(input.conversationId);
    const restarted = new ConversationV2Store(db);
    restarted.initialize();
    expect(
      restarted.append({
        ...input,
        payload: {
          ...input.payload,
          source: { metadata: { activityOrigin: "sdk.informational", level: "warning", tag: undefined } },
        },
      }).duplicate,
    ).toBe(true);
    restarted.rebuildReadModels(input.conversationId);
    expect(restarted.validateIntegrity(input.conversationId).headSeq).toBe(1);
    db.close();
  });

  test("rejects unserializable payloads atomically before persisting a hash", () => {
    const { db, store } = createStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const payload of [circular, { value: 1n }, { toJSON: () => "not an object" }]) {
      expect(() =>
        store.append({
          conversationId: "thread_json_invalid",
          eventId: "invalid_json",
          type: "noop",
          occurredAt: "2026-10-12T06:10:12.033Z",
          payload,
        }),
      ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_events_v2").get()).toEqual({ count: 0 });
    db.close();
  });

  test("replays the shared golden fixture into the same read model", () => {
    const fixturePath = fileURLToPath(
      new URL(
        "../../../scripts/conversation-round/fixtures/conversation-v2/basic-stream.json",
        import.meta.url,
      ),
    );
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      events: Array<Record<string, unknown>>;
      expected: {
        headSeq: number;
        messages: Array<Record<string, unknown>>;
        run: Record<string, unknown>;
      };
    };
    const { db, store } = createStore();
    for (const event of fixture.events) store.append(event as never);
    expect(store.head("fixture-conversation").lastSeq).toBe(fixture.expected.headSeq);
    expect(store.getMessage("fixture-conversation", "fixture-answer-message")).toMatchObject(
      fixture.expected.messages[1],
    );
    expect(store.getRun("fixture-conversation", "fixture-run-1")).toMatchObject(fixture.expected.run);
    db.close();
  });

  test("bootstrap applies maxBytes to the complete response, not only messages", () => {
    const { db, store } = createStore();
    for (let index = 1; index <= 8; index += 1) {
      store.append({
        conversationId: "thread_bootstrap_budget",
        eventId: `bootstrap_message_${index}`,
        type: "message.created",
        occurredAt: `2026-09-14T00:00:${String(index).padStart(2, "0")}.000Z`,
        turnId: `bootstrap_turn_${index}`,
        messageId: `bootstrap_message_${index}`,
        payload: { role: "assistant", body: `message ${index}` },
      });
    }

    const bootstrap = store.bootstrap("thread_bootstrap_budget", 30, 2_048);

    expect(estimateConversationBytes(bootstrap)).toBeLessThanOrEqual(2_048);
    expect(bootstrap.messages.length).toBeLessThan(8);
    expect(bootstrap.hasOlder).toBe(true);
    expect(bootstrap.olderCursor).toBeString();
    db.close();
  });

  test("bootstrap includes lightweight tool summaries for its runs", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_bootstrap_tools",
      eventId: "message_1",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: { role: "user", body: "inspect" },
    });
    store.append({
      conversationId: "thread_bootstrap_tools",
      eventId: "run_1",
      type: "run.started",
      occurredAt: "2026-09-14T00:00:02.000Z",
      turnId: "turn_1",
      runId: "run_1",
      payload: { status: "running" },
    });
    store.append({
      conversationId: "thread_bootstrap_tools",
      eventId: "tool_1",
      type: "tool.started",
      occurredAt: "2026-09-14T00:00:03.000Z",
      runId: "run_1",
      toolCallId: "tool_1",
      payload: { name: "Read", status: "running", input: { path: "/tmp/a" } },
    });

    expect(store.bootstrap("thread_bootstrap_tools").tools).toEqual([
      expect.objectContaining({
        toolCallId: "tool_1",
        runId: "run_1",
        name: "Read",
        status: "running",
      }),
    ]);
    expect(store.bootstrap("thread_bootstrap_tools").tools[0]).toMatchObject({
      input: { path: "/tmp/a" },
    });
    db.close();
  });

  test("recovery settles tools owned by terminal runs without inventing a tool result", () => {
    const { db, store } = createStore();
    const conversationId = "thread_recovery_tools";
    const appendRun = (runId: string, type: "run.started" | "run.failed" | "run.cancelled", at: string) =>
      store.append({
        conversationId,
        eventId: `${runId}_${type}`,
        type,
        occurredAt: at,
        turnId: runId,
        runId,
        payload: { status: type === "run.started" ? "running" : type.slice("run.".length) },
      });
    const appendTool = (runId: string, toolCallId: string, status: "running" | "completed") =>
      store.append({
        conversationId,
        eventId: `${toolCallId}_${status}`,
        type: status === "running" ? "tool.started" : "tool.completed",
        occurredAt: "2026-09-14T00:00:02.000Z",
        runId,
        toolCallId,
        payload: {
          name: "Bash",
          status,
          input: { command: "echo safe" },
          ...(status === "completed" ? { output: "safe" } : {}),
        },
      });

    appendRun("run_failed", "run.started", "2026-09-14T00:00:00.000Z");
    appendTool("run_failed", "call_interrupted", "running");
    appendTool("run_failed", "call_completed", "completed");
    appendRun("run_failed", "run.failed", "2026-09-14T00:00:03.000Z");
    appendRun("run_cancelled", "run.started", "2026-09-14T00:00:04.000Z");
    appendTool("run_cancelled", "call_cancelled", "running");
    appendRun("run_cancelled", "run.cancelled", "2026-09-14T00:00:05.000Z");
    appendRun("run_live", "run.started", "2026-09-14T00:00:06.000Z");
    appendTool("run_live", "call_live", "running");

    expect(store.reconcileTerminalRunTools(conversationId)).toEqual({ scanned: 2, settled: 2 });
    expect(store.getTool(conversationId, "call_interrupted").status).toBe("failed");
    expect(store.getTool(conversationId, "call_cancelled").status).toBe("failed");
    expect(store.getTool(conversationId, "call_completed")).toMatchObject({
      status: "completed",
      output: "safe",
    });
    expect(store.getTool(conversationId, "call_live").status).toBe("running");
    const recoveryEvent = db
      .prepare(
        `SELECT payload_json FROM conversation_events_v2 WHERE tool_call_id = ? AND type = 'tool.failed'`,
      )
      .get("call_interrupted") as { payload_json: string };
    expect(JSON.parse(recoveryEvent.payload_json)).toMatchObject({
      recoveryReason: expect.stringContaining("outcome is unknown"),
    });
    const head = store.head(conversationId).lastSeq;
    expect(store.reconcileTerminalRunTools(conversationId)).toEqual({ scanned: 0, settled: 0 });
    expect(store.head(conversationId).lastSeq).toBe(head);
    db.close();
  });

  test("projects todo.updated into bootstrap and sync, then rebuilds the same todo list", () => {
    const { db, store } = createStore();
    const input = {
      conversationId: "thread_todos",
      eventId: "todo_event_1",
      sourceEventKey: "todo_source_1",
      type: "todo.updated" as const,
      occurredAt: "2026-09-14T00:00:01.000Z",
      payload: {
        todos: [
          {
            todoId: "todo_1",
            conversationId: "thread_todos",
            title: "Implement V2",
            detail: "Persist and sync the todo projection",
            status: "running",
            position: 0,
            updatedAt: "2026-09-14T00:00:01.000Z",
          },
          {
            todoId: "todo_2",
            conversationId: "thread_todos",
            title: "Verify",
            detail: "Run focused tests",
            status: "pending",
            position: 1,
            updatedAt: "2026-09-14T00:00:01.000Z",
          },
        ],
      },
    };

    const first = store.append(input);
    const duplicate = store.append(input);
    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(store.head("thread_todos").lastSeq).toBe(1);

    const expectedTodos = [
      expect.objectContaining({ todoId: "todo_1", position: 0, versionSeq: 1 }),
      expect.objectContaining({ todoId: "todo_2", position: 1, versionSeq: 1 }),
    ];
    expect(store.bootstrap("thread_todos").todos).toEqual(expectedTodos);
    expect(store.sync("thread_todos", store.getStoreEpoch(), 0).effects).toEqual([
      expect.objectContaining({
        seq: 1,
        effect: { type: "todo.list.replace", todos: expectedTodos },
      }),
    ]);

    store.rebuildReadModels("thread_todos");
    expect(store.todosOf("thread_todos")).toEqual(expectedTodos);
    db.close();
  });

  test("persists pending plan runtime state in V2 and clears it", () => {
    const { db, store } = createStore();
    const conversationId = "thread_pending_plan_v2";
    store.append({
      conversationId,
      eventId: "pending_plan_seed",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "pending_plan_turn",
      messageId: "pending_plan_message",
      payload: { role: "user", body: "Implement the plan" },
    });

    store.savePendingPlan({
      conversationId,
      userPrompt: "Implement the plan",
      analysis: "The change is well scoped.",
      plan: "1. Persist it\n2. Verify it",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routesJson: "[]",
      planFilePath: "/tmp/plan.md",
      deferredExitPlanToolUseId: "tool_plan_v2",
      createdAt: "2026-09-14T00:00:02.000Z",
    });

    expect(store.getPendingPlan(conversationId)).toEqual({
      conversationId,
      userPrompt: "Implement the plan",
      analysis: "The change is well scoped.",
      plan: "1. Persist it\n2. Verify it",
      workspacePath: "/tmp/workspace",
      worktreePath: "/tmp/worktree",
      routesJson: "[]",
      planFilePath: "/tmp/plan.md",
      deferredExitPlanToolUseId: "tool_plan_v2",
      createdAt: "2026-09-14T00:00:02.000Z",
    });

    store.clearPendingPlan(conversationId);
    expect(store.getPendingPlan(conversationId)).toBeUndefined();
    db.close();
  });

  test("rejects invalid, duplicate-position, and cross-conversation todos", () => {
    const { db, store } = createStore();
    const invalidPayloads = [
      [
        {
          todoId: "todo_invalid",
          conversationId: "thread_invalid_todos",
          title: "Invalid",
          detail: "",
          status: "unknown",
          position: 0,
          updatedAt: "2026-09-14T00:00:01.000Z",
        },
      ],
      [
        {
          todoId: "todo_1",
          conversationId: "thread_invalid_todos",
          title: "One",
          detail: "",
          status: "pending",
          position: 0,
          updatedAt: "2026-09-14T00:00:01.000Z",
        },
        {
          todoId: "todo_2",
          conversationId: "thread_invalid_todos",
          title: "Two",
          detail: "",
          status: "pending",
          position: 0,
          updatedAt: "2026-09-14T00:00:01.000Z",
        },
      ],
      [
        {
          todoId: "todo_foreign",
          conversationId: "another_thread",
          title: "Foreign",
          detail: "",
          status: "pending",
          position: 0,
          updatedAt: "2026-09-14T00:00:01.000Z",
        },
      ],
    ];

    for (const [index, todos] of invalidPayloads.entries()) {
      expect(() =>
        store.append({
          conversationId: "thread_invalid_todos",
          eventId: `invalid_todo_event_${index}`,
          type: "todo.updated",
          occurredAt: "2026-09-14T00:00:01.000Z",
          payload: { todos },
        }),
      ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));
    }
    expect(() => store.head("thread_invalid_todos")).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.conversationNotFound }),
    );
    db.close();
  });

  test("bootstrap includes tool summaries even when the run row is unavailable", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_orphan_tool",
      eventId: "tool_1",
      type: "tool.started",
      occurredAt: "2026-09-14T00:00:01.000Z",
      runId: "run_1",
      toolCallId: "tool_1",
      payload: { name: "Read", status: "running" },
    });

    const bootstrap = store.bootstrap("thread_orphan_tool");
    expect(bootstrap.runs).toEqual([]);
    expect(bootstrap.tools).toEqual([
      expect.objectContaining({
        toolCallId: "tool_1",
        runId: "run_1",
        name: "Read",
      }),
    ]);
    db.close();
  });

  test("keeps user image previews in the V2 message read model", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_message_attachments",
      eventId: "message_with_image",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: {
        role: "user",
        body: "look",
        attachments: [{ id: "image_1", mediaType: "image/jpeg", data: "aGVsbG8=" }],
      },
    });

    expect(store.bootstrap("thread_message_attachments").messages[0]).toMatchObject({
      attachments: [{ id: "image_1", mediaType: "image/jpeg", data: "aGVsbG8=" }],
    });
    db.close();
  });

  test("persists and syncs an immutable history target for a user message", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_history_target",
      eventId: "history_target_message",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: { role: "user", body: "retry me" },
    });
    const target = store.append({
      conversationId: "thread_history_target",
      eventId: "history_target_bound",
      sourceEventKey: "provider:history-target:message_1",
      type: "message.history_targeted",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_1",
      payload: {
        historyTarget: {
          activityLineId: "activity_1",
          userMessageId: "provider_1",
        },
      },
    });

    expect(store.getMessage("thread_history_target", "message_1")).toMatchObject({
      historyTarget: {
        activityLineId: "activity_1",
        userMessageId: "provider_1",
      },
    });
    expect(target.effect.effect).toMatchObject({
      type: "message.history_target",
      messageId: "message_1",
      historyTarget: {
        activityLineId: "activity_1",
        userMessageId: "provider_1",
      },
    });
    expect(store.sync("thread_history_target", store.getStoreEpoch(), 1).effects).toEqual([
      expect.objectContaining({ effect: target.effect.effect }),
    ]);
    expect(() =>
      store.append({
        conversationId: "thread_history_target",
        eventId: "history_target_conflict",
        type: "message.history_targeted",
        occurredAt: "2026-09-14T00:00:03.000Z",
        messageId: "message_1",
        payload: {
          historyTarget: {
            activityLineId: "activity_2",
            userMessageId: "provider_1",
          },
        },
      }),
    ).toThrow();
    db.close();
  });

  test.each(providerPatchMethods)("%s emits history-target effects", (appendPatch) => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_provider_patch",
      eventId: "provider_patch_message",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: { role: "user", body: "bind me" },
    });
    store.append({
      conversationId: "thread_provider_patch",
      eventId: "provider_input_receipt",
      type: "noop",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_1",
      payload: {
        reason: "runtime.input",
        source: {
          threadId: "thread_provider_patch",
          id: "provider_input_1",
          metadata: { conversationV2MessageId: "message_1" },
        },
        message: "bind me",
      },
    });
    store[appendPatch]({
      conversationId: "thread_provider_patch",
      eventId: "provider_patch_event",
      sourceEventKey: "provider:patch:1",
      occurredAt: "2026-09-14T00:00:03.000Z",
      inputIds: ["provider_input_1"],
      patch: {
        metadataMerge: {
          rewindTarget: {
            activityLineId: "activity_1",
            userMessageId: "provider_1",
          },
        },
      },
      reason: "claude-bind",
    });

    expect(store.getMessage("thread_provider_patch", "message_1")).toMatchObject({
      historyTarget: { activityLineId: "activity_1", userMessageId: "provider_1" },
    });
    expect(store.head("thread_provider_patch").lastSeq).toBe(4);
    expect(store.sync("thread_provider_patch", store.getStoreEpoch(), 2).effects).toEqual([
      expect.objectContaining({
        effect: {
          type: "noop",
          reason: "provider.patch",
        },
      }),
      expect.objectContaining({
        effect: expect.objectContaining({
          type: "message.history_target",
          messageId: "message_1",
        }),
      }),
    ]);
    db.close();
  });

  test("current-transaction provider patches publish the history-target result", () => {
    const { db, store } = createStore();
    const conversationId = "thread_provider_patch_current_transaction";
    store.append({
      conversationId,
      eventId: "provider_patch_current_message",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: { role: "user", body: "bind me" },
    });
    store.append({
      conversationId,
      eventId: "provider_patch_current_input",
      type: "noop",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_1",
      payload: {
        reason: "runtime.input",
        source: {
          threadId: conversationId,
          id: "provider_input_1",
          metadata: { conversationV2MessageId: "message_1" },
        },
        message: "bind me",
      },
    });

    const committedSeqs: number[] = [];
    store.onCommitted((result) => committedSeqs.push(result.event.seq));
    const callbackResults: Array<{ event: { seq: number }; duplicate: boolean }> = [];
    db.exec("BEGIN IMMEDIATE");
    const first = store.appendProviderInputPatchInCurrentTransaction(
      {
        conversationId,
        eventId: "provider_patch_current_event",
        sourceEventKey: "provider:patch:current",
        occurredAt: "2026-09-14T00:00:03.000Z",
        inputIds: ["provider_input_1"],
        patch: {
          metadataMerge: {
            rewindTarget: {
              activityLineId: "activity_1",
              userMessageId: "provider_1",
            },
          },
        },
        reason: "codex-bind",
      },
      (result) => callbackResults.push(result),
    );
    db.exec("COMMIT");

    expect(first).toBe(callbackResults[0]);
    expect(callbackResults.map((result) => result.event.seq)).toEqual([3, 4]);
    store.publishCommitted(callbackResults);
    expect(committedSeqs).toEqual([3, 4]);
    expect(store.sync(conversationId, store.getStoreEpoch(), 2).effects).toEqual([
      expect.objectContaining({ seq: 3, effect: { type: "noop", reason: "provider.patch" } }),
      expect.objectContaining({
        seq: 4,
        effect: expect.objectContaining({ type: "message.history_target" }),
      }),
    ]);
    db.close();
  });

  test.each(providerPatchMethods)("%s preserves retry identity", (appendPatch) => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_provider_patch_retry",
      eventId: "provider_patch_retry_message",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: { role: "user", body: "bind me" },
    });
    store.append({
      conversationId: "thread_provider_patch_retry",
      eventId: "provider_patch_retry_input",
      type: "noop",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_1",
      payload: {
        reason: "runtime.input",
        source: {
          threadId: "thread_provider_patch_retry",
          id: "provider_input_1",
          metadata: { conversationV2MessageId: "message_1" },
        },
        message: "bind me",
      },
    });
    const input = {
      conversationId: "thread_provider_patch_retry",
      eventId: "provider_patch_retry_event",
      sourceEventKey: "provider:patch:retry",
      occurredAt: "2026-09-14T00:00:03.000Z",
      inputIds: ["provider_input_1"],
      patch: {
        metadataMerge: {
          rewindTarget: {
            activityLineId: "sdk:item_1",
            userMessageId: "item_1",
          },
        },
      },
      reason: "codex-bind",
    };

    expect(store[appendPatch](input).duplicate).toBe(false);
    const committedHead = store.head(input.conversationId).lastSeq;
    const retry = store[appendPatch]({ ...input, occurredAt: "2026-09-14T00:00:09.000Z" });

    expect(retry).toMatchObject({
      duplicate: true,
      event: { occurredAt: input.occurredAt },
    });
    expect(store.head(input.conversationId).lastSeq).toBe(committedHead);
    expect(store.getMessage(input.conversationId, "message_1")).toMatchObject({
      historyTarget: { activityLineId: "sdk:item_1", userMessageId: "item_1" },
    });
    expect(() =>
      store[appendPatch]({
        ...input,
        occurredAt: "2026-09-14T00:00:10.000Z",
        patch: {
          metadataMerge: {
            rewindTarget: {
              activityLineId: "sdk:item_2",
              userMessageId: "item_2",
            },
          },
        },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.idempotencyConflict }));
    expect(store.head(input.conversationId).lastSeq).toBe(committedHead);
    db.close();
  });

  test("runtime provider patches roll back the patch and publish nothing when a history target conflicts", () => {
    const { db, store, input } = createProviderPatchStore();
    try {
      store.appendRuntime({
        conversationId: input.conversationId,
        eventId: "existing_target",
        type: "message.history_targeted",
        occurredAt: "2026-10-21T00:00:01.500Z",
        messageId: "message",
        payload: { historyTarget: { activityLineId: "sdk:original", userMessageId: "original" } },
      });
      const head = store.head(input.conversationId).lastSeq;
      const readSource = () =>
        db
          .prepare(`SELECT source_json FROM conversation_provider_inputs_v2
        WHERE conversation_id = ? AND input_id = ?`)
          .get(input.conversationId, "provider_input");
      const previousSource = readSource();
      const committedSeqs: number[] = [];
      store.onCommitted(({ event }) => committedSeqs.push(event.seq));

      expect(() => store.appendRuntimeProviderInputPatch(input)).toThrow();
      expect(store.head(input.conversationId).lastSeq).toBe(head);
      expect(readSource()).toEqual(previousSource);
      expect(committedSeqs).toEqual([]);
      expect(store.validateIntegrity(input.conversationId).eventCount).toBe(head);
    } finally {
      db.close();
    }
  });

  test("runtime provider patch retries still verify the exact stored effect", () => {
    const { db, store, input } = createProviderPatchStore();
    try {
      const first = store.appendRuntimeProviderInputPatch(input);
      const head = store.head(input.conversationId).lastSeq;
      db.prepare(`UPDATE conversation_sync_effects_v2 SET effect_hash = 'tampered'
        WHERE conversation_id = ? AND seq = ?`).run(input.conversationId, first.event.seq);

      expect(() => store.appendRuntimeProviderInputPatch(input)).toThrow(
        expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
      );
      expect(store.head(input.conversationId).lastSeq).toBe(head);
    } finally {
      db.close();
    }
  });

  test("maintenance provider patches and explicit audits still reject damaged history", () => {
    const { db, store, input } = createProviderPatchStore();
    try {
      const head = store.head(input.conversationId).lastSeq;
      db.prepare(`UPDATE conversation_events_v2 SET payload_json = ?
        WHERE conversation_id = ? AND seq = 1`).run(
        '{"role":"user","body":"tampered"}',
        input.conversationId,
      );

      expect(() => store.appendProviderInputPatch(input)).toThrow(
        expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
      );
      expect(() => store.validateIntegrity(input.conversationId)).toThrow(
        expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
      );
      expect(store.head(input.conversationId).lastSeq).toBe(head);
    } finally {
      db.close();
    }
  });

  test("promotes an old Codex pending target once, while canonical targets remain immutable", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_codex_pending_promotion",
      eventId: "codex_pending_message",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_user_pending",
      payload: {
        role: "user",
        body: "bind me",
        historyTarget: { activityLineId: "codex-pending:one" },
      },
    });
    store.append({
      conversationId: "thread_codex_pending_promotion",
      eventId: "codex_pending_bind",
      type: "message.history_targeted",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_user_pending",
      payload: {
        historyTarget: { activityLineId: "sdk:item_1", userMessageId: "item_1" },
      },
    });

    expect(store.getMessage("thread_codex_pending_promotion", "message_user_pending")).toMatchObject({
      historyTarget: { activityLineId: "sdk:item_1", userMessageId: "item_1" },
    });
    expect(() =>
      store.append({
        conversationId: "thread_codex_pending_promotion",
        eventId: "codex_pending_conflict",
        type: "message.history_targeted",
        occurredAt: "2026-09-14T00:00:03.000Z",
        messageId: "message_user_pending",
        payload: {
          historyTarget: { activityLineId: "sdk:item_2", userMessageId: "item_2" },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.integrityFailure,
        message: expect.stringContaining(
          'existing={"activityLineId":"sdk:item_1","userMessageId":"item_1"}, attempted={"activityLineId":"sdk:item_2","userMessageId":"item_2"}',
        ),
        data: expect.objectContaining({
          conversationId: "thread_codex_pending_promotion",
          messageId: "message_user_pending",
          eventId: "codex_pending_conflict",
          sequence: 3,
          existingHistoryTarget: { activityLineId: "sdk:item_1", userMessageId: "item_1" },
          attemptedHistoryTarget: { activityLineId: "sdk:item_2", userMessageId: "item_2" },
        }),
      }),
    );
    db.close();
  });

  test("V2 retry progress gate is bounded by durable user targets and turn boundaries", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_retry_gate",
      eventId: "retry_user_1",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "user_1",
      payload: {
        role: "user",
        body: "retry me",
        historyTarget: { activityLineId: "activity_1" },
      },
    });
    store.append({
      conversationId: "thread_retry_gate",
      eventId: "retry_notice",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:02.000Z",
      turnId: "turn_1",
      messageId: "notice_1",
      payload: {
        role: "system",
        channel: "system",
        body: "provider failed",
        status: "final",
      },
    });
    expect(store.hasRetryBlockingProgress("thread_retry_gate", "activity_1")).toBe(false);
    expect(store.hasRetryBlockingProgress("thread_retry_gate", "missing")).toBe(true);

    store.append({
      conversationId: "thread_retry_gate",
      eventId: "retry_assistant_1",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:05.000Z",
      turnId: "turn_1",
      messageId: "assistant_1",
      payload: { role: "assistant", body: "already started" },
    });
    expect(store.hasRetryBlockingProgress("thread_retry_gate", "activity_1")).toBe(true);

    store.append({
      conversationId: "thread_retry_gate",
      eventId: "retry_user_2",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:06.000Z",
      turnId: "turn_2",
      messageId: "user_2",
      payload: { role: "user", body: "next", historyTarget: { activityLineId: "activity_2" } },
    });
    store.append({
      conversationId: "thread_retry_gate",
      eventId: "retry_tool_after_boundary",
      type: "tool.started",
      occurredAt: "2026-09-14T00:00:07.000Z",
      runId: "run_2",
      toolCallId: "tool_2",
      payload: { name: "Read", status: "running" },
    });
    expect(store.hasRetryBlockingProgress("thread_retry_gate", "activity_2")).toBe(true);
    db.close();
  });

  test("V2 retry progress gate refuses ambiguous duplicate user targets", () => {
    const { db, store } = createStore();
    for (const [eventId, messageId] of [
      ["ambiguous_user_1", "ambiguous_message_1"],
      ["ambiguous_user_2", "ambiguous_message_2"],
    ] as const) {
      store.append({
        conversationId: "thread_retry_ambiguous",
        eventId,
        type: "message.created",
        occurredAt: "2026-09-14T00:00:01.000Z",
        turnId: messageId,
        messageId,
        payload: {
          role: "user",
          body: "same target",
          historyTarget: { activityLineId: "duplicate" },
        },
      });
    }
    expect(store.hasRetryBlockingProgress("thread_retry_ambiguous", "duplicate")).toBe(true);
    db.close();
  });

  test("replaces queued desktop attachment paths with previews on finalize", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_queued_attachment",
      eventId: "accepted_with_path",
      type: "message.accepted",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: {
        role: "user",
        body: "look",
        attachments: [{ mediaType: "image/jpeg", path: "/desktop-only/image.jpg" }],
      },
    });
    const finalized = store.append({
      conversationId: "thread_queued_attachment",
      eventId: "finalized_with_preview",
      type: "message.finalized",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_1",
      payload: {
        status: "final",
        attachments: [{ mediaType: "image/jpeg", data: "cHJldmlldw==" }],
      },
    });

    expect(finalized.effect.effect).toMatchObject({
      type: "message.finalize",
      occurredAt: "2026-09-14T00:00:02.000Z",
      attachments: [{ mediaType: "image/jpeg", data: "cHJldmlldw==" }],
    });
    expect(store.getMessage("thread_queued_attachment", "message_1")).toMatchObject({
      status: "final",
      occurredAt: "2026-09-14T00:00:02.000Z",
      attachments: [{ mediaType: "image/jpeg", data: "cHJldmlldw==" }],
    });
    db.close();
  });

  test("bootstrap scopes tool summaries to the returned run window", () => {
    const { db, store } = createStore();
    for (const [suffix, sequence] of [
      ["old", 1],
      ["new", 4],
    ] as const) {
      store.append({
        conversationId: "thread_tool_window",
        eventId: `run_${suffix}`,
        type: "run.started",
        occurredAt: `2026-09-14T00:00:0${sequence}.000Z`,
        turnId: `turn_${suffix}`,
        runId: `run_${suffix}`,
        payload: { status: "running" },
      });
      store.append({
        conversationId: "thread_tool_window",
        eventId: `tool_${suffix}`,
        type: "tool.started",
        occurredAt: `2026-09-14T00:00:0${sequence + 1}.000Z`,
        runId: `run_${suffix}`,
        toolCallId: `tool_${suffix}`,
        payload: {
          name: "Read",
          status: "running",
          input: { path: `/${suffix}.md` },
        },
      });
    }

    const bootstrap = store.bootstrap("thread_tool_window", 1);
    expect(bootstrap.runs).toHaveLength(1);
    expect(bootstrap.tools.map((tool) => tool.toolCallId)).toEqual(["tool_new"]);
    db.close();
  });

  test("stores immutable events, versioned messages and contiguous effects", () => {
    const { db, store } = createStore();
    const create = store.append({
      conversationId: "thread_1",
      eventId: "event_create",
      sourceEventKey: "sdk:1",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_1",
      messageId: "message_1",
      payload: { role: "assistant", channel: "answer", body: "Hi" },
    });
    const delta = store.append({
      conversationId: "thread_1",
      eventId: "event_delta",
      sourceEventKey: "sdk:2",
      type: "message.delta",
      occurredAt: "2026-09-14T00:00:01.000Z",
      messageId: "message_1",
      payload: {
        delta: " there",
        baseContentVersion: 0,
        nextContentVersion: 1,
      },
    });
    store.append({
      conversationId: "thread_1",
      eventId: "event_final",
      sourceEventKey: "sdk:3",
      type: "message.finalized",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_1",
      payload: {},
    });

    expect(create.event.seq).toBe(1);
    expect(delta.event.seq).toBe(2);
    expect(store.head("thread_1").lastSeq).toBe(3);
    expect(store.getMessage("thread_1", "message_1")).toMatchObject({
      body: "Hi there",
      createdSeq: 1,
      versionSeq: 3,
      contentVersion: 1,
      status: "final",
    });
    expect(store.sync("thread_1", store.getStoreEpoch(), 0).effects.map((entry) => entry.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(store.validateIntegrity("thread_1")).toEqual({
      headSeq: 3,
      eventCount: 3,
      effectCount: 3,
    });

    const duplicate = store.append({
      conversationId: "thread_1",
      eventId: "event_delta",
      sourceEventKey: "sdk:2",
      type: "message.delta",
      occurredAt: "2026-09-14T00:00:01.000Z",
      messageId: "message_1",
      payload: {
        delta: " there",
        baseContentVersion: 0,
        nextContentVersion: 1,
      },
    });
    expect(duplicate.duplicate).toBe(true);
    expect(store.head("thread_1").lastSeq).toBe(3);

    expect(() =>
      store.append({
        conversationId: "thread_1",
        eventId: "event_delta",
        sourceEventKey: "sdk:2",
        type: "message.delta",
        occurredAt: "2026-09-14T00:00:01.000Z",
        messageId: "message_1",
        payload: {
          delta: " changed",
          baseContentVersion: 0,
          nextContentVersion: 1,
        },
      }),
    ).toThrow(ConversationV2Error);
    expect(store.head("thread_1").lastSeq).toBe(3);
    db.close();
  });

  test("advertises remaining sync data when throughSeq stops before the head", () => {
    const { db, store } = createStore();
    for (let seq = 1; seq <= 3; seq += 1) {
      store.append({
        conversationId: "thread_sync_window",
        eventId: `sync_window_${seq}`,
        type: "noop",
        occurredAt: `2026-09-14T00:00:0${seq}.000Z`,
        payload: { reason: `event_${seq}` },
      });
    }

    const page = store.sync("thread_sync_window", store.getStoreEpoch(), 0, 1);
    expect(page.throughSeq).toBe(1);
    expect(page.headSeq).toBe(3);
    expect(page.hasMore).toBe(true);
    db.close();
  });

  test("rolls back a multi-event transaction and keeps the cursor durable", () => {
    const { db, store } = createStore();
    expect(() =>
      store.appendBatch([
        {
          conversationId: "thread_1",
          eventId: "event_1",
          type: "message.created",
          occurredAt: "2026-09-14T00:00:00.000Z",
          turnId: "turn_1",
          messageId: "message_1",
          payload: { role: "user", body: "hello" },
        },
        {
          conversationId: "thread_1",
          eventId: "event_2",
          type: "message.delta",
          occurredAt: "2026-09-14T00:00:01.000Z",
          messageId: "missing",
          payload: { delta: "broken" },
        },
      ]),
    ).toThrow(ConversationV2Error);
    expect(() => store.head("thread_1")).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.conversationNotFound,
      }),
    );
    expect(() => store.getMessage("thread_1", "message_1")).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.conversationNotFound,
      }),
    );
    db.close();
  });

  test("does not turn an unknown conversation into an empty successful read", () => {
    const { db, store } = createStore();
    expect(() => store.bootstrap("missing")).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.conversationNotFound,
      }),
    );
    expect(() => store.messagesPage("missing")).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.conversationNotFound,
      }),
    );
    expect(() => store.getMessage("missing", "message_1")).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.conversationNotFound,
      }),
    );
    expect(() => store.getRun("missing", "run_1")).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.conversationNotFound,
      }),
    );
    expect(() => store.getDetail("missing", "detail_1")).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.conversationNotFound,
      }),
    );
    db.close();
  });

  test("rejects globally keyed read-model entities crossing conversations", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_a",
      eventId: "run_a",
      type: "run.started",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_a",
      runId: "run_shared",
      payload: { status: "running" },
    });
    expect(() =>
      store.append({
        conversationId: "thread_b",
        eventId: "run_b",
        type: "run.started",
        occurredAt: "2026-09-14T00:00:01.000Z",
        turnId: "turn_b",
        runId: "run_shared",
        payload: { status: "running" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));

    store.append({
      conversationId: "thread_a",
      eventId: "tool_a",
      type: "tool.started",
      occurredAt: "2026-09-14T00:00:02.000Z",
      runId: "run_shared",
      toolCallId: "tool_shared",
      payload: { name: "shell", status: "running" },
    });
    expect(() =>
      store.append({
        conversationId: "thread_b",
        eventId: "tool_b",
        type: "tool.started",
        occurredAt: "2026-09-14T00:00:03.000Z",
        runId: "run_b",
        toolCallId: "tool_shared",
        payload: { name: "shell", status: "running" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));
    db.close();
  });

  test("pages history with an opaque cursor and invalidates it on structural change", () => {
    const { db, store } = createStore();
    for (let index = 1; index <= 3; index += 1) {
      store.append({
        conversationId: "thread_1",
        eventId: `event_${index}`,
        type: "message.created",
        occurredAt: `2026-09-14T00:00:0${index}.000Z`,
        turnId: `turn_${index}`,
        messageId: `message_${index}`,
        payload: { role: "user", body: `message ${index}` },
      });
    }
    const first = store.messagesPage("thread_1", undefined, 2);
    expect(first.messages.map((message) => message.messageId)).toEqual(["message_2", "message_3"]);
    expect(first.nextCursor).toBeString();
    const second = store.messagesPage("thread_1", first.nextCursor, 2);
    expect(second.messages.map((message) => message.messageId)).toEqual(["message_1"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    store.append({
      conversationId: "thread_1",
      eventId: "event_delete",
      type: "history.deleted",
      occurredAt: "2026-09-14T00:00:04.000Z",
      payload: { messageId: "message_1" },
    });
    expect(() => store.messagesPage("thread_1", first.nextCursor, 2)).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.cursorStale }),
    );
    db.close();
  });

  test("history pages carry the run and tool summaries for their message window", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_history_tools",
      eventId: "run_1",
      type: "run.started",
      occurredAt: "2026-09-14T00:00:01.000Z",
      turnId: "turn_1",
      runId: "run_1",
      payload: { status: "running" },
    });
    store.append({
      conversationId: "thread_history_tools",
      eventId: "tool_1",
      type: "tool.started",
      occurredAt: "2026-09-14T00:00:02.000Z",
      runId: "run_1",
      toolCallId: "tool_1",
      payload: { name: "Read", status: "running", input: { path: "/old.md" } },
    });
    store.append({
      conversationId: "thread_history_tools",
      eventId: "message_1",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:03.000Z",
      turnId: "turn_1",
      runId: "run_1",
      messageId: "message_1",
      payload: { role: "assistant", body: "old" },
    });

    const page = store.messagesPage("thread_history_tools");
    expect(page.runs?.map((run) => run.runId)).toEqual(["run_1"]);
    expect(page.tools?.map((tool) => tool.toolCallId)).toEqual(["tool_1"]);
    db.close();
  });

  test("history rewrites tombstone only explicitly associated message ids", () => {
    const { db, store } = createStore();
    for (const [messageId, body, occurredAt] of [
      ["message_keep", "keep", "2026-09-14T00:00:10.000Z"],
      ["message_remove", "remove", "2026-09-14T00:00:01.000Z"],
    ] as const) {
      store.append({
        conversationId: "thread_history_rewrite",
        eventId: `create_${messageId}`,
        type: "message.created",
        occurredAt,
        turnId: `turn_${messageId}`,
        messageId,
        payload: { role: "assistant", body },
      });
    }

    db.exec("BEGIN IMMEDIATE");
    store.appendHistoryRewriteInCurrentTransaction({
      conversationId: "thread_history_rewrite",
      eventId: "history_edit",
      sourceEventKey: "history:edit:1",
      occurredAt: "2026-09-14T00:00:20.000Z",
      type: "history.edited",
      affectedMessageIds: ["message_remove"],
      reason: "explicit-test-association",
    });
    db.exec("COMMIT");

    expect(store.getMessage("thread_history_rewrite", "message_keep")).toMatchObject({
      body: "keep",
      isDeleted: false,
    });
    expect(store.getMessage("thread_history_rewrite", "message_remove")).toMatchObject({
      body: "remove",
      isDeleted: true,
      status: "deleted",
    });
    db.close();
  });

  test("pages versioned run details independently from message history", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_details",
      eventId: "run_started",
      sourceEventKey: "details:run",
      type: "run.started",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_details",
      runId: "run_details",
      payload: { status: "running" },
    });
    store.append({
      conversationId: "thread_details",
      eventId: "detail_1",
      sourceEventKey: "details:item:1",
      type: "detail.upserted",
      occurredAt: "2026-09-14T00:00:01.000Z",
      runId: "run_details",
      payload: {
        itemId: "detail_item_1",
        detailType: "tool.output",
        content: "output",
      },
    });
    const page = store.detailsPage("thread_details", "run_details", undefined, 10);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      itemId: "detail_item_1",
      runId: "run_details",
      content: "output",
      versionSeq: 2,
    });
    expect(store.getDetail("thread_details", "detail_item_1")).toMatchObject({
      type: "tool.output",
    });
    db.close();
  });

  test("pages large run tool summaries with an independent cursor and byte budget", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_tool_pages",
      eventId: "run_tools",
      type: "run.started",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_tools",
      runId: "run_tools",
      payload: { status: "running" },
    });
    store.append({
      conversationId: "thread_tool_pages",
      eventId: "message_tools",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:00.500Z",
      turnId: "turn_tools",
      runId: "run_tools",
      messageId: "message_tools",
      payload: { role: "assistant", body: "tool run" },
    });
    for (let index = 1; index <= 5; index += 1) {
      store.append({
        conversationId: "thread_tool_pages",
        eventId: `tool_${index}`,
        type: "tool.started",
        occurredAt: `2026-09-14T00:00:0${index}.000Z`,
        runId: "run_tools",
        toolCallId: `tool_${index}`,
        payload: {
          name: "Bash",
          status: "running",
          input: { command: `printf tool-${index}`, context: "x".repeat(400) },
        },
      });
    }

    const first = store.toolsPage("thread_tool_pages", "run_tools", undefined, 3, 8_192);
    expect(first.totalCount).toBe(5);
    expect(first.tools.map((tool) => tool.toolCallId)).toEqual(["tool_3", "tool_4", "tool_5"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBeString();
    expect(estimateConversationBytes(first)).toBeLessThanOrEqual(8_192);

    const second = store.toolsPage("thread_tool_pages", "run_tools", first.nextCursor, 3, 8_192);
    expect(second.totalCount).toBe(5);
    expect(second.tools.map((tool) => tool.toolCallId)).toEqual(["tool_1", "tool_2"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeUndefined();

    const bootstrap = store.bootstrap("thread_tool_pages", 1, 8_192);
    expect(bootstrap.toolSummaryCounts).toEqual({ run_tools: 5 });
    expect(bootstrap.tools.map((tool) => tool.toolCallId)).toEqual([
      "tool_1",
      "tool_2",
      "tool_3",
      "tool_4",
      "tool_5",
    ]);

    const bounded = store.toolsPage("thread_tool_pages", "run_tools", undefined, 5, 1_500);
    expect(estimateConversationBytes(bounded)).toBeLessThanOrEqual(1_500);
    expect(bounded.tools.length).toBeLessThan(5);
    expect(bounded.hasMore).toBe(true);

    const boundedBootstrap = store.bootstrap("thread_tool_pages", 1, 1_500);
    expect(estimateConversationBytes(boundedBootstrap)).toBeLessThanOrEqual(1_500);
    expect(boundedBootstrap.toolSummaryCounts).toEqual({ run_tools: 5 });
    expect(boundedBootstrap.tools.length).toBeLessThan(5);

    const boundedMessages = store.messagesPage("thread_tool_pages", undefined, 1, 1_500);
    expect(estimateConversationBytes(boundedMessages)).toBeLessThanOrEqual(1_500);
    expect(boundedMessages.toolSummaryCounts).toEqual({ run_tools: 5 });
    expect(boundedMessages.tools?.length).toBeLessThan(5);
    db.close();
  });

  test("makes sendMessage retryable without duplicating the user message", () => {
    const { db, store } = createStore();
    const input = {
      principalId: "user_1",
      conversationId: "thread_1",
      clientCommandId: "command_1",
      text: "hello",
    };
    const first = store.sendMessage(input);
    const retry = store.sendMessage(input);
    expect(retry).toEqual(first);
    expect(store.head("thread_1").lastSeq).toBe(1);
    expect(store.bootstrap("thread_1").messages).toHaveLength(1);
    expect(() => store.sendMessage({ ...input, text: "different" })).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.idempotencyConflict,
      }),
    );
    db.close();
  });

  test("reports both event identities when an idempotency key is reused with different content", () => {
    const { db, store } = createStore();
    const input = {
      conversationId: "thread_event_conflict_diagnostic",
      eventId: "event_collision",
      sourceEventKey: "provider:source-collision",
      type: "noop" as const,
      occurredAt: "2026-09-23T00:00:00.000Z",
      payload: { value: "first" },
    };

    store.append(input);

    let conflict: unknown;
    try {
      store.append({ ...input, payload: { value: "changed" } });
    } catch (error) {
      conflict = error;
    }

    expect(conflict).toMatchObject({
      code: CONVERSATION_V2_ERROR.idempotencyConflict,
      message: "Source event was replayed with different content (eventId=event_collision, existing=noop@1).",
      data: {
        eventId: "event_collision",
        sourceEventKey: "provider:source-collision",
        attemptedType: "noop",
        existingConversationId: "thread_event_conflict_diagnostic",
        existingSequence: 1,
        existingEventId: "event_collision",
        existingSourceEventKey: "provider:source-collision",
        existingType: "noop",
      },
    });
    db.close();
  });

  test("V2 sendMessage strips local paths when a durable attachment reference exists", () => {
    const { db, store } = createStore();
    const input = {
      principalId: "user_attachment_ref",
      conversationId: "thread_attachment_ref",
      clientCommandId: "command_attachment_ref",
      text: "inspect",
      attachments: [
        {
          mediaType: "image/png",
          path: "/private/desktop-only/prompt.png",
          contentRef: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          byteLength: 123,
          data: "cHJldmlldw==",
        },
      ],
    };
    const accepted = store.sendMessage(input);
    const message = store.getMessage(input.conversationId, accepted.messageId);
    expect(message?.attachments).toEqual([
      {
        mediaType: "image/png",
        contentRef: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byteLength: 123,
        data: "cHJldmlldw==",
      },
    ]);
    db.close();
  });

  test("does not return a corrupted command receipt as a successful retry", () => {
    const { db, store } = createStore();
    const input = {
      principalId: "user_receipt_guard",
      conversationId: "thread_receipt_guard",
      clientCommandId: "command_receipt_guard",
      text: "hello",
    };
    const first = store.sendMessage(input);
    db.prepare(
      `UPDATE conversation_command_receipts_v2
       SET result_json = ?
       WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?`,
    ).run(
      JSON.stringify({ ...first, messageId: "message_tampered" }),
      input.principalId,
      input.conversationId,
      input.clientCommandId,
    );
    expect(() => store.sendMessage(input)).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
    );
    db.close();
  });

  test("durably accepts non-message commands and rejects id reuse with different input", () => {
    const { db, store } = createStore();
    store.ensureConversation("thread_command_job");
    const input = {
      principalId: "user_command_job",
      conversationId: "thread_command_job",
      clientCommandId: "command_job_1",
      commandType: "history.rewrite" as const,
      request: {
        activityLineId: "line_1",
        prompt: "rewrite",
        attachments: [],
      },
      expectedHistoryRevision: 0,
    };

    const accepted = store.acceptCommand(input);
    const retry = store.acceptCommand(input);

    expect(retry).toEqual(accepted);
    expect(accepted).toMatchObject({
      protocolVersion: 2,
      status: "accepted",
      acceptedSeq: 1,
      request: input.request,
    });
    expect(store.head(input.conversationId).lastSeq).toBe(1);
    expect(
      store.sync(input.conversationId, store.getStoreEpoch(), 0, 1, 20, 32_000).effects[0]?.effect,
    ).toEqual({ type: "noop", reason: "command.accepted" });
    expect(() =>
      store.acceptCommand({
        ...input,
        request: { ...input.request, prompt: "different" },
      }),
    ).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.idempotencyConflict,
      }),
    );
    expect(() => store.acceptCommand({ ...input, expectedHistoryRevision: 1 })).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.idempotencyConflict,
      }),
    );
    db.close();
  });

  test("claims a command once and keeps terminal results idempotent", () => {
    const { db, store } = createStore();
    store.ensureConversation("thread_command_lifecycle");
    const accepted = store.acceptCommand({
      principalId: "user_command_lifecycle",
      conversationId: "thread_command_lifecycle",
      clientCommandId: "command_lifecycle_1",
      commandType: "history.retry",
      request: { activityLineId: "line_1", prompt: "retry" },
      expectedHistoryRevision: 0,
    });

    const firstClaim = store.beginCommandExecution(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
    );
    const secondClaim = store.beginCommandExecution(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
    );

    expect(firstClaim).toMatchObject({ acquired: true, job: { status: "running" } });
    expect(secondClaim).toMatchObject({ acquired: false, job: { status: "running" } });
    expect(store.listRecoverableCommandJobs()).toEqual([firstClaim.job]);

    expect(() =>
      store.recordCommandCheckpoint(
        accepted.principalId,
        accepted.conversationId,
        accepted.clientCommandId,
        "history.local_rewrite_committed",
        {},
      ),
    ).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.idempotencyConflict,
      }),
    );
    store.recordCommandCheckpoint(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
      "history.sdk_fork_skipped",
      { reason: "runtime_has_no_remote_fork" },
    );
    store.recordCommandCheckpoint(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
      "history.local_rewrite_committed",
      { historyRevision: 1 },
    );
    store.recordCommandCheckpoint(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
      "history.runtime_dispatch_prepared",
      { dispatchId: "dispatch_1", plannedAttemptId: "run_1" },
    );
    const dispatched = store.recordCommandCheckpoint(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
      "history.runtime_dispatched",
      { runId: "run_1" },
    );
    expect(dispatched.checkpoints.map((checkpoint) => checkpoint.name)).toEqual([
      "execution.claimed",
      "history.sdk_fork_skipped",
      "history.local_rewrite_committed",
      "history.runtime_dispatch_prepared",
      "history.runtime_dispatched",
    ]);
    expect(
      store.recordCommandCheckpoint(
        accepted.principalId,
        accepted.conversationId,
        accepted.clientCommandId,
        "history.runtime_dispatched",
        { runId: "run_1" },
      ),
    ).toEqual(dispatched);
    expect(() =>
      store.recordCommandCheckpoint(
        accepted.principalId,
        accepted.conversationId,
        accepted.clientCommandId,
        "history.runtime_dispatched",
        { runId: "run_2" },
      ),
    ).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.idempotencyConflict,
      }),
    );

    const completed = store.completeCommand(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
      { runId: "run_1", status: "running" },
    );
    expect(completed).toMatchObject({
      status: "completed",
      result: { runId: "run_1", status: "running" },
    });
    expect(
      store.completeCommand(accepted.principalId, accepted.conversationId, accepted.clientCommandId, {
        runId: "run_1",
        status: "running",
      }),
    ).toEqual(completed);
    expect(store.listRecoverableCommandJobs()).toEqual([]);
    expect(() =>
      store.completeCommand(accepted.principalId, accepted.conversationId, accepted.clientCommandId, {
        runId: "run_2",
        status: "running",
      }),
    ).toThrow(
      expect.objectContaining({
        code: CONVERSATION_V2_ERROR.idempotencyConflict,
      }),
    );
    db.close();
  });

  test("only non-rewind retry may prepare dispatch directly after claim", () => {
    const { db, store } = createStore();
    store.ensureConversation("thread_direct_dispatch");
    const retry = store.acceptCommand({
      principalId: "principal_direct",
      conversationId: "thread_direct_dispatch",
      clientCommandId: "retry_direct",
      commandType: "history.retry",
      request: { rewind: false, prompt: "retry", attachments: [] },
      expectedHistoryRevision: 0,
    });
    store.beginCommandExecution(retry.principalId, retry.conversationId, retry.clientCommandId);
    expect(
      store
        .recordCommandCheckpoint(
          retry.principalId,
          retry.conversationId,
          retry.clientCommandId,
          "history.runtime_dispatch_prepared",
          { dispatchId: "dispatch_direct", plannedAttemptId: "attempt_direct" },
        )
        .checkpoints.at(-1),
    ).toMatchObject({ name: "history.runtime_dispatch_prepared" });

    const rewrite = store.acceptCommand({
      principalId: "principal_direct",
      conversationId: "thread_direct_dispatch",
      clientCommandId: "rewrite_direct",
      commandType: "history.rewrite",
      request: { activityLineId: "line_1", prompt: "rewrite", attachments: [] },
      expectedHistoryRevision: 0,
    });
    store.beginCommandExecution(rewrite.principalId, rewrite.conversationId, rewrite.clientCommandId);
    expect(() =>
      store.recordCommandCheckpoint(
        rewrite.principalId,
        rewrite.conversationId,
        rewrite.clientCommandId,
        "history.runtime_dispatch_prepared",
        { dispatchId: "dispatch_invalid", plannedAttemptId: "attempt_invalid" },
      ),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.idempotencyConflict }));
    db.close();
  });

  test("keeps plan checkpoints on plan.resolve commands", () => {
    const { db, store } = createStore();
    store.ensureConversation("thread_plan_checkpoint");
    const plan = store.acceptCommand({
      principalId: "user_plan_checkpoint",
      conversationId: "thread_plan_checkpoint",
      clientCommandId: "plan_checkpoint_1",
      commandType: "plan.resolve",
      request: { resolution: "approve", input: {}, context: { plan: "frozen" } },
      expectedHistoryRevision: 0,
    });
    store.beginCommandExecution(plan.principalId, plan.conversationId, plan.clientCommandId);
    const checkpointed = store.recordCommandCheckpoint(
      plan.principalId,
      plan.conversationId,
      plan.clientCommandId,
      "plan.context_frozen",
      { contextHash: "hash_1" },
    );
    expect(checkpointed.checkpoints.map((checkpoint) => checkpoint.name)).toEqual([
      "execution.claimed",
      "plan.context_frozen",
    ]);

    const history = store.acceptCommand({
      principalId: "user_plan_checkpoint",
      conversationId: "thread_plan_checkpoint",
      clientCommandId: "history_checkpoint_1",
      commandType: "history.delete",
      request: { activityLineId: "line_1" },
      expectedHistoryRevision: 0,
    });
    store.beginCommandExecution(history.principalId, history.conversationId, history.clientCommandId);
    expect(() =>
      store.recordCommandCheckpoint(
        history.principalId,
        history.conversationId,
        history.clientCommandId,
        "plan.context_frozen",
        { contextHash: "hash_1" },
      ),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.idempotencyConflict }));
    db.close();
  });

  test("keeps a running command ambiguous after a real SQLite reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "eco-command-job-"));
    const databasePath = join(directory, "conversation.sqlite");
    try {
      const firstDb = new DatabaseSync(databasePath);
      const firstStore = new ConversationV2Store(firstDb, {
        idFactory: () => "disk_id",
        now: () => "2026-09-14T00:00:01.000Z",
      });
      firstStore.initialize();
      firstStore.ensureConversation("thread_command_disk");
      const accepted = firstStore.acceptCommand({
        principalId: "user_command_disk",
        conversationId: "thread_command_disk",
        clientCommandId: "command_disk_1",
        commandType: "history.rewrite",
        request: { activityLineId: "line_1", prompt: "rewrite" },
        expectedHistoryRevision: 0,
      });
      expect(
        firstStore.beginCommandExecution(
          accepted.principalId,
          accepted.conversationId,
          accepted.clientCommandId,
        ).acquired,
      ).toBe(true);
      firstDb.close();

      const reopenedDb = new DatabaseSync(databasePath);
      const reopenedStore = new ConversationV2Store(reopenedDb);
      reopenedStore.initialize();
      expect(reopenedStore.listRecoverableCommandJobs()).toEqual([
        expect.objectContaining({
          clientCommandId: accepted.clientCommandId,
          status: "running",
        }),
      ]);
      expect(
        reopenedStore.beginCommandExecution(
          accepted.principalId,
          accepted.conversationId,
          accepted.clientCommandId,
        ),
      ).toMatchObject({ acquired: false, job: { status: "running" } });
      reopenedDb.close();
    } finally {
      removeTempDirectorySync(directory);
    }
  });

  test("lets a caller atomically roll back a destructive-operation checkpoint", () => {
    const { db, store } = createStore();
    store.ensureConversation("thread_command_transaction");
    const accepted = store.acceptCommand({
      principalId: "user_command_transaction",
      conversationId: "thread_command_transaction",
      clientCommandId: "command_transaction_1",
      commandType: "history.rewrite",
      request: { activityLineId: "line_1", prompt: "rewrite" },
      expectedHistoryRevision: 0,
    });
    store.beginCommandExecution(accepted.principalId, accepted.conversationId, accepted.clientCommandId);
    store.recordCommandCheckpoint(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
      "history.sdk_fork_skipped",
      { reason: "test" },
    );

    db.exec("BEGIN IMMEDIATE");
    store.recordCommandCheckpointInCurrentTransaction({
      principalId: accepted.principalId,
      conversationId: accepted.conversationId,
      clientCommandId: accepted.clientCommandId,
      name: "history.local_rewrite_committed",
      payload: { historyRevision: 1 },
    });
    db.exec("ROLLBACK");
    expect(
      store
        .getCommandJob(accepted.principalId, accepted.conversationId, accepted.clientCommandId)
        ?.checkpoints.map((checkpoint) => checkpoint.name),
    ).toEqual(["execution.claimed", "history.sdk_fork_skipped"]);

    db.exec("BEGIN IMMEDIATE");
    store.recordCommandCheckpointInCurrentTransaction({
      principalId: accepted.principalId,
      conversationId: accepted.conversationId,
      clientCommandId: accepted.clientCommandId,
      name: "history.local_rewrite_committed",
      payload: { historyRevision: 1 },
    });
    db.exec("COMMIT");
    expect(
      store
        .getCommandJob(accepted.principalId, accepted.conversationId, accepted.clientCommandId)
        ?.checkpoints.at(-1),
    ).toMatchObject({
      name: "history.local_rewrite_committed",
      payload: { historyRevision: 1 },
    });
    db.close();
  });

  test("fails an accepted command durably when history changes before execution", () => {
    const { db, store } = createStore();
    store.ensureConversation("thread_command_stale");
    const accepted = store.acceptCommand({
      principalId: "user_command_stale",
      conversationId: "thread_command_stale",
      clientCommandId: "command_stale_1",
      commandType: "history.rewrite",
      request: { activityLineId: "line_1", prompt: "rewrite" },
      expectedHistoryRevision: 0,
    });
    store.append({
      conversationId: accepted.conversationId,
      eventId: "history_changed",
      type: "history.edited",
      occurredAt: "2026-09-14T00:00:09.000Z",
      payload: { reason: "other command", affectedMessageIds: [] },
    });

    const claim = store.beginCommandExecution(
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
    );

    expect(claim).toMatchObject({
      acquired: false,
      job: {
        status: "failed",
        error: {
          code: CONVERSATION_V2_ERROR.cursorStale,
          expectedHistoryRevision: 0,
          actualHistoryRevision: 1,
        },
      },
    });
    expect(store.listRecoverableCommandJobs()).toEqual([]);
    db.close();
  });

  test("does not return a command job whose durable request was corrupted", () => {
    const { db, store } = createStore();
    store.ensureConversation("thread_command_integrity");
    const accepted = store.acceptCommand({
      principalId: "user_command_integrity",
      conversationId: "thread_command_integrity",
      clientCommandId: "command_integrity_1",
      commandType: "history.rewrite",
      request: { activityLineId: "line_1", prompt: "rewrite" },
      expectedHistoryRevision: 0,
    });
    db.prepare(
      `UPDATE conversation_command_jobs_v2 SET request_json = ?
       WHERE principal_id = ? AND conversation_id = ? AND client_command_id = ?`,
    ).run(
      JSON.stringify({ activityLineId: "line_1", prompt: "tampered" }),
      accepted.principalId,
      accepted.conversationId,
      accepted.clientCommandId,
    );

    expect(() =>
      store.getCommandJob(accepted.principalId, accepted.conversationId, accepted.clientCommandId),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));
    db.close();
  });

  test("keeps a committed append successful when a post-commit hint fails", () => {
    const { db, store } = createStore();
    store.onCommitted(() => {
      throw new Error("push unavailable");
    });
    const result = store.append({
      conversationId: "thread_listener",
      eventId: "event_listener",
      sourceEventKey: "test:listener",
      type: "noop",
      occurredAt: "2026-09-14T00:00:00.000Z",
      payload: { reason: "test" },
    });
    expect(result.event.seq).toBe(1);
    expect(store.head("thread_listener").lastSeq).toBe(1);
    expect(store.validateIntegrity("thread_listener")).toEqual({
      headSeq: 1,
      eventCount: 1,
      effectCount: 1,
    });
    db.close();
  });

  test("does not let late message events revive or mutate a terminal message", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_terminal_message",
      eventId: "message_create",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_terminal_message",
      messageId: "message_terminal",
      payload: { role: "assistant", channel: "answer", body: "done" },
    });
    store.append({
      conversationId: "thread_terminal_message",
      eventId: "message_finalize",
      type: "message.finalized",
      occurredAt: "2026-09-14T00:00:01.000Z",
      messageId: "message_terminal",
      payload: {},
    });
    const lateDelta = store.append({
      conversationId: "thread_terminal_message",
      eventId: "message_late_delta",
      type: "message.delta",
      occurredAt: "2026-09-14T00:00:02.000Z",
      messageId: "message_terminal",
      payload: {
        delta: " corrupted",
        baseContentVersion: 0,
        nextContentVersion: 1,
      },
    });
    expect(lateDelta.effect.effect).toEqual({
      type: "noop",
      reason: "late_message_delta_ignored:message_terminal",
    });
    expect(store.getMessage("thread_terminal_message", "message_terminal")).toMatchObject({
      body: "done",
      status: "final",
      isDeleted: false,
    });

    const lateReplace = store.append({
      conversationId: "thread_terminal_message",
      eventId: "message_late_replace",
      type: "message.replaced",
      occurredAt: "2026-09-14T00:00:02.500Z",
      messageId: "message_terminal",
      payload: {
        baseContentVersion: 0,
        nextContentVersion: 1,
        body: "corrupted",
      },
    });
    expect(lateReplace.effect.effect).toEqual({
      type: "noop",
      reason: "late_message_replace_ignored:message_terminal",
    });
    expect(store.getMessage("thread_terminal_message", "message_terminal")).toMatchObject({
      body: "done",
      status: "final",
      isDeleted: false,
    });

    store.append({
      conversationId: "thread_terminal_message",
      eventId: "message_tombstone",
      type: "message.tombstoned",
      occurredAt: "2026-09-14T00:00:03.000Z",
      messageId: "message_terminal",
      payload: {},
    });
    const lateFinalize = store.append({
      conversationId: "thread_terminal_message",
      eventId: "message_late_finalize",
      type: "message.finalized",
      occurredAt: "2026-09-14T00:00:04.000Z",
      messageId: "message_terminal",
      payload: { body: "resurrected" },
    });
    expect(lateFinalize.effect.effect).toEqual({
      type: "noop",
      reason: "late_message_finalize_ignored:message_terminal",
    });
    expect(store.getMessage("thread_terminal_message", "message_terminal")).toMatchObject({
      body: "done",
      status: "deleted",
      isDeleted: true,
    });
    db.close();
  });

  test("keeps run terminal state and detail ownership fields monotonic", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_state_guard",
      eventId: "run_started",
      type: "run.started",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_state_guard",
      runId: "run_state_guard",
      payload: { status: "running", timingQuality: "unknown" },
    });
    store.append({
      conversationId: "thread_state_guard",
      eventId: "detail_created",
      type: "detail.upserted",
      occurredAt: "2026-09-14T00:00:01.000Z",
      runId: "run_state_guard",
      agentId: "agent_1",
      agentInstanceId: "instance_1",
      parentAgentId: "parent_1",
      parentAgentInstanceId: "parent_instance_1",
      parentToolCallId: "tool_parent_1",
      payload: {
        itemId: "detail_state_guard",
        detailType: "thinking",
        content: "first",
      },
    });
    store.append({
      conversationId: "thread_state_guard",
      eventId: "detail_updated",
      type: "detail.upserted",
      occurredAt: "2026-09-14T00:00:02.000Z",
      runId: "run_state_guard",
      payload: {
        itemId: "detail_state_guard",
        content: "second",
      },
    });
    expect(store.getDetail("thread_state_guard", "detail_state_guard")).toMatchObject({
      content: "second",
      agentId: "agent_1",
      agentInstanceId: "instance_1",
      parentAgentId: "parent_1",
      parentAgentInstanceId: "parent_instance_1",
      parentToolCallId: "tool_parent_1",
    });

    store.append({
      conversationId: "thread_state_guard",
      eventId: "run_completed",
      type: "run.completed",
      occurredAt: "2026-09-14T00:00:03.000Z",
      turnId: "turn_state_guard",
      runId: "run_state_guard",
      payload: {},
    });
    expect(store.getRun("thread_state_guard", "run_state_guard")).toMatchObject({
      status: "completed",
      timingQuality: "unknown",
    });
    expect(() =>
      store.append({
        conversationId: "thread_state_guard",
        eventId: "run_failed_late",
        type: "run.failed",
        occurredAt: "2026-09-14T00:00:04.000Z",
        turnId: "turn_state_guard",
        runId: "run_state_guard",
        payload: {},
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));
    expect(store.head("thread_state_guard").lastSeq).toBe(4);
    db.close();
  });

  test("run.corrected is an audited compare-and-swap repair and survives replay", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_run_correction",
      eventId: "run_correction_started",
      type: "run.started",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_run_correction",
      runId: "run_run_correction",
      payload: { status: "running", startedAt: "2026-09-14T00:00:00.000Z" },
    });
    store.append({
      conversationId: "thread_run_correction",
      eventId: "run_correction_completed",
      type: "run.completed",
      occurredAt: "2026-09-14T00:00:03.000Z",
      turnId: "turn_run_correction",
      runId: "run_run_correction",
      payload: { status: "completed", endedAt: "2026-09-14T00:00:03.000Z" },
    });

    const input = {
      conversationId: "thread_run_correction",
      runId: "run_run_correction",
      actorPrincipalId: "admin:operator-1",
      reason: "Provider reported a terminal failure after a stale bridge completed the run.",
      expectedPreviousStatus: "completed" as const,
      status: "failed" as const,
      endedAt: "2026-09-14T00:00:04.000Z",
      timingQuality: "recorded" as const,
    };
    const corrected = store.correctRun(input);
    expect(corrected.duplicate).toBe(false);
    expect(corrected.event.type).toBe("run.corrected");
    expect(corrected.effect.effect).toMatchObject({
      type: "run.upsert",
      run: {
        runId: "run_run_correction",
        status: "failed",
        startedAt: "2026-09-14T00:00:00.000Z",
        endedAt: "2026-09-14T00:00:04.000Z",
      },
    });
    expect(store.getRun("thread_run_correction", "run_run_correction")).toMatchObject({
      status: "failed",
      endedAt: "2026-09-14T00:00:04.000Z",
    });

    const audit = db
      .prepare(
        `SELECT type, payload_json FROM conversation_events_v2
          WHERE conversation_id = ? AND event_id = ?`,
      )
      .get("thread_run_correction", corrected.event.eventId) as { type: string; payload_json: string };
    expect(audit.type).toBe("run.corrected");
    expect(JSON.parse(audit.payload_json)).toMatchObject({
      authority: "admin",
      actorPrincipalId: "admin:operator-1",
      expectedPreviousStatus: "completed",
      status: "failed",
      reason: input.reason,
    });

    const duplicate = store.correctRun(input);
    expect(duplicate.duplicate).toBe(true);
    expect(store.head("thread_run_correction").lastSeq).toBe(3);
    expect(() =>
      store.correctRun({
        ...input,
        reason: "A stale second operator command must not overwrite the first correction.",
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));

    expect(() =>
      store.append({
        conversationId: "thread_run_correction",
        eventId: "run_correction_without_admin_audit",
        type: "run.corrected",
        occurredAt: "2026-09-14T00:00:05.000Z",
        turnId: "turn_run_correction",
        runId: "run_run_correction",
        payload: {
          expectedPreviousStatus: "failed",
          status: "completed",
          reason: "missing authority and actor",
        },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));

    store.rebuildReadModels("thread_run_correction");
    expect(store.getRun("thread_run_correction", "run_run_correction")).toMatchObject({
      status: "failed",
      endedAt: "2026-09-14T00:00:04.000Z",
    });
    db.close();
  });

  test("rejects event types whose status or entity identity changes semantics", () => {
    const { db, store } = createStore();
    expect(() =>
      store.append({
        conversationId: "thread_status_guard",
        eventId: "run_bad_status",
        type: "run.completed",
        occurredAt: "2026-09-14T00:00:00.000Z",
        turnId: "turn_status_guard",
        runId: "run_status_guard",
        payload: { status: "running" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));

    store.append({
      conversationId: "thread_status_guard",
      eventId: "tool_started",
      type: "tool.started",
      occurredAt: "2026-09-14T00:00:01.000Z",
      runId: "run_status_guard",
      toolCallId: "tool_status_guard",
      payload: { name: "lookup", status: "running" },
    });
    expect(() =>
      store.append({
        conversationId: "thread_status_guard",
        eventId: "tool_completed_bad_status",
        type: "tool.completed",
        occurredAt: "2026-09-14T00:00:02.000Z",
        runId: "run_status_guard",
        toolCallId: "tool_status_guard",
        payload: { name: "lookup", status: "failed" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));
    // A conflicting *status* is refused, but a conflicting *name* is kept: a real log
    // reports one call under two names (its own tool rows say `MCP: tool`, while the bash
    // approval rows for the same call id say `Bash`), and refusing the row aborted the whole
    // conversation's migration over a label. The call id is what identifies a call.
    const renamed = store.append({
      conversationId: "thread_status_guard",
      eventId: "tool_renamed",
      type: "tool.updated",
      occurredAt: "2026-09-14T00:00:03.000Z",
      runId: "run_status_guard",
      toolCallId: "tool_status_guard",
      payload: { name: "different" },
    });
    expect(renamed.duplicate).toBe(false);
    expect(store.getTool("thread_status_guard", "tool_status_guard")?.name).toBe("lookup");

    store.append({
      conversationId: "thread_status_guard",
      eventId: "tool_placeholder_started",
      type: "tool.started",
      occurredAt: "2026-09-14T00:00:03.100Z",
      runId: "run_status_guard",
      toolCallId: "tool_placeholder_guard",
      payload: { name: "MCP: tool" },
    });
    store.append({
      conversationId: "thread_status_guard",
      eventId: "tool_placeholder_named",
      type: "tool.updated",
      occurredAt: "2026-09-14T00:00:03.200Z",
      runId: "run_status_guard",
      toolCallId: "tool_placeholder_guard",
      payload: { name: "Bash" },
    });
    expect(store.getTool("thread_status_guard", "tool_placeholder_guard")?.name).toBe("Bash");
    store.append({
      conversationId: "thread_status_guard",
      eventId: "tool_placeholder_completed",
      type: "tool.completed",
      occurredAt: "2026-09-14T00:00:03.300Z",
      runId: "run_status_guard",
      toolCallId: "tool_placeholder_guard",
      payload: { name: "MCP: tool" },
    });
    expect(store.getTool("thread_status_guard", "tool_placeholder_guard")?.name).toBe("Bash");

    expect(() =>
      store.append({
        conversationId: "thread_status_guard",
        eventId: "message_bad_status",
        type: "message.accepted",
        occurredAt: "2026-09-14T00:00:04.000Z",
        turnId: "turn_message_status_guard",
        messageId: "message_status_guard",
        payload: { role: "user", status: "final", body: "bad" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));

    store.append({
      conversationId: "thread_status_guard",
      eventId: "message_valid",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:05.000Z",
      turnId: "turn_message_status_guard",
      messageId: "message_status_guard",
      payload: { role: "assistant", body: "hello" },
    });
    expect(() =>
      store.append({
        conversationId: "thread_status_guard",
        eventId: "message_finalize_bad_status",
        type: "message.finalized",
        occurredAt: "2026-09-14T00:00:06.000Z",
        messageId: "message_status_guard",
        payload: { status: "deleted" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));
    expect(() =>
      store.append({
        conversationId: "thread_status_guard",
        eventId: "message_delta_bad_version",
        type: "message.delta",
        occurredAt: "2026-09-14T00:00:07.000Z",
        messageId: "message_status_guard",
        payload: { delta: "!", baseContentVersion: "zero" },
      } as never),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));

    expect(() =>
      store.append({
        conversationId: "thread_status_guard",
        eventId: "run_bad_timing",
        type: "run.started",
        occurredAt: "2026-09-14T00:00:08.000Z",
        turnId: "turn_bad_timing",
        runId: "run_bad_timing",
        payload: { timingQuality: "clock_is_wrong" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));
    db.close();
  });

  test("rejects malformed event envelope identity fields instead of dropping them", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_envelope_guard",
      eventId: "event_valid",
      type: "noop",
      occurredAt: "2026-09-14T00:00:00.000Z",
      payload: {},
    });
    expect(() =>
      store.append({
        conversationId: "thread_envelope_guard",
        eventId: "event_bad_source_key",
        type: "noop",
        occurredAt: "2026-09-14T00:00:00.000Z",
        sourceEventKey: 42,
        payload: {},
      } as never),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));
    expect(() =>
      store.append({
        conversationId: "thread_envelope_guard",
        eventId: "event_bad_agent",
        type: "noop",
        occurredAt: "2026-09-14T00:00:01.000Z",
        payload: { agentInstanceId: { invalid: true } },
      } as never),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.invalidParams }));
    expect(store.head("thread_envelope_guard").lastSeq).toBe(1);
    db.close();
  });

  test("refuses to replay a damaged event log or mismatched effect hash", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_replay_guard",
      eventId: "replay_event_1",
      type: "noop",
      occurredAt: "2026-09-14T00:00:00.000Z",
      payload: { reason: "one" },
    });
    store.append({
      conversationId: "thread_replay_guard",
      eventId: "replay_event_2",
      type: "noop",
      occurredAt: "2026-09-14T00:00:01.000Z",
      payload: { reason: "two" },
    });
    db.prepare(`UPDATE conversation_events_v2 SET seq = 3 WHERE conversation_id = ? AND seq = 2`).run(
      "thread_replay_guard",
    );
    expect(() => store.rebuildReadModels("thread_replay_guard")).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
    );
    db.prepare(`UPDATE conversation_events_v2 SET seq = 2 WHERE conversation_id = ? AND seq = 3`).run(
      "thread_replay_guard",
    );
    db.prepare(
      `UPDATE conversation_sync_effects_v2 SET effect_json = ? WHERE conversation_id = ? AND seq = 1`,
    ).run(JSON.stringify({ type: "noop", reason: "tampered" }), "thread_replay_guard");
    expect(() => store.validateIntegrity("thread_replay_guard")).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
    );
    expect(() =>
      store.append({
        conversationId: "thread_replay_guard",
        eventId: "replay_event_3",
        type: "noop",
        occurredAt: "2026-09-14T00:00:02.000Z",
        payload: { reason: "three" },
      }),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));
    expect(store.head("thread_replay_guard").lastSeq).toBe(2);
    db.close();
  });

  test("fails closed when persisted read models or effects are malformed", () => {
    const messageStore = createStore();
    messageStore.store.append({
      conversationId: "thread_read_model_integrity",
      eventId: "read_model_message",
      type: "message.created",
      occurredAt: "2026-09-14T00:00:00.000Z",
      turnId: "turn_read_model_integrity",
      messageId: "message_read_model_integrity",
      payload: { role: "user", body: "hello" },
    });
    messageStore.db
      .prepare(`UPDATE conversation_messages_v2 SET status = ? WHERE message_id = ?`)
      .run("corrupted", "message_read_model_integrity");
    expect(() =>
      messageStore.store.getMessage("thread_read_model_integrity", "message_read_model_integrity"),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));
    expect(() => messageStore.store.bootstrap("thread_read_model_integrity")).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
    );
    messageStore.db.close();

    const effectStore = createStore();
    effectStore.store.append({
      conversationId: "thread_effect_integrity",
      eventId: "effect_integrity_event",
      type: "noop",
      occurredAt: "2026-09-14T00:00:00.000Z",
      payload: { reason: "original" },
    });
    effectStore.db
      .prepare(
        `UPDATE conversation_sync_effects_v2 SET effect_json = ? WHERE conversation_id = ? AND seq = 1`,
      )
      .run(JSON.stringify({ type: "message.append", messageId: "missing" }), "thread_effect_integrity");
    expect(() =>
      effectStore.store.sync("thread_effect_integrity", effectStore.store.getStoreEpoch(), 0),
    ).toThrow(expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }));
    effectStore.db.close();
  });

  test("rejects a tampered sync effect before returning it", () => {
    const { db, store } = createStore();
    store.append({
      conversationId: "thread_sync_integrity",
      eventId: "sync_integrity_1",
      type: "noop",
      occurredAt: "2026-09-14T00:00:00.000Z",
      payload: { reason: "original" },
    });
    db.prepare(
      `UPDATE conversation_sync_effects_v2 SET effect_json = ? WHERE conversation_id = ? AND seq = 1`,
    ).run(JSON.stringify({ type: "noop", reason: "tampered" }), "thread_sync_integrity");
    expect(() => store.sync("thread_sync_integrity", store.getStoreEpoch(), 0)).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
    );
    db.close();
  });

  test("rejects an internal gap in a sync page", () => {
    const { db, store } = createStore();
    for (let seq = 1; seq <= 3; seq += 1) {
      store.append({
        conversationId: "thread_sync_gap",
        eventId: `sync_gap_${seq}`,
        type: "noop",
        occurredAt: `2026-09-14T00:00:0${seq}.000Z`,
        payload: { reason: `event_${seq}` },
      });
    }
    db.prepare(`DELETE FROM conversation_sync_effects_v2 WHERE conversation_id = ? AND seq = ?`).run(
      "thread_sync_gap",
      2,
    );

    expect(() => store.sync("thread_sync_gap", store.getStoreEpoch(), 0)).toThrow(
      expect.objectContaining({ code: CONVERSATION_V2_ERROR.integrityFailure }),
    );
    db.close();
  });
});

test("seeds the agent registry from legacy instances and keeps it readable", () => {
  // The upgrade path: a database that already has V2 streams but no agent registry. Its
  // agents only exist in the legacy instance table, so the seed has to fill role, kind,
  // mission and boundaries — and every seeded row must carry a version the client can
  // hold, or bootstrap fails to read the very read model it just created.
  const db = new DatabaseSync(":memory:");
  // Build a database as it looked *before* the agent registry existed: the V2 tables and
  // a stream are there, the legacy instance table is there, the registry is not.
  new ConversationV2Store(db).initialize();
  db.exec(`DROP TABLE conversation_agents_v2;`);
  db.exec(`
    CREATE TABLE thread_agent_instances (
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      run_attempt_id TEXT,
      parent_agent_id TEXT,
      parent_tool_use_id TEXT,
      mission_key TEXT,
      todo_id TEXT,
      started_at TEXT,
      ended_at TEXT
    );
    INSERT INTO conversation_streams_v2
      (conversation_id, store_epoch, last_seq, history_revision, reducer_version)
      SELECT 'thr_seed', (SELECT value FROM conversation_store_meta_v2
                          WHERE key = 'conversation_v2_store_epoch'), 7, 0, 1;
    INSERT INTO thread_agent_instances
      (thread_id, agent_id, role, kind, status, run_attempt_id, parent_agent_id,
       parent_tool_use_id, mission_key, todo_id, started_at, ended_at)
      VALUES ('thr_seed', 'coder_a', 'coder', 'subagent', 'stopped', 'attempt_1',
              'main:attempt_1', 'toolu_a', 'api', NULL,
              '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:04.000Z');
    -- The card's own text: the provider's task name and the delegation it was handed.
    -- Both only ever lived on this row outside the registry.
    CREATE TABLE thread_run_events (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL, scope TEXT NOT NULL, role TEXT, agent_id TEXT,
      message TEXT, metadata_json TEXT
    );
    INSERT INTO thread_run_events
      (id, thread_id, sequence, event_type, scope, role, agent_id, message, metadata_json)
      VALUES ('evt_started', 'thr_seed', 3, 'agent.started', 'agent', 'coder', 'coder_a', '',
              '{"taskName":"gz_weather","delegationSummary":"查询广州天气","delegationPrompt":"查询广州今天天气"}');
  `);
  const store = new ConversationV2Store(db);
  store.initialize();

  const bootstrap = store.bootstrap("thr_seed");

  expect(bootstrap.agents).toEqual([
    {
      agentId: "coder_a",
      conversationId: "thr_seed",
      role: "coder",
      kind: "subagent",
      status: "stopped",
      runId: "attempt_1",
      parentAgentInstanceId: "main:attempt_1",
      parentToolCallId: "toolu_a",
      startedAt: "2026-01-01T00:00:01.000Z",
      endedAt: "2026-01-01T00:00:04.000Z",
      mission: "api",
      taskName: "gz_weather",
      delegationSummary: "查询广州天气",
      delegationPrompt: "查询广州今天天气",
      versionSeq: 1,
    },
  ]);

  // Re-running the upgrade must not duplicate or rewrite the seed.
  const reopened = new ConversationV2Store(db);
  reopened.initialize();
  const again = reopened.bootstrap("thr_seed").agents;
  expect(again).toHaveLength(1);
  expect(again).toEqual(bootstrap.agents);
});

test("upgrades an older tool read model with provider role", () => {
  const db = new DatabaseSync(":memory:");
  new ConversationV2Store(db).initialize();
  db.exec(`
    DROP INDEX idx_conversation_tools_v2_run;
    ALTER TABLE conversation_tool_calls_v2 RENAME TO conversation_tool_calls_v2_previous;
    CREATE TABLE conversation_tool_calls_v2 (
      tool_call_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      agent_id TEXT,
      agent_instance_id TEXT,
      parent_agent_instance_id TEXT,
      parent_tool_call_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      version_seq INTEGER NOT NULL,
      input_json TEXT,
      output_json TEXT,
      occurred_at TEXT
    );
    INSERT INTO conversation_tool_calls_v2
      SELECT tool_call_id, conversation_id, run_id, agent_id, agent_instance_id,
             parent_agent_instance_id, parent_tool_call_id, name, status, created_seq,
             version_seq, input_json, output_json, occurred_at
      FROM conversation_tool_calls_v2_previous;
    DROP TABLE conversation_tool_calls_v2_previous;
  `);

  new ConversationV2Store(db).initialize();
  const columns = db.prepare(`PRAGMA table_info(conversation_tool_calls_v2)`).all() as Array<{
    name: string;
  }>;
  expect(columns.map((column) => column.name)).toContain("provider_role");
  db.close();
});

test("does not invent a card's text from the mission key", () => {
  // A mission key is an identifier ("gz_weather"), not the sentence under a card's title.
  // A registry that only knows the key must leave the card without delegate text rather
  // than pass an id off as prose — the legacy chain shows an empty line there too.
  const store = new ConversationV2Store(new DatabaseSync(":memory:"));
  store.initialize();
  store.ensureConversation("thr_mission");
  appendLegacyThreadRunEventToConversationV2(store, {
    id: "evt_started",
    threadId: "thr_mission",
    sequence: 1,
    eventType: "agent.started",
    scope: "agent",
    streamState: "none",
    message: "",
    observedAt: "2026-01-01T00:00:01.000Z",
    role: "coder",
    agentId: "coder_a",
    runAttemptId: "attempt_1",
    metadata: { lifecycle: "started", missionKey: "gz_weather" },
  });
  const agent = store.bootstrap("thr_mission").agents[0];
  expect(agent?.mission).toBe("gz_weather");
  expect(agent?.delegationSummary).toBeUndefined();
  expect(agent?.delegationPrompt).toBeUndefined();
});

test("stores and reopens the V2 projection snapshot without changing the event cursor", () => {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  store.append({
    conversationId: "thr_projection_snapshot",
    eventId: "projection_seed",
    type: "message.created",
    occurredAt: "2026-09-14T00:00:01.000Z",
    turnId: "turn_projection",
    messageId: "message_projection",
    payload: { role: "user", body: "seed" },
  });
  const before = store.head("thr_projection_snapshot");
  store.saveProjectionSnapshot("thr_projection_snapshot", {
    requestSpans: [],
    billing: {
      totalTokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      sourceReportedCostUsd: 0.1,
      plannerTokenCostUsd: 0.1,
      ecoCostUsd: 0.1,
      savedUsd: 0,
      savedPct: 0,
      pricingResolved: true,
    },
  });
  expect(store.head("thr_projection_snapshot")).toEqual(before);
  expect(store.getProjectionSnapshot("thr_projection_snapshot")).toMatchObject({
    requestSpans: [],
    billing: { totalTokens: { input: 1, output: 2 } },
  });
  const reopened = new ConversationV2Store(db);
  reopened.initialize();
  expect(reopened.getProjectionSnapshot("thr_projection_snapshot")).toMatchObject({
    billing: { totalTokens: { cacheRead: 3, cacheCreation: 4 } },
  });
  db.close();
});
