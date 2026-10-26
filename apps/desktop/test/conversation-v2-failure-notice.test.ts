import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationStore } from "../src/main/conversation-store";
import { migrateThreadFailureNotices } from "../src/main/conversation-v2-failure-notice-migration";
import {
  ConversationV2RuntimeWriter,
  conversationV2ProviderReceipt,
} from "../src/main/conversation-v2-runtime-writer";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { ActivityLogView, buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import {
  buildProjectionDisplayTimelineItems,
  projectionItemToDetailBlock,
} from "../src/renderer/conversation-v2-projection-view";
import {
  applyConversationV2Effects,
  installConversationV2Bootstrap,
} from "../src/renderer/conversation-v2-renderer-state";
import type { ThreadRunEventInput } from "../src/shared/thread-run-events";

const reason =
  "Codex 0.163 的原生子代理继承主会话的远程压缩设置，子代理「explore」所选模型「sk-deepseek-t156tt / deepseek-flash」与主模型设置不一致。请在候选模型中统一远程压缩开关，或关闭该子代理后重试。";

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  store.append({
    conversationId: "thread",
    eventId: "prompt",
    messageId: "prompt",
    turnId: "run",
    type: "message.created",
    occurredAt: "2026-10-26T02:07:29.143Z",
    payload: { role: "user", channel: "answer", body: "看看有没有影响", status: "final" },
  });
  store.append({
    conversationId: "thread",
    eventId: "run-start",
    runId: "run",
    turnId: "run",
    type: "run.started",
    occurredAt: "2026-10-26T02:07:29.390Z",
    payload: { status: "running" },
  });
  store.append({
    conversationId: "thread",
    eventId: "run-failed",
    runId: "run",
    turnId: "run",
    type: "run.failed",
    occurredAt: "2026-10-26T02:07:29.436Z",
    payload: { status: "failed" },
  });
  return { db, store, writer: new ConversationV2RuntimeWriter(db, store) };
}

function blocked(overrides: Partial<ThreadRunEventInput> = {}): ThreadRunEventInput {
  return {
    threadId: "thread",
    id: "blocked",
    runAttemptId: "run",
    eventType: "thread.status",
    role: "system",
    scope: "main",
    streamState: "none",
    message: reason,
    observedAt: "2026-10-26T02:07:29.445Z",
    metadata: { activityOrigin: "eco.thread_blocked", liveType: "thread.blocked" },
    ...overrides,
  };
}

function project(store: ConversationV2Store) {
  return buildConversationV2OnlyProjection(installConversationV2Bootstrap(store.bootstrap("thread")));
}

test("startup blocker reaches the live Feed, reopen and replay with the full reason", () => {
  const { db, store, writer } = setup();
  try {
    let state = installConversationV2Bootstrap(store.bootstrap("thread"));
    writer.append(blocked());
    state = applyConversationV2Effects(
      state,
      store.sync("thread", state.storeEpoch, state.appliedSeq).effects,
    );
    const live = buildConversationV2OnlyProjection(state);
    const notice = live.timeline.find((item) => item.eventType === "thread.status");
    if (!notice) throw new Error("Startup blocker is missing from the live Feed.");
    expect(notice).toMatchObject({
      text: reason,
      role: "system",
      runAttemptId: "run",
      at: blocked().observedAt,
      metadata: { liveType: "thread.blocked", activityOrigin: "eco.thread_blocked" },
    });
    expect(projectionItemToDetailBlock(notice)).toMatchObject({
      kind: "api-error",
      title: "执行失败",
      message: reason,
    });
    const html = renderToStaticMarkup(createElement(ActivityLogView, { conversationV2: state }));
    expect(html).toContain("远程压缩设置");
    expect(html).toContain("或关闭该子代理后重试");
    expect(html).toContain('role="alert"');
    expect(project(store).timeline).toEqual(live.timeline);
    const head = store.head("thread").lastSeq;
    expect(writer.append(blocked()).duplicate).toBe(true);
    expect(store.head("thread").lastSeq).toBe(head);
    store.rebuildReadModels("thread");
    expect(project(store).timeline).toEqual(live.timeline);
  } finally {
    db.close();
  }
});

test("a blocker without a started run and a plan execution failure remain notices", () => {
  const { db, store, writer } = setup();
  try {
    writer.append(blocked({ runAttemptId: undefined }));
    writer.append(
      blocked({
        id: "plan-failed",
        message: "计划执行失败：工作目录不可用",
        metadata: { liveType: "thread.execution_failed" },
      }),
    );
    expect(
      project(store)
        .timeline.filter((item) => item.eventType === "thread.status")
        .map((item) => projectionItemToDetailBlock(item)),
    ).toMatchObject([
      { kind: "api-error", message: reason },
      { kind: "api-error", message: "计划执行失败：工作目录不可用" },
    ]);
  } finally {
    db.close();
  }
});

test("API failure wrappers and empty blockers do not create duplicate notices", () => {
  const { db, store, writer } = setup();
  try {
    writer.append(
      blocked({
        id: "api",
        eventType: "api.error",
        message: "【连接失败】HTTP 503：上游不可用",
        metadata: { liveType: "thread.api_error" },
      }),
    );
    writer.append(blocked({ message: "API Error: 503 上游不可用，可在下方继续对话" }));
    writer.append(blocked({ id: "empty", message: " " }));
    const rows = buildProjectionDisplayTimelineItems(project(store).timeline);
    expect(rows.filter((item) => item.eventType === "api.error")).toHaveLength(1);
    expect(rows.some((item) => item.eventType === "thread.status")).toBe(false);
  } finally {
    db.close();
  }
});

test("startup restores historical blocker receipts once and rebuild keeps the notice", () => {
  const { db, store } = setup();
  try {
    store.append(
      conversationV2ProviderReceipt({ ...blocked(), sequence: 0 }, "runtime-input", {
        includeMessageId: false,
      }),
    );
    expect(project(store).timeline.filter((item) => item.eventType === "thread.status")).toHaveLength(0);
    const head = store.head("thread").lastSeq;
    new ConversationStore(db).initialize();
    expect(store.head("thread").lastSeq).toBe(head + 1);
    expect(project(store).timeline.find((item) => item.eventType === "thread.status")?.text).toBe(reason);
    expect(migrateThreadFailureNotices(db, store)).toBe(0);
    store.rebuildReadModels("thread");
    expect(project(store).timeline.find((item) => item.eventType === "thread.status")?.text).toBe(reason);
  } finally {
    db.close();
  }
});

test("historical upgrade skips normalized notices and rolls back invalid receipts", () => {
  const { db, store, writer } = setup();
  try {
    writer.append(blocked());
    const head = store.head("thread").lastSeq;
    expect(migrateThreadFailureNotices(db, store)).toBe(0);
    expect(store.head("thread").lastSeq).toBe(head);
    db.prepare("DELETE FROM conversation_store_meta_v2 WHERE key = 'thread_failure_notices_v1'").run();
    store.append(
      conversationV2ProviderReceipt(
        { ...blocked({ id: "bad", runAttemptId: "missing" }), sequence: 0 },
        "runtime-input",
        { includeMessageId: false },
      ),
    );
    expect(() => migrateThreadFailureNotices(db, store)).toThrow(/has not been started/);
    expect(
      db.prepare("SELECT 1 FROM conversation_store_meta_v2 WHERE key = 'thread_failure_notices_v1'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
