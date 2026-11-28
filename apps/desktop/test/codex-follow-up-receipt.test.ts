import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CodexEventAdapter } from "@eco/runtime";
import { CodexMidTurnPortRegistry } from "../src/main/codex-mid-turn-port";
import { ConversationStore } from "../src/main/conversation-store";
import {
  finalizeAcceptedConversationV2Messages,
  prepareAcceptedConversationV2MessageFinalization,
} from "../src/main/conversation-v2-accepted-finalization";
import { buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import { buildThreadRunProjectionViewModel } from "../src/renderer/conversation-v2-projection-view";
import { buildThreadRunTurnFeedSections } from "../src/renderer/conversation-v2-turn-feed";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
  orderedConversationV2Messages,
} from "../src/renderer/conversation-v2-renderer-state";

const threadId = "thr_codex_follow_up_receipt";
const now = "2026-10-22T06:16:20.000Z";

function setup(storageMode: "legacy_compat" | "v2_only") {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationStore(db, { freshStorageMode: storageMode });
  store.initialize();
  store.saveThread({
    id: threadId,
    title: "Follow-up receipt race",
    prompt: "start",
    workspacePath: "/tmp/project",
    coreKind: "codex",
    status: "running",
    message: "",
    createdAt: now,
    updatedAt: now,
  });
  return { db, store, v2: store.conversationV2() };
}

function accept(store: ConversationStore, commandId: string, text = "same text") {
  const message = store.conversationV2().sendMessage({
    principalId: "desktop-local",
    conversationId: threadId,
    clientCommandId: commandId,
    text,
  });
  const followUp = store.enqueueThreadFollowUp({
    threadId,
    prompt: text,
    conversationMessageId: message.messageId,
  });
  return { message, followUp };
}

function recordPrompt(store: ConversationStore, messageId: string, id = "local-prompt") {
  const message = store.conversationV2().getMessage(threadId, messageId);
  if (!message) throw new Error("Test acceptance is missing.");
  store.appendConversationRuntimeEvent({
    id,
    threadId,
    eventType: "thread.status",
    scope: "main",
    role: "user",
    streamState: "none",
    message: message.body,
    observedAt: now,
    metadata: {
      liveType: "thread.user_prompt",
      conversationV2MessageId: messageId,
      rewindTarget: { activityLineId: `codex-pending:${id}` },
    },
  });
}

function recordEcho(store: ConversationStore, clientId: string, itemId = "codex-user-item") {
  store.appendConversationRuntimeEvent({
    id: `echo:${itemId}`,
    threadId,
    eventType: "message.final",
    scope: "main",
    role: "user",
    streamState: "finalized",
    // Reference expansion can make the runtime body differ from the composer body.
    message: "expanded runtime text",
    streamKey: itemId,
    observedAt: now,
    metadata: {
      liveType: "message.user",
      itemType: "userMessage",
      clientUserMessageId: clientId,
      turnId: "codex-turn",
      rewindTarget: { activityLineId: itemId, userMessageId: itemId },
    },
  });
}

