import { describe, expect, test } from "bun:test";
import {
  type ConversationBootstrap,
  type ConversationSyncEffect,
  type ConversationSyncPage,
  type ConversationToolsPage,
  stableHash,
} from "@eco/shared";
import {
  applyConversationV2Effect,
  applyConversationV2Effects,
  ConversationV2RendererConflictError,
  ConversationV2RendererGapError,
  catchUpConversationV2RendererState,
  conversationV2ToolRunIdsForHydration,
  installConversationV2Bootstrap,
  installConversationV2ProjectionExtras,
  mergeConversationV2OlderPage,
  mergeConversationV2ToolPage,
  orderedConversationV2Messages,
} from "../src/renderer/conversation-v2-renderer-state";

const bootstrap: ConversationBootstrap = {
  protocolVersion: 2,
  storeEpoch: "epoch_1",
  conversationId: "thread_1",
  snapshotSeq: 1,
  historyRevision: 0,
  messages: [
    {
      messageId: "message_1",
      conversationId: "thread_1",
      turnId: "turn_1",
      role: "assistant",
      channel: "answer",
      createdSeq: 1,
      versionSeq: 1,
      contentVersion: 0,
      body: "hello",
      status: "streaming",
      isDeleted: false,
    },
  ],
  turns: [],
  runs: [],
  tools: [],
  hasOlder: false,
};

function effect(seq: number, value: ConversationSyncEffect["effect"]): ConversationSyncEffect {
  return { seq, effectVersion: 1, effectHash: stableHash(value), effect: value };
}

