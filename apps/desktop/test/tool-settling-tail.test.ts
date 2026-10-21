import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationV2ProjectionActivityLogView as ActivityLogView } from "../src/renderer/ActivityLogView";
import { i18n } from "../src/renderer/i18n";
import type {
  ThreadRunProjectionRequestSpan,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
} from "../src/shared/ipc";

let previousLanguage = "zh-CN";

beforeEach(async () => {
  previousLanguage = i18n.resolvedLanguage ?? i18n.language;
  await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
  await i18n.changeLanguage(previousLanguage);
});

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function item(
  input: Omit<ThreadRunProjectionTimelineItem, "scope"> & { scope?: string },
): ThreadRunProjectionTimelineItem {
  return { scope: "main", ...input };
}

function promptItem(sequence: number, at: string): ThreadRunProjectionTimelineItem {
  return item({
    id: "prompt-1",
    sequence,
    eventType: "thread.status",
    role: "user",
    text: "帮我看看",
    at,
    metadata: { liveType: "thread.user_prompt" },
  });
}

function projection(
  timeline: ThreadRunProjectionTimelineItem[],
  requestSpans: ThreadRunProjectionRequestSpan[],
): ThreadRunProjectionSnapshot {
  return {
    thread: { threadId: "thr_settling", status: "running", generatedAt: new Date().toISOString() },
    attempts: [],
    agents: [],
    requestSpans,
    timeline,
    diagnostics: [],
    sourceEventCount: timeline.length,
  };
}

function renderFeed(projectionSnapshot: ThreadRunProjectionSnapshot): string {
  return renderToStaticMarkup(createElement(ActivityLogView, { projection: projectionSnapshot }));
}

function mcpToolPair(
  offsetMs: number,
  useId: string,
  sequenceBase: number,
): ThreadRunProjectionTimelineItem[] {
  const at = iso(offsetMs);
  return [
    item({
      id: `tool-${useId}-started`,
      sequence: sequenceBase,
      eventType: "tool.started",
      role: "tool",
      text: "Tool: mcp__eco__inspect",
      at,
      metadata: {
        tool: { name: "mcp__eco__inspect", detail: "inspect", status: "started", toolUseId: useId },
      },
    }),
    item({
      id: `tool-${useId}-done`,
      sequence: sequenceBase + 1,
      eventType: "tool.completed",
      role: "tool",
      text: "Tool: mcp__eco__inspect",
      at: iso(offsetMs + 50),
      metadata: {
        tool: {
          name: "mcp__eco__inspect",
          detail: "inspect",
          status: "completed",
          toolUseId: useId,
          durationMs: 50,
        },
      },
    }),
  ];
}

function activeRequest(id: string, at: string, sequence: number): ThreadRunProjectionTimelineItem {
  return item({
    id: `req-${id}`,
    sequence,
    eventType: "request.started",
    role: "main",
    text: "",
    at,
    requestId: id,
  });
}

test("settling tool group keeps the 正在思考 tail suppressed during the minimum running window", () => {
  // Tool finished 50ms ago; its group still presents the "running" shimmer for the
  // minimum-visible window, so the tail must not show a second current state.
  const html = renderFeed(
    projection(
      [promptItem(1, iso(-10_000)), ...mcpToolPair(-50, "u1", 2), activeRequest("next", iso(0), 4)],
      [{ requestId: "next", status: "waiting_first_token", startedAt: iso(0) }],
    ),
  );
  expect(html).toContain("run-log-shimmer-text");
  expect(html).not.toContain("run-log-active-tail");
  expect(html).not.toContain("正在思考");
});

test("waiting request after a settled tool group stays in the same active slot", () => {
  // Both MCP tools settled long ago. A later waiting request is still represented
  // by the latest tool slot; do not append a second「正在思考」row beneath it.
  const html = renderFeed(
    projection(
      [
        promptItem(1, iso(-10_000)),
        ...mcpToolPair(-5_000, "u1", 2),
        ...mcpToolPair(-4_900, "u2", 4),
        activeRequest("next", iso(0), 6),
      ],
      [{ requestId: "next", status: "waiting_first_token", startedAt: iso(0) }],
    ),
  );
  expect(html).toContain("已调用 eco 2 次");
  expect(html).not.toContain("run-log-active-tail");
  expect(html).not.toContain("run-log-conversation-tail");
  expect(html).not.toContain("正在思考");
});

test("thinking tail still returns after the latest content is a message, not a tool", () => {
  // After a settled message (not a tool), the model waiting on the next request is
  // the live state again —「正在思考」is allowed.
  const html = renderFeed(
    projection(
      [
        promptItem(1, iso(-10_000)),
        item({
          id: "msg-final-1",
          sequence: 2,
          eventType: "message.final",
          role: "main",
          text: "好的，我先检查一下。",
          at: iso(-5_000),
        }),
        activeRequest("next", iso(0), 3),
      ],
      [{ requestId: "next", status: "waiting_first_token", startedAt: iso(0) }],
    ),
  );
  expect(html).toContain("好的，我先检查一下。");
  expect(html).toContain("正在思考");
  expect(html).not.toContain("run-log-conversation-tail");
});