test("a Codex steer retires the old stream and only its receipt splits the Feed", async () => {
  const { db, store, v2 } = setup("v2_only");
  const ports = new CodexMidTurnPortRegistry();
  const native = { threadId: "codex-thread", turnId: "codex-turn" };
  const receiptAt = "2026-10-22T06:16:23.000Z";
  try {
    v2.appendRuntime({
      conversationId: threadId, eventId: "initial", type: "message.created",
      messageId: "initial", turnId: "initial-turn", occurredAt: now,
      payload: { role: "user", channel: "answer", status: "final", body: "start" },
    });
    v2.appendRuntime({
      conversationId: threadId, eventId: "start-run", type: "run.started",
      runId: "run", turnId: "run", occurredAt: now,
      payload: { status: "running" },
    });
    const { message, followUp } = accept(store, "steer", "change direction");
    store.claimThreadFollowUpStreamingPush(threadId, followUp.id);
    const finalize = await prepareAcceptedConversationV2MessageFinalization({
      store: v2, conversationId: threadId, messageIds: [message.messageId],
      resolveAttachments: async (attachments) => [...attachments],
      createPreviews: () => [],
    });
    ports.open(threadId, {
      client: { request: async <T>() => ({ turnId: native.turnId }) as T },
      codexThreadId: native.threadId, turnId: native.turnId,
    });
    const adapter = new CodexEventAdapter({
      now: () => receiptAt,
      resolveEcoThreadId: () => threadId,
      recordThreadRunEvent(event) {
        if (event.role === "user" && event.streamKey && event.metadata?.clientUserMessageId === followUp.id) {
          expect(store.bindLatestUserRunEventToSdkMessage(threadId, event.streamKey, followUp.id)).toBeDefined();
          store.bindCodexForkTurn(threadId, event.streamKey, native.turnId);
          ports.confirmUserMessage(threadId, native.turnId, followUp.id, event.observedAt);
          return;
        }
        store.appendConversationRuntimeEvent({ ...event, runAttemptId: "run", requestId: native.turnId });
      },
    });
    expect(await ports.tryPushUserText(threadId, "change direction", {
      clientUserMessageId: followUp.id,
      consumption: {
        onConsumed: (observedAt) => {
          finalize(observedAt);
          store.markThreadFollowUpStreamingPushApplied(threadId, followUp.id);
        },
        onUnconfirmed: () => { throw new Error("Missing steer receipt"); },
      },
    })).toEqual({ ok: true, turnId: native.turnId });
    const project = () => buildConversationV2OnlyProjection(
      installConversationV2Bootstrap(v2.bootstrap(threadId)),
      { status: "running" },
    );
    adapter.dispatch("item/agentMessage/delta", { ...native, itemId: "old", delta: "half an answer" });
    adapter.dispatch("item/reasoning/summaryTextDelta", { ...native, itemId: "reasoning", delta: "partial thought" });
    expect(project().timeline.map(item => item.text)).toContain("half an answer");
    expect(project().timeline.map(item => item.text)).not.toContain("change direction");

    const userItem = {
      id: "user-item", type: "userMessage", clientId: followUp.id,
      content: [{ type: "text", text: "expanded prompt" }],
    };
    adapter.dispatch("item/completed", { ...native, item: userItem });
    adapter.dispatch("item/agentMessage/delta", { ...native, itemId: "old", delta: "late chunk" });
    adapter.dispatch("item/agentMessage/delta", { ...native, itemId: "new", delta: "new answer" });
    adapter.dispatch("item/completed", { ...native, item: userItem });

    const projection = project();
    expect(projection.timeline.find(item => item.text === "half an answer")).toMatchObject({
      at: receiptAt, eventType: "message.final", metadata: { conversationV2Status: "cancelled" },
    });
    expect(projection.timeline.find(item => item.text === "partial thought")).toMatchObject({
      eventType: "thinking.final", metadata: { conversationV2Status: "cancelled" },
    });
    expect(projection.timeline.find(item => item.text === "new answer")?.eventType).toBe("message.delta");
    expect(v2.getMessage(threadId, message.messageId)).toMatchObject({ occurredAt: receiptAt, status: "final" });

    adapter.dispatch("item/completed", {
      ...native, item: { id: "new", type: "agentMessage", text: "new answer" },
    });
    v2.appendRuntime({
      conversationId: threadId, eventId: "end-run", type: "run.completed",
      runId: "run", turnId: "run", occurredAt: receiptAt, payload: { status: "completed" },
    });
    const completed = project();
    const sections = buildThreadRunTurnFeedSections(
      buildThreadRunProjectionViewModel(completed).mainFeedEntries, completed,
    );
    expect(sections.map(section => section.kind)).toEqual(["entry", "turn", "entry", "turn"]);
    expect(sections[1]).toMatchObject({
      processEntries: expect.arrayContaining([expect.objectContaining({ item: expect.objectContaining({
        text: "half an answer", eventType: "message.final",
      }) })]),
    });
    expect(sections[1]).not.toHaveProperty("finalEntry");
    expect(sections[2]).toMatchObject({ entry: { item: { text: "change direction" } } });
    expect(sections[3]).toMatchObject({ finalEntry: { item: { text: "new answer" } } });
    expect(v2.feedWindow({ conversationId: threadId, skeleton: true }).messages.map(item => item.body))
      .toEqual(["start", "change direction", "new answer"]);
  } finally {
    ports.close(threadId);
    db.close();
  }
});

