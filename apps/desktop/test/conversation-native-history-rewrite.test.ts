import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConversationStore } from "../src/main/conversation-store";
import { conversationV2ProviderMessageId } from "../src/main/conversation-v2-provider-events";

for (const storageMode of ["legacy_compat", "v2_only"] as const) {
  for (const operation of ["rewind", "discard"] as const) {
    for (const lateAttribution of [false, true]) {
      test(`${storageMode} ${operation} uses native receipt identities (late attribution: ${lateAttribution})`, async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-native-history-"));
        const store = await createConversationStore(path.join(directory, "test.sqlite"), {
          freshStorageMode: storageMode,
          requiredStorageMode: storageMode,
        });
        const threadId = "thr_native_history";
        const now = "2026-10-21T00:00:00.000Z";
        store.saveThread({
          id: threadId,
          title: "native history",
          prompt: "first",
          workspacePath: directory,
          coreKind: "codex",
          status: "completed",
          message: "",
          createdAt: now,
          updatedAt: now,
        });
        const v2 = store.conversationV2();
        store.upsertRunAttempt({
          threadId,
          attemptId: "run_history",
          phase: "execution",
          retryIndex: 0,
          status: "running",
          startedAt: now,
        });
        const appendPrompt = (id: string) => {
          const messageId = `accepted_${id}`;
          v2.append({
            conversationId: threadId,
            eventId: `create_${id}`,
            type: "message.created",
            turnId: id,
            messageId,
            occurredAt: now,
            payload: { role: "user", body: id, status: "final" },
          });
          return store.appendConversationRuntimeEvent({
            id,
            threadId,
            eventType: "thread.status",
            scope: "main",
            role: "user",
            streamState: "none",
            streamKey: `sdk:${id}`,
            message: id,
            observedAt: now,
            metadata: {
              liveType: "thread.user_prompt",
              conversationV2MessageId: messageId,
              rewindTarget: { activityLineId: `sdk:${id}`, userMessageId: id },
            },
          });
        };
        const first = appendPrompt("first");
        const target = appendPrompt("target");
        const answer = store.appendConversationRuntimeEvent({
          id: "answer",
          threadId,
          runAttemptId: "run_history",
          eventType: "message.final",
          scope: "main",
          role: "assistant",
          streamState: "finalized",
          streamKey: "answer",
          message: "answer",
          observedAt: now,
        });
        store.appendConversationRuntimeEvent({
          id: "empty_thinking",
          threadId,
          runAttemptId: "run_history",
          eventType: "thinking.delta",
          scope: "main",
          role: "assistant",
          streamState: "placeholder",
          streamKey: "empty_thinking",
          message: "",
          observedAt: now,
        });
        const future = appendPrompt("future");
        // Both older and target receipts receive attribution after later output.
        // Their version sequence must not become a destructive history boundary.
        for (const input of lateAttribution ? [first, target] : []) {
          v2.appendProviderInputPatch({
            conversationId: threadId,
            eventId: `patch_${input.id}`,
            sourceEventKey: `patch_${input.id}`,
            occurredAt: now,
            inputIds: [input.id],
            patch: { metadataMerge: { historyOrderProbe: true } },
            reason: "late-attribution",
          });
        }
        const summary =
          operation === "rewind"
            ? store.rewindThreadToActivityLine(threadId, "sdk:target")
            : store.discardThreadTurnFromActivityLine(threadId, "sdk:target");
        expect(summary.cutoffRunSequence).toBe(target.sequence);
        expect(v2.getMessage(threadId, "accepted_first")?.isDeleted).toBe(false);
        for (const removed of [target, answer, future]) {
          const messageId = conversationV2ProviderMessageId(removed);
          if (!messageId) throw new Error("Expected a native message identity in the fixture.");
          expect(v2.getMessage(threadId, messageId)?.isDeleted).toBe(true);
        }
        expect(v2.listUserMessages(threadId).map((message) => message.messageId)).toEqual(["accepted_first"]);
        expect(store.listConversationRuntimeSources(threadId).map((source) => source.id)).toEqual(["first"]);
        expect(v2.head(threadId).historyRevision).toBe(1);
        v2.rebuildReadModels(threadId);
        expect(v2.getMessage(threadId, "accepted_target")?.isDeleted).toBe(true);
        expect(store.listConversationRuntimeSources(threadId).map((source) => source.id)).toEqual(["first"]);
      });
    }
  }
}
