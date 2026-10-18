import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";
import { buildThreadRunProjectionRequestSpans } from "../src/main/conversation-v2-runtime-projection";
import type { ThreadRunEventInput } from "../src/shared/thread-run-events";

test("lightweight panel reads preserve thinking, tool-writing, errors and terminal timing", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationStore(db, { freshStorageMode: "v2_only" });
    store.initialize();
    store.saveThread({
      id: "thread",
      title: "Panel timing",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "running",
      message: "",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      coreKind: "codex",
    });
    store.conversationV2().appendRuntime({
      conversationId: "thread",
      eventId: "run-start",
      runId: "run",
      turnId: "turn",
      type: "run.started",
      occurredAt: "2026-10-01T00:00:00.000Z",
      payload: { status: "running" },
    });
    let index = 0;
    const append = (event: Partial<ThreadRunEventInput>) =>
      store.appendConversationRuntimeEvent({
        id: `input-${index}`,
        threadId: "thread",
        eventType: "request.started",
        scope: "main",
        streamState: "none",
        role: "planner",
        message: "",
        requestId: "request",
        runAttemptId: "run",
        observedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index++)).toISOString(),
        ...event,
      });
    const spans = () => {
      const expected = buildThreadRunProjectionRequestSpans({
        events: store.listConversationRuntimeSources("thread"),
        threadStatus: store.getThread("thread")!.status,
        agents: store.listAgentInstances("thread"),
      });
      const actual = store.getConversationV2ProjectionExtras("thread")!.requestSpans;
      expect(actual).toEqual(expected);
      return actual;
    };
    append({ metadata: { source: "gateway", providerRequestId: "provider-request" } });
    expect(spans()[0]).toMatchObject({ source: "gateway", providerRequestId: "provider-request" });
    append({
      id: "thinking",
      eventType: "thinking.delta",
      role: "thinking",
      streamState: "placeholder",
      streamKey: "thinking",
      message: " \u3000",
      metadata: { thinkingStartedAt: "2026-10-01T00:00:00.500Z" },
    });
    expect(spans()[0]?.pendingThinkingSince).toBe("2026-10-01T00:00:00.500Z");
    append({
      id: "thinking",
      eventType: "thinking.delta",
      role: "thinking",
      streamState: "streaming",
      streamKey: "thinking",
      message: "思考内容",
    });
    expect(spans()[0]?.pendingThinkingSince).toBeUndefined();
    append({ eventType: "message.final", message: "large answer ".repeat(10_000), streamState: "finalized" });
    append({
      eventType: "tool.writing",
      requestId: undefined,
      message: "Write",
      metadata: { toolCallId: "call", toolWriting: { name: "Write", kind: "file", target: "/tmp/a" } },
    });
    expect(spans()[0]?.writingTool).toMatchObject({ name: "Write", kind: "file", target: "/tmp/a" });
    append({
      eventType: "tool.started",
      requestId: undefined,
      message: "tool payload ".repeat(10_000),
      metadata: {
        tool: { name: "Write", toolUseId: "call", status: "started", detail: "x".repeat(100_000) },
      },
    });
    expect(spans()[0]?.writingTool).toBeUndefined();
    append({ eventType: "request.failed", message: "provider failed", metadata: {} });
    expect(spans()[0]?.error).toBe("provider failed");
    append({ requestId: "other", metadata: { source: "sdk" } });
    append({
      requestId: "other",
      eventType: "api.error",
      message: "raw error",
      metadata: { apiError: { message: "structured error" } },
    });
    expect(spans().find((span) => span.requestId === "other")?.error).toBe("structured error");
    append({ requestId: "open" });
    append({ requestId: undefined, eventType: "thread.status", message: "ended" });
    store.updateThread("thread", { status: "idle", message: "" });
    expect(spans().find((span) => span.requestId === "open")).toMatchObject({ status: "completed" });
  } finally {
    db.close();
  }
});