test("loading an older Codex follow-up repairs its receipt order and abandoned stream", async () => {
  const { db, store, v2 } = setup("v2_only");
  try {
    v2.appendRuntime({
      conversationId: threadId, eventId: "start-run", type: "run.started",
      runId: "run", turnId: "run", occurredAt: now, payload: { status: "running" },
    });
    const { message, followUp } = accept(store, "legacy-steer");
    store.claimThreadFollowUpStreamingPush(threadId, followUp.id);
    store.markThreadFollowUpStreamingPushApplied(threadId, followUp.id);
    recordPrompt(store, message.messageId);
    const finalize = await prepareAcceptedConversationV2MessageFinalization({
      store: v2, conversationId: threadId, messageIds: [message.messageId],
      resolveAttachments: async (attachments) => [...attachments],
      createPreviews: () => [],
    });
    finalize(now);
    const draftAt = "2026-10-22T06:16:21.000Z";
    const draft = store.appendConversationRuntimeEvent({
      id: "legacy-draft", threadId, runAttemptId: "run",
      eventType: "message.delta", scope: "main", role: "assistant", streamState: "streaming",
      streamKey: "unfinished", message: "truncated", observedAt: draftAt,
      metadata: { codexThreadId: "native", turnId: "turn-legacy", itemType: "agentMessage" },
    });
    expect(store.bindLatestUserRunEventToSdkMessage(threadId, "old-item", followUp.id)).toBeDefined();
    store.bindCodexForkTurn(threadId, "old-item", "turn-legacy");
    store.repairConversationV2OnLoad(threadId);
    const messages = v2.bootstrap(threadId).messages;
    expect(messages.find(item => item.body === draft.message)).toMatchObject({
      status: "cancelled", occurredAt: draftAt,
    });
    expect(v2.getMessage(threadId, message.messageId)!.occurredAt! > draftAt).toBe(true);
    const head = v2.head(threadId).lastSeq;
    store.repairConversationV2OnLoad(threadId);
    expect(v2.validateIntegrity(threadId).headSeq).toBe(head);
  } finally {
    db.close();
  }
});

