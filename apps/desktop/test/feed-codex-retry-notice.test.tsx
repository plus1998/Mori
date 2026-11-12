import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { CodexEventAdapter } from "@eco/runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationV2RuntimeWriter } from "../src/main/conversation-v2-runtime-writer";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import { ActivityLogView } from "../src/renderer/ActivityLogView";
import { installConversationV2Bootstrap } from "../src/renderer/conversation-v2-renderer-state";

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  store.ensureConversation("retry-feed");
  store.append({
    conversationId: "retry-feed",
    eventId: "run-started",
    runId: "run",
    turnId: "run",
    type: "run.started",
    occurredAt: "2026-11-12T06:00:00Z",
    payload: { status: "running" },
  });
  const writer = new ConversationV2RuntimeWriter(db, store);
  const adapter = new CodexEventAdapter({
    resolveEcoThreadId: () => "retry-feed",
    recordThreadRunEvent: (event) => writer.append({ ...event, runAttemptId: "run" }),
  });
  const render = () =>
    renderToStaticMarkup(
      createElement(ActivityLogView, {
        conversationV2: installConversationV2Bootstrap(store.bootstrap("retry-feed")),
      }),
    );
  return { db, store, writer, adapter, render };
}

function firstRetry(adapter: CodexEventAdapter) {
  adapter.observeRetryLog({
    threadId: "codex-thread",
    turnId: "codex-turn",
    attempt: 1,
    maxRetries: 5,
    delayMs: 314999.9,
    error: "Selected model is at capacity. Please try a different model.",
  });
}

test("a hidden first retry renders its reason and wait time in the actual V2 Feed after rebuild", () => {
  const { db, store, writer, adapter, render } = setup();
  try {
    writer.append({
      id: "ordinary-diagnostic",
      threadId: "retry-feed",
      runAttemptId: "run",
      eventType: "diagnostic",
      role: "system",
      scope: "main",
      streamState: "none",
      message: "Provider informational diagnostic",
      observedAt: "2026-11-12T06:00:01Z",
      metadata: { liveType: "sdk.notice", activityOrigin: "sdk.informational" },
    });
    firstRetry(adapter);
    for (const rebuilt of [false, true]) {
      if (rebuilt) store.rebuildReadModels("retry-feed");
      const html = render();
      expect(html).toContain("Codex 正在自动重试（1/5）：模型容量已满。约 315 秒后重试");
      expect(html).not.toContain("Provider informational diagnostic");
      expect(store.bootstrap("retry-feed").runs[0]?.status).toBe("running");
    }
  } finally {
    db.close();
  }
});

test("the Feed updates to the native second retry and clears the waiting notice after recovery", () => {
  const { db, adapter, writer, render } = setup();
  try {
    firstRetry(adapter);
    adapter.dispatch("error", {
      threadId: "codex-thread",
      turnId: "codex-turn",
      willRetry: true,
      error: {
        message: "Reconnecting... 2/5",
        codexErrorInfo: "serverOverloaded",
        additionalDetails: "Selected model is at capacity. Please try a different model.",
      },
    });
    const waiting = render();
    expect(waiting).toContain("Codex 正在自动重试（2/5）：模型容量已满");
    expect(waiting).not.toContain("Codex 正在自动重试（1/5）");
    writer.append({
      id: "recovered-answer",
      threadId: "retry-feed",
      runAttemptId: "run",
      eventType: "message.final",
      role: "main",
      scope: "main",
      streamState: "final",
      message: "服务恢复，继续处理。",
      observedAt: new Date(Date.now() + 1000).toISOString(),
    });
    const recovered = render();
    expect(recovered).toContain("服务恢复，继续处理。");
    expect(recovered).not.toContain("Codex 正在自动重试");
  } finally {
    db.close();
  }
});
