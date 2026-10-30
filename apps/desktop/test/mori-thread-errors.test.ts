import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { ConversationV2Store } from "../src/main/conversation-v2-store";
import {
  currentThreadError,
  readThreadErrors,
  redactThreadError,
  threadErrorDetail,
} from "../src/main/mori-thread-errors";
import type { ThreadSummary } from "../src/shared/ipc";

function setup() {
  const db = new DatabaseSync(":memory:");
  const store = new ConversationV2Store(db);
  store.initialize();
  const thread: ThreadSummary = {
    id: "work",
    title: "work",
    prompt: "private prompt",
    workspacePath: "/test/project",
    status: "blocked",
    message: "连接上游模型 API 失败。",
    createdAt: "2026-10-29T00:00:00Z",
    updatedAt: "2026-10-29T00:00:00Z",
  };
  for (const conversationId of ["work", "other"]) {
    store.appendRuntime({
      occurredAt: "2026-10-29T00:00:00.000Z",
      conversationId,
      eventId: `prompt-${conversationId}`,
      messageId: `prompt-${conversationId}`,
      turnId: `turn-${conversationId}`,
      type: "message.created",
      payload: { role: "user", channel: "answer", body: "private prompt", status: "final" },
    });
    store.appendRuntime({
      occurredAt: "2026-10-29T00:00:00.000Z",
      conversationId,
      eventId: `run-${conversationId}`,
      runId: `run-${conversationId}`,
      turnId: `turn-${conversationId}`,
      type: "run.started",
      payload: { status: "running" },
    });
  }
  const notice = (id: string, body: string, conversationId = "work") =>
    store.appendRuntime({
      occurredAt: "2026-10-29T00:00:00.000Z",
      conversationId,
      eventId: id,
      messageId: id,
      runId: `run-${conversationId}`,
      turnId: `turn-${conversationId}`,
      type: "message.created",
      payload: { role: "system", channel: "system", body, status: "final" },
    });
  return { db, store, thread, notice };
}

test("blocked diagnostics find system errors omitted by transcript and survive projection rebuild", () => {
  const { db, store, thread, notice } = setup();
  try {
    notice(
      "connection",
      "HTTP 503 fetch failed ECONNREFUSED https://user:password@private.example/v1?key=hidden",
    );
    notice("other-secret", "OTHER_CONVERSATION_SECRET", "other");
    for (let i = 0; i < 25; i++)
      store.appendRuntime({
        occurredAt: "2026-10-29T00:00:00.000Z",
        conversationId: "work",
        eventId: `answer-${i}`,
        messageId: `answer-${i}`,
        runId: "run-work",
        turnId: "turn-work",
        type: "message.created",
        payload: { role: "assistant", channel: "answer", body: `answer ${i}`, status: "final" },
      });
    expect(store.transcriptPage("work").messages.every((message) => message.role !== "system")).toBe(true);
    const diagnostics = readThreadErrors(thread, store);
    expect(diagnostics.currentError?.category).toBe("model_connection");
    expect(diagnostics.recentErrors).toHaveLength(1);
    expect(diagnostics.recentErrors[0]).toMatchObject({
      source: "notice",
      runId: "run-work",
      detail: { category: "model_connection", httpStatus: 503, code: "ECONNREFUSED" },
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /password|private\.example|private prompt|OTHER_CONVERSATION_SECRET/,
    );
    store.rebuildReadModels("work");
    expect(readThreadErrors(thread, store)).toEqual(diagnostics);
  } finally {
    db.close();
  }
});

test("failed MCP tool diagnostics exclude inputs and arbitrary output fields", () => {
  const { db, store, thread } = setup();
  try {
    store.appendRuntime({
      occurredAt: "2026-10-29T00:00:00.000Z",
      conversationId: "work",
      eventId: "tool-start",
      runId: "run-work",
      toolCallId: "mcp-call",
      type: "tool.started",
      payload: { name: "mcp__mori_tasks__mori_list_todos", input: { token: "INPUT_SECRET" } },
    });
    store.appendRuntime({
      occurredAt: "2026-10-29T00:00:00.000Z",
      conversationId: "work",
      eventId: "tool-fail",
      runId: "run-work",
      toolCallId: "mcp-call",
      type: "tool.failed",
      payload: {
        name: "mcp__mori_tasks__mori_list_todos",
        output: {
          error: { message: "HTTP 400 missing or invalid MCP session id; Mcp-Session-Id: SESSION_SECRET" },
          request: { authorization: "OUTPUT_SECRET" },
        },
      },
    });
    const diagnostics = readThreadErrors(thread, store);
    expect(diagnostics.recentErrors[0]).toMatchObject({
      source: "tool",
      toolName: "mcp__mori_tasks__mori_list_todos",
      detail: { category: "mcp_session", httpStatus: 400 },
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(
      /INPUT_SECRET|SESSION_SECRET|OUTPUT_SECRET|authorization/,
    );
    expect(diagnostics.currentError?.category).toBe("model_connection");
  } finally {
    db.close();
  }
});

test("JSON MCP text envelopes use the error allowlist; absent and oversized errors stay explicit", () => {
  const { db, store, thread } = setup();
  try {
    const outputs = [
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: { message: "HTTP 404 MCP session not found" },
              request: { body: "ENVELOPE_SECRET" },
            }),
          },
        ],
      },
      { request: { body: "ARBITRARY_SECRET" } },
      { error: "OVERSIZED_SECRET".repeat(2000) },
    ];
    for (const [i, output] of outputs.entries()) {
      store.appendRuntime({
        occurredAt: "2026-10-29T00:00:00.000Z",
        conversationId: "work",
        eventId: `start-${i}`,
        runId: "run-work",
        toolCallId: `tool-${i}`,
        type: "tool.started",
        payload: { name: "mcp_tool" },
      });
      store.appendRuntime({
        occurredAt: "2026-10-29T00:00:00.000Z",
        conversationId: "work",
        eventId: `fail-${i}`,
        runId: "run-work",
        toolCallId: `tool-${i}`,
        type: "tool.failed",
        payload: { name: "mcp_tool", output },
      });
    }
    const result = readThreadErrors(thread, store);
    expect(result.recentErrors.find((error) => error.id === "tool-0")?.detail).toMatchObject({
      category: "mcp_session",
      httpStatus: 404,
    });
    for (const id of ["tool-1", "tool-2"])
      expect(result.recentErrors.find((error) => error.id === id)).toMatchObject({
        detail: null,
        detailUnavailable: expect.any(String),
      });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  } finally {
    db.close();
  }
});