describe("conversation V2 renderer state", () => {
  test("receipts advance and verify the cursor without copying historical collections", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const next = applyConversationV2Effects(state, [
      effect(2, { type: "noop", reason: "provider receipt" }),
      effect(3, { type: "noop", reason: "command accepted" }),
    ]);
    expect(next.appliedSeq).toBe(3);
    expect(next.effectHashes.has(3)).toBe(true);
    for (const key of ["messages", "runs", "agents", "todos", "tools", "details"] as const) {
      expect(next[key]).toBe(state[key]);
    }
    expect(state.appliedSeq).toBe(1);
    expect(state.effectHashes.has(3)).toBe(false);
    expect(() => applyConversationV2Effect(next, effect(3, { type: "noop", reason: "conflict" }))).toThrow(
      ConversationV2RendererConflictError,
    );
  });

  test("a content batch copies only changed collections and failed batches keep the prior state intact", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const append = effect(2, {
      type: "message.append",
      messageId: "message_1",
      baseContentVersion: 0,
      nextContentVersion: 1,
      delta: " world",
      versionSeq: 2,
    });
    const next = applyConversationV2Effects(state, [append, effect(3, { type: "noop", reason: "receipt" })]);
    expect(next.messages).not.toBe(state.messages);
    expect(next.messages.get("message_1")?.body).toBe("hello world");
    for (const key of ["runs", "agents", "todos", "tools", "details"] as const) {
      expect(next[key]).toBe(state[key]);
    }
    expect(() =>
      applyConversationV2Effects(state, [append, effect(4, { type: "noop", reason: "missing sequence" })]),
    ).toThrow(ConversationV2RendererGapError);
    expect(state.messages.get("message_1")?.body).toBe("hello");
    expect(state.appliedSeq).toBe(1);
  });

  test("queued message replacement updates and removes attachments with its body", () => {
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      messages: [{ ...bootstrap.messages[0]!, role: "user", status: "queued", attachments: [{ contentRef: "old" }] }],
    });
    const replaced = applyConversationV2Effect(state, effect(2, {
      type: "message.replace", messageId: "message_1", baseContentVersion: 0,
      nextContentVersion: 1, body: "edited", versionSeq: 2, attachments: [],
    }));
    expect(replaced.messages.get("message_1")).toMatchObject({ body: "edited", attachments: [], status: "queued" });
  });
  test("installs V2 projection extras without falling back to legacy projection fields", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const next = installConversationV2ProjectionExtras(state, {
      requestSpans: [
        {
          requestId: "request_1",
          status: "completed",
          startedAt: "2026-09-18T00:00:00.000Z",
        },
      ],
    });
    expect(next.projectionExtras?.requestSpans).toEqual([
      expect.objectContaining({ requestId: "request_1", status: "completed" }),
    ]);
    expect(next.projectionExtras?.billing).toBeUndefined();
  });

  test("installs bootstrap tool summaries", () => {
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      toolSummaryCounts: { orphan_run: 120, run_1: 1 },
      tools: [
        {
          toolCallId: "tool_1",
          conversationId: "thread_1",
          runId: "run_1",
          name: "Read",
          status: "completed",
          createdSeq: 1,
          versionSeq: 1,
        },
      ],
    });

    expect(state.tools.get("tool_1")?.name).toBe("Read");
    expect(state.toolSummaryCounts?.get("orphan_run")).toBe(120);
    expect(conversationV2ToolRunIdsForHydration(state)).toEqual(new Set(["orphan_run", "run_1"]));
  });

  test("installs and replaces todo progress from V2 bootstrap/effects", () => {
    const todo = {
      todoId: "todo_1",
      conversationId: "thread_1",
      title: "Use V2",
      detail: "Read progress from the V2 state",
      status: "running" as const,
      position: 0,
      updatedAt: "2026-09-18T00:00:00.000Z",
      versionSeq: 1,
    };
    const state = installConversationV2Bootstrap({ ...bootstrap, todos: [todo] });
    expect(state.todos.get("todo_1")).toEqual(todo);
    const next = applyConversationV2Effect(
      state,
      effect(2, {
        type: "todo.list.replace",
        todos: [{ ...todo, status: "completed", updatedAt: "2026-09-18T00:00:01.000Z", versionSeq: 2 }],
      }),
    );
    expect(next.todos.get("todo_1")).toMatchObject({ status: "completed", versionSeq: 2 });
  });

  test("applies immutable message effects and preserves canonical ordering", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const next = applyConversationV2Effects(state, [
      effect(2, {
        type: "message.append",
        messageId: "message_1",
        baseContentVersion: 0,
        nextContentVersion: 1,
        delta: " world",
        versionSeq: 2,
      }),
      effect(3, {
        type: "message.create",
        message: {
          messageId: "message_2",
          conversationId: "thread_1",
          turnId: "turn_2",
          role: "user",
          channel: "answer",
          createdSeq: 3,
          versionSeq: 3,
          contentVersion: 0,
          body: "next",
          status: "final",
          isDeleted: false,
        },
      }),
    ]);

    expect(next.appliedSeq).toBe(3);
    expect(next.messages.get("message_1")?.body).toBe("hello world");
    expect(orderedConversationV2Messages(next).map((message) => message.messageId)).toEqual([
      "message_1",
      "message_2",
    ]);
  });

  test("applies message history targets and preserves their immutable identity", () => {
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      messages: [
        {
          ...bootstrap.messages[0],
          messageId: "message_user",
          role: "user",
          body: "prompt",
          status: "final",
        },
      ],
    });
    const targeted = applyConversationV2Effect(
      state,
      effect(2, {
        type: "message.history_target",
        messageId: "message_user",
        historyTarget: { activityLineId: "sdk:item-1" },
        versionSeq: 2,
      }),
    );
    expect(targeted.messages.get("message_user")?.historyTarget).toEqual({
      activityLineId: "sdk:item-1",
    });

    const promoted = applyConversationV2Effect(
      targeted,
      effect(3, {
        type: "message.history_target",
        messageId: "message_user",
        historyTarget: { activityLineId: "sdk:item-1", userMessageId: "provider:user-1" },
        versionSeq: 3,
      }),
    );
    expect(promoted.messages.get("message_user")?.historyTarget).toEqual({
      activityLineId: "sdk:item-1",
      userMessageId: "provider:user-1",
    });
    expect(() =>
      applyConversationV2Effect(
        promoted,
        effect(4, {
          type: "message.history_target",
          messageId: "message_user",
          historyTarget: { activityLineId: "sdk:item-2", userMessageId: "provider:user-1" },
          versionSeq: 4,
        }),
      ),
    ).toThrow("history identity changed");
  });

  test("duplicate effects are idempotent and conflicting duplicates fail", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const committed = applyConversationV2Effect(state, effect(2, { type: "noop", reason: "same" }));
    expect(applyConversationV2Effect(committed, effect(2, { type: "noop", reason: "same" }))).toBe(committed);
    expect(() =>
      applyConversationV2Effect(committed, effect(2, { type: "noop", reason: "different" })),
    ).toThrow(ConversationV2RendererConflictError);
    expect(() =>
      applyConversationV2Effect(committed, {
        ...effect(3, { type: "noop", reason: "tampered" }),
        effectHash: "wrong-hash",
      }),
    ).toThrow("effect hash mismatch");
  });

  test("bounds duplicate effect hashes while replaying a long stream", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const effects = Array.from({ length: 2_100 }, (_, index) => {
      const seq = index + 2;
      const value = {
        type: "message.append" as const,
        messageId: "message_1",
        baseContentVersion: index,
        nextContentVersion: index + 1,
        delta: "x",
        versionSeq: seq,
      };
      return effect(seq, value);
    });
    const next = applyConversationV2Effects(state, effects);
    expect(next.appliedSeq).toBe(2_101);
    expect(next.effectHashes.size).toBeLessThanOrEqual(2_048);
  });

  test("does not apply an out-of-order effect and exposes a recoverable gap", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    expect(() => applyConversationV2Effect(state, effect(3, { type: "noop", reason: "gap" }))).toThrow(
      ConversationV2RendererGapError,
    );
  });

  test("does not apply an unsupported effect version or malformed metadata", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    expect(() =>
      applyConversationV2Effect(state, {
        ...effect(2, { type: "noop", reason: "unsupported" }),
        effectVersion: 2 as 1,
      }),
    ).toThrow("effect metadata is invalid");
    expect(() =>
      applyConversationV2Effect(state, {
        ...effect(2, { type: "noop", reason: "invalid" }),
        seq: 0,
      }),
    ).toThrow("effect metadata is invalid");
  });

  test("history invalidation advances the revision without reviving deleted messages", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const next = applyConversationV2Effects(state, [
      effect(2, { type: "message.tombstone", messageId: "message_1", versionSeq: 2 }),
      effect(3, { type: "history.invalidation", historyRevision: 1 }),
    ]);
    expect(next.historyRevision).toBe(1);
    expect(orderedConversationV2Messages(next)).toEqual([]);
  });

  test("does not mutate terminal messages from late streaming effects", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const terminal = applyConversationV2Effect(
      state,
      effect(2, {
        type: "message.finalize",
        messageId: "message_1",
        contentVersion: 0,
        versionSeq: 2,
        status: "final",
        attachments: [{ mediaType: "image/jpeg", data: "cHJldmlldw==" }],
      }),
    );
    expect(terminal.messages.get("message_1")?.attachments).toEqual([
      { mediaType: "image/jpeg", data: "cHJldmlldw==" },
    ]);

    const afterLateAppend = applyConversationV2Effect(
      terminal,
      effect(3, {
        type: "message.append",
        messageId: "message_1",
        baseContentVersion: 0,
        nextContentVersion: 1,
        delta: " late",
        versionSeq: 3,
      }),
    );
    const afterLateFinalize = applyConversationV2Effect(
      afterLateAppend,
      effect(4, {
        type: "message.finalize",
        messageId: "message_1",
        contentVersion: 2,
        versionSeq: 4,
        status: "failed",
      }),
    );
    const afterLateReplace = applyConversationV2Effect(
      afterLateFinalize,
      effect(5, {
        type: "message.replace",
        messageId: "message_1",
        baseContentVersion: 0,
        nextContentVersion: 1,
        body: "late cumulative snapshot",
        versionSeq: 5,
      }),
    );

    expect(afterLateReplace.messages.get("message_1")).toEqual(terminal.messages.get("message_1"));
  });

  test("rejects immutable entity identity changes even at a newer version", () => {
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      runs: [
        {
          runId: "run_1",
          conversationId: "thread_1",
          turnId: "turn_1",
          status: "running",
          versionSeq: 1,
          timingQuality: "recorded",
        },
      ],
    });

    expect(() =>
      applyConversationV2Effect(
        state,
        effect(2, {
          type: "run.upsert",
          run: {
            runId: "run_1",
            conversationId: "thread_1",
            turnId: "turn_2",
            status: "completed",
            versionSeq: 2,
            timingQuality: "recorded",
          },
        }),
      ),
    ).toThrow("changed turns");
  });

  test("compares tool JSON structurally for same-version duplicates", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const first = applyConversationV2Effect(
      state,
      effect(2, {
        type: "tool.summary.upsert",
        toolCall: {
          toolCallId: "tool_1",
          conversationId: "thread_1",
          runId: "run_1",
          name: "lookup",
          status: "completed",
          createdSeq: 2,
          versionSeq: 2,
          input: { query: "eco", options: { limit: 5, exact: true } },
        },
      }),
    );

    const duplicate = applyConversationV2Effect(
      first,
      effect(3, {
        type: "tool.summary.upsert",
        toolCall: {
          toolCallId: "tool_1",
          conversationId: "thread_1",
          runId: "run_1",
          name: "lookup",
          status: "completed",
          createdSeq: 2,
          versionSeq: 2,
          input: { options: { exact: true, limit: 5 }, query: "eco" },
        },
      }),
    );

    expect(duplicate.tools.get("tool_1")).toEqual(first.tools.get("tool_1"));
  });

  test("accepts a bounded tool page after a full payload effect at the same version", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    const previewLines = Array.from({ length: 39 }, (_, index) => `line ${index}`);
    const fullTool = {
      toolCallId: "tool_bounded_page",
      conversationId: "thread_1",
      runId: "run_1",
      name: "Edit",
      status: "completed" as const,
      createdSeq: 2,
      versionSeq: 2,
      input: { fileChange: { previewLines } },
    };
    const withEffect = applyConversationV2Effect(
      state,
      effect(2, { type: "tool.summary.upsert", toolCall: fullTool }),
    );
    const boundedPage: ConversationToolsPage = {
      protocolVersion: 2,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      runId: "run_1",
      readSeq: 2,
      historyRevision: 0,
      tools: [{ ...fullTool, input: { fileChange: { previewLines: previewLines.slice(0, 32) } } }],
      totalCount: 1,
      hasMore: false,
    };

    expect(() => mergeConversationV2ToolPage(withEffect, boundedPage)).not.toThrow();
  });

  test("rejects newer entity updates that change lineage or ownership", () => {
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      runs: [
        {
          runId: "run_lineage",
          conversationId: "thread_1",
          turnId: "turn_1",
          status: "running",
          versionSeq: 1,
          timingQuality: "recorded",
          retryOfRunId: "run_original",
        },
      ],
    });
    const withTool = applyConversationV2Effect(
      state,
      effect(2, {
        type: "tool.summary.upsert",
        toolCall: {
          toolCallId: "tool_guard",
          conversationId: "thread_1",
          runId: "run_lineage",
          agentId: "agent_1",
          name: "lookup",
          status: "running",
          createdSeq: 2,
          versionSeq: 2,
        },
      }),
    );
    const withDetail = applyConversationV2Effect(
      withTool,
      effect(3, {
        type: "detail.upsert",
        detail: {
          itemId: "detail_guard",
          conversationId: "thread_1",
          runId: "run_lineage",
          agentId: "agent_1",
          type: "thinking",
          createdSeq: 3,
          versionSeq: 3,
        },
      }),
    );

    expect(() =>
      applyConversationV2Effect(
        withDetail,
        effect(4, {
          type: "run.upsert",
          run: {
            runId: "run_lineage",
            conversationId: "thread_1",
            turnId: "turn_1",
            status: "completed",
            versionSeq: 4,
            timingQuality: "recorded",
            retryOfRunId: "run_other",
          },
        }),
      ),
    ).toThrow("retry lineage changed");
    expect(() =>
      applyConversationV2Effect(
        withDetail,
        effect(4, {
          type: "tool.summary.upsert",
          toolCall: {
            toolCallId: "tool_guard",
            conversationId: "thread_1",
            runId: "run_lineage",
            agentId: "agent_2",
            name: "lookup",
            status: "running",
            createdSeq: 2,
            versionSeq: 4,
          },
        }),
      ),
    ).toThrow("agent ownership changed");
    expect(() =>
      applyConversationV2Effect(
        withDetail,
        effect(4, {
          type: "detail.upsert",
          detail: {
            itemId: "detail_guard",
            conversationId: "thread_1",
            runId: "run_lineage",
            agentId: "agent_1",
            type: "tool.output",
            createdSeq: 3,
            versionSeq: 4,
          },
        }),
      ),
    ).toThrow("changed type");
  });

  test("rejects message version regressions and deleted-state contradictions", () => {
    expect(() =>
      installConversationV2Bootstrap({
        ...bootstrap,
        messages: [{ ...bootstrap.messages[0], status: "deleted", isDeleted: false }],
      }),
    ).toThrow("bootstrap message is invalid");

    const state = installConversationV2Bootstrap({
      ...bootstrap,
      messages: [{ ...bootstrap.messages[0], contentVersion: 1 }],
    });
    expect(() =>
      applyConversationV2Effect(
        state,
        effect(2, {
          type: "message.finalize",
          messageId: "message_1",
          contentVersion: 0,
          versionSeq: 2,
          status: "final",
        }),
      ),
    ).toThrow("content version regressed");
  });

  test("an older page brings its own messages, runs and tools into the state", () => {
    // `bootstrap()` answers with the newest window; a client that stops there holds one
    // page of a conversation and the Feed draws the rest of the record as if it never
    // happened. Following the cursor is what makes the history whole.
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      messages: [{ ...bootstrap.messages[0], messageId: "message_new", createdSeq: 10, versionSeq: 10 }],
      snapshotSeq: 10,
      hasOlder: true,
      olderCursor: "cursor_1",
    });
    const merged = mergeConversationV2OlderPage(state, {
      protocolVersion: 2,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      readSeq: 10,
      historyRevision: 0,
      messages: [{ ...bootstrap.messages[0], messageId: "message_old", createdSeq: 2, versionSeq: 2 }],
      runs: [
        {
          runId: "run_old",
          conversationId: "thread_1",
          turnId: "turn_old",
          status: "completed",
          versionSeq: 2,
          timingQuality: "recorded",
        },
      ],
      tools: [
        {
          toolCallId: "tool_old",
          conversationId: "thread_1",
          runId: "run_old",
          name: "Bash",
          status: "completed",
          createdSeq: 2,
          versionSeq: 2,
        },
      ],
      hasMore: false,
    });

    expect(merged.messages.get("message_old")?.createdSeq).toBe(2);
    expect(merged.messages.get("message_new")?.createdSeq).toBe(10);
    expect(merged.runs.get("run_old")?.status).toBe("completed");
    expect(merged.tools.get("tool_old")?.name).toBe("Bash");
    // History is read, not replayed: the effect cursor does not move, and the client now
    // knows it holds the whole conversation.
    expect(merged.appliedSeq).toBe(10);
    expect(merged.hasOlder).toBe(false);
    expect(merged.olderCursor).toBeUndefined();
  });

  test("an older page may not run ahead of the effects the client applied", () => {
    const state = installConversationV2Bootstrap(bootstrap);
    expect(() =>
      mergeConversationV2OlderPage(state, {
        protocolVersion: 2,
        storeEpoch: "epoch_1",
        conversationId: "thread_1",
        readSeq: 99,
        historyRevision: 0,
        messages: [],
        hasMore: false,
      }),
    ).toThrow(ConversationV2RendererGapError);
  });

  test("catches up a live effect before merging history and tool pages read at a newer sequence", async () => {
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      snapshotSeq: 5,
      hasOlder: true,
      olderCursor: "cursor_older",
      runs: [
        {
          runId: "run_tools",
          conversationId: "thread_1",
          turnId: "turn_1",
          status: "running",
          versionSeq: 5,
          timingQuality: "recorded",
        },
      ],
    });
    const historyPage = {
      protocolVersion: 2 as const,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      readSeq: 6,
      historyRevision: 0,
      messages: [{ ...bootstrap.messages[0], messageId: "message_older", createdSeq: 2, versionSeq: 2 }],
      runs: [],
      tools: [],
      hasMore: false,
    };
    const toolsPage: ConversationToolsPage = {
      protocolVersion: 2,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      runId: "run_tools",
      readSeq: 6,
      historyRevision: 0,
      tools: [
        {
          toolCallId: "tool_page_1",
          conversationId: "thread_1",
          runId: "run_tools",
          name: "Bash",
          status: "completed",
          createdSeq: 4,
          versionSeq: 5,
        },
      ],
      totalCount: 1,
      hasMore: false,
    };

    expect(() => mergeConversationV2OlderPage(state, historyPage)).toThrow(ConversationV2RendererGapError);
    expect(() => mergeConversationV2ToolPage(state, toolsPage)).toThrow(ConversationV2RendererGapError);

    const caughtUp = await catchUpConversationV2RendererState(
      state,
      6,
      async (afterSeq, throughSeq): Promise<ConversationSyncPage> => {
        expect(afterSeq).toBe(5);
        expect(throughSeq).toBe(6);
        return {
          protocolVersion: 2,
          storeEpoch: "epoch_1",
          conversationId: "thread_1",
          fromSeq: 6,
          throughSeq: 6,
          headSeq: 6,
          hasMore: false,
          effects: [effect(6, { type: "noop", reason: "event committed during page hydration" })],
        };
      },
      8,
    );

    const withHistory = mergeConversationV2OlderPage(caughtUp, historyPage);
    const withTools = mergeConversationV2ToolPage(withHistory, toolsPage);
    expect(withTools.appliedSeq).toBe(6);
    expect(withTools.messages.get("message_older")?.body).toBe("hello");
    expect(withTools.tools.get("tool_page_1")?.status).toBe("completed");
  });

  test("merges independently paged tool summaries without advancing effect state", () => {
    const state = installConversationV2Bootstrap({
      ...bootstrap,
      snapshotSeq: 5,
      runs: [
        {
          runId: "run_tools",
          conversationId: "thread_1",
          turnId: "turn_1",
          status: "completed",
          versionSeq: 2,
          timingQuality: "recorded",
        },
      ],
    });
    const page: ConversationToolsPage = {
      protocolVersion: 2,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      runId: "run_tools",
      readSeq: 5,
      historyRevision: 0,
      tools: [
        {
          toolCallId: "tool_1",
          conversationId: "thread_1",
          runId: "run_tools",
          name: "Bash",
          status: "completed",
          createdSeq: 3,
          versionSeq: 3,
        },
      ],
      totalCount: 2,
      nextCursor: "cursor_tools",
      hasMore: true,
    };
    const merged = mergeConversationV2ToolPage(state, page);
    expect(merged.tools.get("tool_1")?.runId).toBe("run_tools");
    expect(merged.appliedSeq).toBe(5);
    expect(merged.historyRevision).toBe(0);
    expect(() => mergeConversationV2ToolPage(state, { ...page, readSeq: 6 })).toThrow(
      ConversationV2RendererGapError,
    );
  });

  test("a page cannot move a row backwards, and a newer row wins", () => {
    const newer = applyConversationV2Effects(
      installConversationV2Bootstrap({
        ...bootstrap,
        hasOlder: true,
        olderCursor: "cursor_1",
      }),
      [
        effect(2, {
          type: "message.replace",
          messageId: "message_1",
          baseContentVersion: 0,
          nextContentVersion: 1,
          body: "current",
          versionSeq: 2,
        }),
      ],
    );
    // A page read at an older revision of the same row must not resurrect the older body:
    // the client already replayed the newer one from the effect log.
    const withStalePage = mergeConversationV2OlderPage(newer, {
      protocolVersion: 2,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      readSeq: 2,
      historyRevision: 0,
      messages: [{ ...bootstrap.messages[0], contentVersion: 0, body: "stale" }],
      hasMore: false,
    });
    expect(withStalePage.messages.get("message_1")?.body).toBe("current");
    // The opposite direction is a real read: finalizing a message keeps its content version
    // and still moves the row forward, and a client holding a stale "streaming" row has to
    // take the finalized one.
    const advanced = applyConversationV2Effects(newer, [
      effect(3, {
        type: "message.create",
        message: {
          messageId: "message_2",
          conversationId: "thread_1",
          turnId: "turn_2",
          role: "user",
          channel: "answer",
          createdSeq: 3,
          versionSeq: 3,
          contentVersion: 0,
          body: "next",
          status: "final",
          isDeleted: false,
        },
      }),
    ]);
    const finalized = mergeConversationV2OlderPage(advanced, {
      protocolVersion: 2,
      storeEpoch: "epoch_1",
      conversationId: "thread_1",
      readSeq: 3,
      historyRevision: 0,
      messages: [
        {
          ...bootstrap.messages[0],
          contentVersion: 1,
          body: "current",
          status: "final",
          versionSeq: 3,
        },
      ],
      hasMore: false,
    });
    expect(finalized.messages.get("message_1")?.status).toBe("final");
  });

  test("rejects duplicate entity identities in bootstrap", () => {
    expect(() =>
      installConversationV2Bootstrap({
        ...bootstrap,
        messages: [...bootstrap.messages, { ...bootstrap.messages[0] }],
      }),
    ).toThrow("duplicated");
  });
});