for (const storageMode of ["legacy_compat", "v2_only"] as const) {
  test(`steer receipt before local prompt binds the acceptance once (${storageMode})`, async () => {
    const { db, store, v2 } = setup(storageMode);
    try {
      const { message, followUp } = accept(store, "early");
      expect(store.listConversationRuntimeSources(threadId)).toHaveLength(0);
      const bound = store.bindLatestUserRunEventToSdkMessage(threadId, "item-early", followUp.id);
      expect(bound?.rewindTarget?.userMessageId).toBe("item-early");
      store.bindCodexForkTurn(threadId, "item-early", "turn-early");
      const head = v2.head(threadId).lastSeq;
      expect(store.bindLatestUserRunEventToSdkMessage(threadId, "item-early", followUp.id)).toEqual(bound);
      expect(v2.head(threadId).lastSeq).toBe(head);
      expect(v2.getMessage(threadId, message.messageId)?.status).toBe("queued");
      await finalizeAcceptedConversationV2Messages({
        store: v2,
        conversationId: threadId,
        messageIds: [message.messageId],
        resolveAttachments: async (attachments) => [...attachments],
        createPreviews: () => [],
      });
      expect(v2.listUserMessages(threadId)).toEqual([
        expect.objectContaining({ messageId: message.messageId, body: "same text", status: "final" }),
      ]);
      expect(store.listConversationRuntimeSources(threadId)).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ codexForkTurnId: "turn-early" }),
        }),
      ]);
      expect(v2.validateIntegrity(threadId).headSeq).toBe(v2.head(threadId).lastSeq);
    } finally {
      db.close();
    }
  });

  test(`receipts use client identity with identical prompts and reversed arrival (${storageMode})`, () => {
    const { db, store, v2 } = setup(storageMode);
    try {
      const first = accept(store, "first");
      const second = accept(store, "second");
      recordPrompt(store, first.message.messageId, "first-source");
      recordPrompt(store, second.message.messageId, "second-source");
      expect(
        store.bindLatestUserRunEventToSdkMessage(threadId, "unknown-item", "tfu_unknown"),
      ).toBeUndefined();
      store.bindLatestUserRunEventToSdkMessage(threadId, "item-first", first.followUp.id);
      expect(v2.getMessage(threadId, second.message.messageId)?.historyTarget).toBeUndefined();
      store.bindLatestUserRunEventToSdkMessage(threadId, "item-second", second.followUp.id);
      expect(v2.getMessage(threadId, first.message.messageId)?.historyTarget?.userMessageId).toBe(
        "item-first",
      );
      expect(v2.getMessage(threadId, second.message.messageId)?.historyTarget?.userMessageId).toBe(
        "item-second",
      );
      expect(store.bindLatestUserRunEventToSdkMessage(threadId, "conflict", first.followUp.id)).toEqual(
        expect.objectContaining({
          id: "sdk:item-first",
          rewindTarget: { activityLineId: "sdk:item-first", userMessageId: "item-first" },
        }),
      );
      expect(v2.listUserMessages(threadId)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test(`load repair joins an early receipt by client id after the previous repair version (${storageMode})`, () => {
    const { db, store, v2 } = setup(storageMode);
    try {
      const first = accept(store, "repair-first");
      const second = accept(store, "repair-second");
      v2.appendRuntime({
        conversationId: threadId,
        eventId: "legacy-pending-target",
        type: "message.history_targeted",
        messageId: first.message.messageId,
        occurredAt: now,
        payload: { historyTarget: { activityLineId: "codex-pending:late-source" } },
      });
      v2.markConversationRepaired("codex-user-echo-duplicate", threadId);
      recordEcho(store, first.followUp.id);
      recordPrompt(store, first.message.messageId, "late-source");
      recordPrompt(store, second.message.messageId, "unrelated-same-text");
      expect(v2.listUserMessages(threadId)).toHaveLength(3);
      const beforeRepair = installConversationV2Bootstrap(v2.bootstrap(threadId));
      expect(store.reconcileConversationV2CodexUserMessageDuplicates(threadId)).toEqual({
        scanned: 1,
        repaired: 1,
        ambiguous: 0,
      });
      expect(v2.getMessage(threadId, first.message.messageId)).toMatchObject({
        status: "final",
        body: "same text",
        historyTarget: { activityLineId: "sdk:codex-user-item", userMessageId: "codex-user-item" },
      });
      expect(v2.getMessage(threadId, second.message.messageId)?.historyTarget).toBeUndefined();
      expect(v2.listUserMessages(threadId)).toHaveLength(2);
      const synced = applyConversationV2Effects(
        beforeRepair,
        v2.sync(threadId, beforeRepair.storeEpoch, beforeRepair.appliedSeq).effects,
      );
      expect(orderedConversationV2Messages(synced)).toHaveLength(2);
      expect(
        store.listConversationRuntimeSources(threadId).find((source) => source.id === "late-source"),
      ).toMatchObject({ metadata: { codexForkTurnId: "codex-turn" } });
      const head = v2.head(threadId).lastSeq;
      expect(store.reconcileConversationV2CodexUserMessageDuplicates(threadId).scanned).toBe(0);
      expect(v2.head(threadId).lastSeq).toBe(head);
      expect(v2.validateIntegrity(threadId).headSeq).toBe(head);
    } finally {
      db.close();
    }
  });

  test(`repair preserves a receipt with an unknown explicit client id (${storageMode})`, () => {
    const { db, store, v2 } = setup(storageMode);
    try {
      const { message } = accept(store, "unknown-repair", "expanded runtime text");
      recordPrompt(store, message.messageId);
      recordEcho(store, "tfu_unknown");
      expect(store.reconcileConversationV2CodexUserMessageDuplicates(threadId).repaired).toBe(0);
      expect(v2.listUserMessages(threadId)).toHaveLength(2);
    } finally {
      db.close();
    }
  });
}
