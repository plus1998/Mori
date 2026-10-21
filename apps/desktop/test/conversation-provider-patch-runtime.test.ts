import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";

test.each([
  "legacy_compat",
  "v2_only",
] as const)("Codex turn binding avoids full-history audits and publishes each effect once (%s)", (storageMode) => {
  const db = new DatabaseSync(":memory:");
  const statements: string[] = [];
  const trackedDb = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          statements.push(sql.replace(/\s+/g, " ").trim());
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const store = new ConversationStore(trackedDb, { freshStorageMode: storageMode });
    store.initialize();
    const threadId = "thread_codex_turn_binding";
    const now = "2026-10-21T00:00:00.000Z";
    store.saveThread({
      id: threadId,
      title: "Codex turn binding",
      prompt: "bind me",
      workspacePath: "/tmp/project",
      status: "running",
      coreKind: "codex",
      message: "",
      createdAt: now,
      updatedAt: now,
    });
    const v2 = store.conversationV2();
    v2.appendBatch(
      Array.from({ length: 1_000 }, (_, index) => ({
        conversationId: threadId,
        eventId: `historical_${index}`,
        type: "noop" as const,
        occurredAt: now,
        payload: { reason: "historical" },
      })),
    );
    const accepted = v2.sendMessage({
      principalId: "desktop-local",
      conversationId: threadId,
      clientCommandId: "send",
      text: "bind me",
    });
    store.appendConversationRuntimeEvent({
      id: "prompt_source",
      threadId,
      eventType: "thread.status",
      scope: "main",
      role: "user",
      streamState: "none",
      message: "bind me",
      observedAt: now,
      metadata: {
        liveType: "thread.user_prompt",
        conversationV2MessageId: accepted.messageId,
        rewindTarget: { activityLineId: "codex-pending:prompt" },
      },
    });

    const committedSeqs: number[] = [];
    v2.onCommitted(({ event }) => committedSeqs.push(event.seq));
    const beforeBinding = v2.head(threadId).lastSeq;
    statements.length = 0;
    expect(store.bindLatestUserRunEventToSdkMessage(threadId, "codex-item")?.rewindTarget).toEqual({
      activityLineId: "sdk:codex-item",
      userMessageId: "codex-item",
    });
    store.bindCodexForkTurn(threadId, "codex-item", "codex-turn");

    const auditReads = statements.filter((sql) =>
      /^SELECT \* FROM conversation_(events|sync_effects)_v2 WHERE conversation_id = \? ORDER BY seq ASC$/i.test(
        sql,
      ),
    );
    expect(auditReads).toEqual([]);
    expect(committedSeqs).toEqual([beforeBinding + 1, beforeBinding + 2, beforeBinding + 3]);
    expect(v2.getMessage(threadId, accepted.messageId)?.historyTarget).toEqual({
      activityLineId: "sdk:codex-item",
      userMessageId: "codex-item",
    });
    expect(store.listConversationRuntimeSources(threadId)).toEqual([
      expect.objectContaining({
        id: "prompt_source",
        metadata: expect.objectContaining({ codexForkTurnId: "codex-turn" }),
      }),
    ]);

    store.bindCodexForkTurn(threadId, "codex-item", "codex-turn");
    expect(v2.head(threadId).lastSeq).toBe(beforeBinding + 3);
    expect(committedSeqs).toHaveLength(3);
    expect(v2.validateIntegrity(threadId).headSeq).toBe(beforeBinding + 3);
  } finally {
    db.close();
  }
});
