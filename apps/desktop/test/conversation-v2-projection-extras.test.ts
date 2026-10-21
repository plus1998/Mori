import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/main/conversation-store";
import { buildThreadRunProjectionRequestSpans } from "../src/main/conversation-v2-runtime-projection";
import { projectUsageLedger } from "../src/main/usage-ledger";
import type { ThreadRunEventInput } from "../src/shared/thread-run-events";

test("historical planner reads as main without rewriting ledger identities or snapshots", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new ConversationStore(db, { freshStorageMode: "v2_only" });
    store.initialize();
    store.saveThread({
      id: "history",
      title: "Old roles",
      prompt: "hello",
      workspacePath: "/tmp/project",
      status: "idle",
      message: "",
      coreKind: "codex",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    store.conversationV2().appendRuntime({
      conversationId: "history",
      eventId: "old-main-agent",
      agentId: "planner:old-attempt",
      agentInstanceId: "planner:old-attempt",
      type: "agent.completed",
      occurredAt: "2026-10-01T00:00:00.000Z",
      payload: {
        authority: "lifecycle",
        role: "planner",
        kind: "planner",
        status: "stopped",
        startedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    const immutableEvents = () =>
      db
        .prepare(
          "SELECT event_id, event_hash, payload_json FROM conversation_events_v2 WHERE conversation_id = ? ORDER BY seq",
        )
        .all("history");
    const originalEvents = immutableEvents();
    expect(store.listAgentInstances("history")).toMatchObject([
      { agentId: "planner:old-attempt", role: "main", kind: "main" },
    ]);
    for (const [role, inputTokens] of [
      ["planner", 10],
      ["main", 20],
    ] as const) {
      store.appendUsageLedgerEvent({
        id: `usage-${role}`,
        idempotencyKey: `usage-${role}`,
        threadId: "history",
        role,
        source: "sdk",
        sourceEventId: `event-${role}`,
        usageKind: "request_final",
        inputTokens,
        outputTokens: 1,
        cacheReadTokens: 2,
        cacheCreationTokens: 3,
        observedAt: "2026-10-01T00:00:00.000Z",
        agentId: "planner:old-attempt",
        attribution: { status: "attributed", agentId: "planner:old-attempt" },
      });
    }
    const usage = {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 2,
      cacheCreationTokens: 3,
      ecoCostUsd: 0.1,
    };
    const gauge = {
      role: "planner",
      occupied: 80,
      limit: 100,
      occupancyPct: 80,
      limitsResolved: true,
      segments: [],
    };
    const snapshot = {
      billing: {
        totalTokens: { input: 30, output: 2, cacheRead: 4, cacheCreation: 6 },
        byRole: { main: { ...usage, inputTokens: 20 }, planner: usage },
        byModel: [{ modelId: "model", roles: ["planner", "main"], ...usage }],
        sourceBreakdown: { sdk: { byRole: { planner: usage }, byModel: [] } },
      },
      context: {
        ...gauge,
        displayRole: "planner",
        updatedAt: 1,
        roles: [gauge],
        instances: [{ ...gauge, agentId: "planner:old-attempt", updatedAt: 1 }],
      },
    };
    store.conversationV2().saveProjectionSnapshot("history", snapshot);
    const before = store.conversationV2().listUsageLedgerEventRows("history");
    const extras = store.getConversationV2ProjectionExtras("history")!;
    expect(extras.billing?.byRole).toEqual({
      main: {
        ...usage,
        inputTokens: 30,
        outputTokens: 2,
        cacheReadTokens: 4,
        cacheCreationTokens: 6,
        ecoCostUsd: 0.2,
      },
    });
    expect(extras.billing?.byModel?.[0]?.roles).toEqual(["main"]);
    expect(extras.billing?.sourceBreakdown?.sdk?.byRole).toEqual({ main: usage });
    expect(extras.context?.displayRole).toBe("main");
    expect(extras.context?.roles?.[0]?.role).toBe("main");
    expect(extras.context?.instances?.[0]).toMatchObject({ role: "main", agentId: "planner:old-attempt" });
    const ledger = store.listUsageLedgerEvents("history");
    expect(ledger.map((item) => item.role)).toEqual(["main", "main"]);
    expect(projectUsageLedger(ledger).byRole).toMatchObject({ main: { inputTokens: 30 } });
    expect(store.conversationV2().listUsageLedgerEventRows("history")).toEqual(before);
    expect(store.conversationV2().getProjectionSnapshot("history")).toEqual(snapshot);
    expect(immutableEvents()).toEqual(originalEvents);
  } finally {
    db.close();
  }
});

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
        role: "main",
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
