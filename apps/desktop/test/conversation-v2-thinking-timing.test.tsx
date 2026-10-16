import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { stableHash } from "@eco/shared";
import { createElement } from "react";
import { appendProviderEventToConversationV2 } from "../src/main/conversation-v2-provider-events";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { ActivityLogView, buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
} from "../src/renderer/conversation-v2-renderer-state";
import type { ThreadRunEvent } from "../src/shared/thread-run-events";
import { renderLocalized } from "./i18n-test";

const start = "2026-10-16T00:00:00.000Z";
const firstContent = "2026-10-16T00:00:02.000Z";
const end = "2026-10-16T00:00:08.000Z";
const conversationId = "thinking_timing";

function thinkingEvent(final: boolean): ThreadRunEvent {
  return {
    id: final ? "thinking-final" : "thinking-delta",
    threadId: conversationId,
    sequence: final ? 2 : 1,
    eventType: final ? "thinking.final" : "thinking.delta",
    scope: "main",
    streamState: final ? "finalized" : "streaming",
    role: "thinking",
    message: final ? "完整的思考正文" : "完整的",
    streamKey: "thinking-block",
    runAttemptId: "run_1",
    observedAt: final ? end : firstContent,
    metadata: { thinkingStartedAt: start },
  };
}

function renderFeed(store: ConversationV2Store) {
  return renderLocalized(
    createElement(ActivityLogView, {
      conversationV2: installConversationV2Bootstrap(store.bootstrap(conversationId)),
      thinkingDisplayMode: "collapsed",
    }),
    "zh-CN",
  );
}

test("thinking duration survives provider conversion, live sync, reload and read-model replay", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    appendProviderEventToConversationV2(store, thinkingEvent(false));
    const streaming = installConversationV2Bootstrap(store.bootstrap(conversationId));
    expect([...streaming.messages.values()][0]?.startedAt).toBe(start);
    appendProviderEventToConversationV2(store, thinkingEvent(true));
    const completed = applyConversationV2Effects(
      streaming,
      store.sync(conversationId, streaming.storeEpoch, streaming.appliedSeq).effects,
    );
    const item = buildConversationV2OnlyProjection(completed).timeline[0];
    expect(item?.metadata?.thinkingStartedAt).toBe(start);
    expect(item?.at).toBe(end);
    expect(
      renderLocalized(
        createElement(ActivityLogView, { conversationV2: completed, thinkingDisplayMode: "collapsed" }),
        "zh-CN",
      ),
    ).toContain('已思考<span class="run-log-thinking-elapsed">8s</span>');
    expect(renderFeed(store)).toContain('已思考<span class="run-log-thinking-elapsed">8s</span>');
    store.rebuildReadModels(conversationId);
    expect(renderFeed(store)).toContain('已思考<span class="run-log-thinking-elapsed">8s</span>');
    store.validateIntegrity(conversationId);
  } finally {
    db.close();
  }
});

test("old databases recover the recorded thinking interval without changing event or effect hashes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    store.append({
      conversationId,
      eventId: "created",
      type: "message.created",
      messageId: "thinking",
      turnId: "turn",
      occurredAt: firstContent,
      payload: { role: "assistant", channel: "thinking", body: "思考正文", status: "streaming" },
    });
    store.append({
      conversationId,
      eventId: "finalized",
      type: "message.finalized",
      messageId: "thinking",
      turnId: "turn",
      occurredAt: end,
      payload: { status: "final" },
    });
    const rows = db.prepare("SELECT seq, effect_json FROM conversation_sync_effects_v2").all() as {
      seq: number;
      effect_json: string;
    }[];
    for (const row of rows) {
      const effect = JSON.parse(row.effect_json);
      if (effect.type !== "message.create") continue;
      delete effect.message.startedAt;
      db.prepare(
        "UPDATE conversation_sync_effects_v2 SET effect_json = ?, effect_hash = ? WHERE seq = ?",
      ).run(JSON.stringify(effect), stableHash(effect), row.seq);
    }
    db.exec("ALTER TABLE conversation_messages_v2 DROP COLUMN started_at");
    const hashes = db.prepare("SELECT effect_hash FROM conversation_sync_effects_v2 ORDER BY seq").all();
    const reopened = new ConversationV2Store(db);
    reopened.initialize();
    expect(reopened.getMessage(conversationId, "thinking")?.startedAt).toBe(firstContent);
    expect(renderFeed(reopened)).toContain('已思考<span class="run-log-thinking-elapsed">6s</span>');
    expect(db.prepare("SELECT effect_hash FROM conversation_sync_effects_v2 ORDER BY seq").all()).toEqual(
      hashes,
    );
    reopened.validateIntegrity(conversationId);
    const empty = installConversationV2Bootstrap({
      ...reopened.bootstrap(conversationId),
      messages: [],
      snapshotSeq: 0,
      runs: [],
      turns: [],
    });
    const synced = applyConversationV2Effects(
      empty,
      reopened.sync(conversationId, empty.storeEpoch, 0).effects,
    );
    expect([...synced.messages.values()][0]?.startedAt).toBe(firstContent);
  } finally {
    db.close();
  }
});

test("a final-only thinking message without recorded start does not borrow the request duration", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationV2Store(db);
    store.initialize();
    appendProviderEventToConversationV2(store, { ...thinkingEvent(true), metadata: {} });
    const state = installConversationV2Bootstrap(store.bootstrap(conversationId));
    const row = buildConversationV2OnlyProjection(state).timeline[0];
    expect(row?.metadata?.thinkingStartedAt).toBe(end);
    const markup = renderFeed(store);
    expect(markup).toContain("已思考");
    expect(markup).not.toContain("run-log-thinking-elapsed");
  } finally {
    db.close();
  }
});