test("successful or running threads retain historical failures without a current error", () => {
  const { db, store, thread, notice } = setup();
  try {
    notice("old-failure", "MCP session not found HTTP 404");
    store.appendRuntime({
      occurredAt: "2026-10-29T00:00:00.000Z",
      conversationId: "work",
      eventId: "completed",
      runId: "run-work",
      type: "run.completed",
      payload: { status: "completed" },
    });
    for (const status of ["completed", "running"] as const) {
      const result = readThreadErrors({ ...thread, status, message: "old stale summary" }, store);
      expect(result.currentError).toBeNull();
      expect(result.currentErrorMissing).toBe(false);
      expect(result.latestRun).toMatchObject({ runId: "run-work", status: "completed" });
      expect(result.recentErrors[0]?.detail?.category).toBe("mcp_session");
    }
    expect(readThreadErrors({ ...thread, message: "" }, store).currentErrorMissing).toBe(true);
    expect(currentThreadError({ status: "failed", message: "" })).toBeNull();
    expect(threadErrorDetail("unrecognized provider failure", "notice").category).toBe("unknown");
  } finally {
    db.close();
  }
});

test("diagnostics are bounded and do not report deleted notices", () => {
  const { db, store, thread, notice } = setup();
  try {
    for (let i = 0; i < 12; i++) notice(`notice-${i}`, `HTTP 503 ${"x".repeat(18000)}`);
    notice("deleted", "DELETED_SECRET");
    store.appendRuntime({
      occurredAt: "2026-10-29T00:00:00.000Z",
      conversationId: "work",
      eventId: "delete",
      messageId: "deleted",
      type: "message.tombstoned",
      payload: {},
    });
    const result = readThreadErrors(thread, store);
    expect(result.recentErrors).toHaveLength(10);
    expect(result.hasMore).toBe(true);
    expect(
      result.recentErrors.every((error) => error.detail?.message.length === 2000 && error.detail.truncated),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("DELETED_SECRET");
    expect(() => store.failureDetails("missing")).toThrow();
  } finally {
    db.close();
  }
});

test("redaction removes common credentials, URLs, paths and stacks before truncating", () => {
  const raw = [
    "HTTP 401 authentication failed",
    "Authorization: Bearer AUTH_SECRET",
    "Cookie: sid=COOKIE_SECRET; other=MORE_COOKIE_SECRET",
    '{"apiKey":"KEY_SECRET","refresh_token":"REFRESH_SECRET","x-mori-tool-secret":"CONTROL_SECRET"}',
    "Mcp-Session-Id: SESSION_SECRET",
    JSON.stringify({ password: 'QUOTED_SECRET"AFTER_QUOTE_SECRET' }),
    "Authorization\u001b[0m: Basic ENCODED_SECRET",
    "https://user:URL_PASSWORD@private.example/key/URL_SECRET?token=QUERY_SECRET",
    "/Users/private-name/project/PRIVATE_FILE C:\\Users\\private-name\\PRIVATE_FILE",
    "/workspace/private-name/PRIVATE_FILE file:///custom/private-name/PRIVATE_FILE C:/custom/PRIVATE_FILE",
    "    at fn (file:///custom/STACK_SECRET:1:1)",
    "-----BEGIN PRIVATE KEY-----\nPRIVATE_KEY_SECRET\n-----END PRIVATE KEY-----",
  ].join("\n");
  const safe = redactThreadError(raw);
  expect(safe.message).toContain("HTTP 401 authentication failed");
  expect(safe.message).not.toMatch(/SECRET|PASSWORD|private-name|PRIVATE_FILE|private\.example/);
  expect(threadErrorDetail(raw, "summary")).toMatchObject({ category: "authentication", httpStatus: 401 });
  expect(threadErrorDetail("HTTP 429 rate limit", "notice").category).toBe("rate_limit");
  expect(threadErrorDetail("fetch failed ECONNRESET", "tool").category).toBe("tool_connection");
});
