import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";
import { finalizeAcceptedConversationV2Messages } from "../src/main/conversation-v2-accepted-finalization";
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
      expect(() => store.bindLatestUserRunEventToSdkMessage(threadId, "conflict", first.followUp.id)).toThrow(
        "conflicts",
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
