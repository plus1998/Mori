import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ActivityLogView,
  formatRunLogTurnHeading,
  isTailThinkingStreamingLive,
  ConversationV2ProjectionActivityLogView as ProjectionActivityLogView,
  ProjectionCodemodeDetails,
  ProjectionSubagentDetailFeed,
  ProjectionToolGroupEntry,
  reconcileActivityProjectionThreadStatus,
  resolveActiveSubagentDurationMs,
  resolveToolGroupDisplayState,
  splitThinkingCarouselLines,
} from "../src/renderer/ActivityLogView";
import { formatDuration, iconForToolName, reasoningSummaryLabel } from "../src/renderer/activity-log";
import {
  buildThreadRunProjectionViewModel,
  projectionItemToDetailBlock,
  type ThreadRunProjectionMainFeedEntry,
} from "../src/renderer/conversation-v2-projection-view";
import { i18n } from "../src/renderer/i18n";
import { StreamingMarkdownContent } from "../src/renderer/StreamingMarkdownContent";
import { SubagentTaskDrawer } from "../src/renderer/SubagentTaskDrawer";
import { WorkspaceFloatingCards } from "../src/renderer/WorkspaceFloatingCards";
import type {
  ThreadRunProjectionAgent,
  ThreadRunProjectionRequestSpan,
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
} from "../src/shared/ipc";
import { renderLocalized } from "./i18n-test";

const styles = readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");
const themes = readFileSync(new URL("../src/renderer/themes.css", import.meta.url), "utf8");
const feedStatusDividerStyles = readFileSync(
  new URL("../src/renderer/FeedStatusDivider.css", import.meta.url),
  "utf8",
);

let previousLanguage = "zh-CN";

beforeEach(async () => {
  previousLanguage = i18n.resolvedLanguage ?? i18n.language;
  await i18n.changeLanguage("zh-CN");
});

afterEach(async () => {
  await i18n.changeLanguage(previousLanguage);
});

function item(
  input: Partial<ThreadRunProjectionTimelineItem> & { id: string },
): ThreadRunProjectionTimelineItem {
  return {
    id: input.id,
    sequence: input.sequence ?? 1,
    eventType: input.eventType ?? "tool.started",
    scope: input.scope ?? "main",
    role: input.role ?? "planner",
    text: input.text ?? "Tool: Write",
    at: input.at ?? "2026-01-01T00:00:00.000Z",
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.requestId && { requestId: input.requestId }),
    ...(input.streamKey && { streamKey: input.streamKey }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

function requestSpan(
  input: Partial<ThreadRunProjectionRequestSpan> & { requestId: string },
): ThreadRunProjectionRequestSpan {
  return {
    requestId: input.requestId,
    status: input.status ?? "streaming",
    startedAt: input.startedAt ?? "2026-01-01T00:00:00.000Z",
    ...(input.endedAt && { endedAt: input.endedAt }),
    ...(input.firstTokenAt && { firstTokenAt: input.firstTokenAt }),
    ...(input.role && { role: input.role }),
    ...(input.ownerAgentId && { ownerAgentId: input.ownerAgentId }),
    ...(input.source && { source: input.source }),
    ...(input.error && { error: input.error }),
    ...(input.writingTool && { writingTool: input.writingTool }),
  };
}

test("feed durations use whole units without decimals", () => {
  expect(formatDuration(4_900)).toBe("4s");
  expect(formatDuration(81_900)).toBe("1m 21s");
  expect(formatDuration(3_723_900)).toBe("1h 2m 3s");
  expect(formatDuration(0)).toBe("");
  expect(formatDuration(999)).toBe("");
});

test("running turn heading switches to stopping while cancelling", async () => {
  await i18n.changeLanguage("zh-CN");
  expect(formatRunLogTurnHeading(true, "running", 4_000)).toBe("处理中 4s");
  expect(formatRunLogTurnHeading(true, "running", 4_000, true)).toBe("停止中 4s");
});

test("an active thread summary restores running during a provisional idle V2 projection", () => {
  const snapshot = projection({
    status: "idle",
    timeline: [item({ id: "message", eventType: "message.delta", role: "planner", text: "正在准备下一步" })],
  });

  expect(reconcileActivityProjectionThreadStatus(snapshot, { status: "running" }).thread.status).toBe(
    "running",
  );
});

test("a streaming thinking row on the tail owns the Feed's own live indicator", () => {
  const timelineEntry = (item: ThreadRunProjectionTimelineItem): ThreadRunProjectionMainFeedEntry => ({
    kind: "timeline",
    key: item.id,
    at: item.at,
    sequence: item.sequence,
    item,
  });

  // A thinking row keeps `thinking.delta` while the agent moves on to writing its tool
  // call, so the Composer's dots defer to the shimmer it is already showing.
  expect(
    isTailThinkingStreamingLive([
      timelineEntry(item({ id: "thinking", eventType: "thinking.delta", role: "thinking", text: "先看看…" })),
    ]),
  ).toBe(true);
  // Finalized thinking has stopped animating; the gap is the Composer's to narrate.
  expect(
    isTailThinkingStreamingLive([
      timelineEntry(item({ id: "thinking", eventType: "thinking.final", role: "thinking", text: "先看看…" })),
    ]),
  ).toBe(false);
  // Narrative is typed out with no mark of its own, which is the case the dots exist for.
  expect(
    isTailThinkingStreamingLive([
      timelineEntry(
        item({ id: "narrative", eventType: "message.delta", role: "planner", text: "让我读取代码：" }),
      ),
    ]),
  ).toBe(false);
  // Only the newest row counts: earlier thinking has already been scrolled past.
  expect(
    isTailThinkingStreamingLive([
      timelineEntry(item({ id: "thinking", eventType: "thinking.delta", role: "thinking", text: "先看看…" })),
      {
        kind: "tool-group",
        key: "tool",
        at: "2026-01-01T00:00:01.000Z",
        sequence: 2,
        entries: [
          {
            kind: "timeline",
            key: "tool",
            at: "2026-01-01T00:00:01.000Z",
            sequence: 2,
            item: item({ id: "tool", eventType: "tool.started", sequence: 2, role: "tool" }),
          },
        ],
      },
    ]),
  ).toBe(false);
  expect(isTailThinkingStreamingLive([])).toBe(false);
});

test("settled tool group keeps its running display for at least one second", () => {
  const now = 1_000_000;
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const entry = {
    kind: "timeline" as const,
    key: "tool-settled",
    at: iso(-200),
    sequence: 1,
    item: {
      id: "tool-settled",
      sequence: 1,
      eventType: "tool.completed",
      scope: "main",
      role: "tool",
      text: "Tool: Bash · git status",
      at: iso(-200),
      metadata: {
        tool: { name: "Bash", detail: "git status", status: "completed", durationMs: 100 },
      },
    },
  };

  const extended = resolveToolGroupDisplayState([entry], now);
  expect(extended.lifecycle).toBe("running");
  // finished at now-200 after a 100ms run → started at now-300 → window ends at now+700.
  expect(extended.remainingMs).toBe(700);

  const released = resolveToolGroupDisplayState([entry], now + 700);
  expect(released.lifecycle).toBe("completed");
  expect(released.remainingMs).toBe(0);
});

test("a long settled tool group does not extend past its minimum window", () => {
  const now = 1_000_000;
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const entry = {
    kind: "timeline" as const,
    key: "tool-long",
    at: iso(-5_000),
    sequence: 1,
    item: {
      id: "tool-long",
      sequence: 1,
      eventType: "tool.completed",
      scope: "main",
      role: "tool",
      text: "Tool: Bash · build",
      at: iso(-5_000),
      metadata: { tool: { name: "Bash", detail: "build", status: "completed", durationMs: 4_000 } },
    },
  };

  const display = resolveToolGroupDisplayState([entry], now);
  expect(display.lifecycle).toBe("completed");
  expect(display.remainingMs).toBe(0);
});

function projection(input: {
  timeline: ThreadRunProjectionTimelineItem[];
  agents?: ThreadRunProjectionAgent[];
  requestSpans?: ThreadRunProjectionRequestSpan[];
  attempts?: ThreadRunProjectionSnapshot["attempts"];
  status?: string;
}): ThreadRunProjectionSnapshot {
  return {
    thread: {
      threadId: "thr_loading",
      status: input.status ?? "running",
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
    attempts: input.attempts ?? [],
    agents: input.agents ?? [],
    requestSpans: input.requestSpans ?? [],
    timeline: input.timeline,
    diagnostics: [],
    sourceEventCount: input.timeline.length + (input.agents?.length ?? 0),
  };
}

function agent(input: Partial<ThreadRunProjectionAgent> & { agentId: string }): ThreadRunProjectionAgent {
  return {
    agentId: input.agentId,
    role: input.role ?? "coder",
    kind: "subagent",
    status: input.status ?? "active",
    startedAt: input.startedAt ?? "2026-01-01T00:00:00.000Z",
    durationMs: input.durationMs ?? 0,
    timeline: input.timeline ?? [],
    ...(input.endedAt && { endedAt: input.endedAt }),
    ...(input.usage && { usage: input.usage }),
    ...(input.context && { context: input.context }),
    ...(input.delegationPrompt && { delegationPrompt: input.delegationPrompt }),
    ...(input.delegationSummary && { delegationSummary: input.delegationSummary }),
    ...(input.taskName && { taskName: input.taskName }),
    ...(input.nickname && { nickname: input.nickname }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.parentToolUseId && { parentToolUseId: input.parentToolUseId }),
  };
}

test("active subagent duration stays anchored to its feed card start time", () => {
  expect(
    resolveActiveSubagentDurationMs("2026-01-01T00:00:00.000Z", 0, Date.parse("2026-01-01T00:00:42.000Z")),
  ).toBe(42_000);
});

test("active subagent duration never moves behind the projected duration", () => {
  expect(
    resolveActiveSubagentDurationMs(
      "2026-01-01T00:00:40.000Z",
      45_000,
      Date.parse("2026-01-01T00:01:00.000Z"),
    ),
  ).toBe(45_000);
});

test("StreamingMarkdownContent streams unfinished prose as markdown (no plain-spacing jump)", () => {
  const html = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, {
      text: "正文输出\n第二行",
      streaming: true,
    }),
  );

  // Live prose uses the same paragraph host as settle — not pre-wrap plain.
  expect(html).toContain("<p>正文输出<br/>第二行</p>");
  expect(html).not.toContain("markdown-content--streaming-plain");
});

test("StreamingMarkdownContent renders an incomplete code fence without a local loading tail", () => {
  const html = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, {
      text: "开始执行\n```bash\necho ready",
      streaming: true,
    }),
  );

  // Stable preface is real markdown; incomplete fence stays plain mutably.
  expect(html).toContain("开始执行");
  expect(html).toContain("markdown-content--streaming-plain");
  expect(html).toContain("```bash");
  expect(html).toContain("echo ready");
  expect(html).not.toContain("run-log-streaming-dots");
  expect(html).not.toContain("等待代码块");
  expect(html).not.toContain("等待 Bash 代码块");
  expect(html).not.toContain("markdown-streaming-block-loading");
});

test("StreamingMarkdownContent leaves held structured edit loading to the conversation tail", () => {
  const html = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, {
      text: "<<<<<<< SEARCH\nold value",
      streaming: true,
    }),
  );

  expect(html).toBe("");
});

test("StreamingMarkdownContent keeps a long unfinished response on the markdown path", () => {
  // The reveal is incremental now, so a large mutable tail no longer has to
  // fall back to pre-wrap plain text: dropping the tail would change paragraph
  // spacing the moment the turn settles.
  const paragraph = "这是一段持续输出的正文内容，用来把可变尾块撑过旧的 800 字阈值。";
  const text = `${paragraph.repeat(30)}\n\n仍在继续输出`;
  const streamingHtml = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, { text, streaming: true }),
  );
  const settledHtml = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, { text, streaming: false }),
  );

  expect(text.length).toBeGreaterThan(800);
  expect(streamingHtml).not.toContain("markdown-content--streaming-plain");
  expect(streamingHtml).toContain("仍在继续输出");
  expect(streamingHtml).toBe(settledHtml);
});

test("StreamingMarkdownContent streams the prose tail as markdown, not pre-wrap plain text", () => {
  const html = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, { text: "第一段\n\n第二段", streaming: true }),
  );

  expect(html).toContain("<p>第一段</p>");
  expect(html).toContain("<p>第二段</p>");
  expect(html).not.toContain("markdown-content--streaming-plain");
});

test("desktop feed keeps narrative edge spacing stable when streaming settles to markdown", () => {
  const streamingHtml = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, { text: "正文输出", streaming: true }),
  );
  const settledHtml = renderToStaticMarkup(
    createElement(StreamingMarkdownContent, { text: "正文输出", streaming: false }),
  );

  // Unfinished prose streams as the same <p> host — settle only ends the run flag.
  expect(streamingHtml).toContain("<p>正文输出</p>");
  expect(streamingHtml).not.toContain("markdown-content--streaming-plain");
  expect(settledHtml).toContain("<p>正文输出</p>");
  // Direct SSR children + PM nested blocks both zero their outer edges.
  expect(styles).toMatch(
    /\.codex-main:not\(\.codex-main-landing\)\s+\.run-log-feed-entry\s+\.markdown-content\s+>\s*:first-child[\s\S]*?margin-top:\s*0;/s,
  );
  expect(styles).toMatch(
    /\.codex-main:not\(\.codex-main-landing\)\s+\.run-log-feed-entry\s+\.markdown-content\s+\.ProseMirror\s+>\s*:first-child\s*\{\s*margin-top:\s*0;/s,
  );
  expect(styles).toMatch(
    /\.codex-main:not\(\.codex-main-landing\)\s+\.run-log-feed-entry\s+\.markdown-content\s+>\s*:last-child[\s\S]*?margin-bottom:\s*0;/s,
  );
  expect(styles).toMatch(
    /\.codex-main:not\(\.codex-main-landing\)\s+\.run-log-feed-entry\s+\.markdown-content\s+\.ProseMirror\s+>\s*:last-child\s*\{\s*margin-bottom:\s*0;/s,
  );
});

test("desktop feed disables overflow-anchor so tail tables cannot pull the scroller up", () => {
  expect(styles).toMatch(/\.activity-messages\s*\{[^}]*overflow-anchor:\s*none;/s);
  expect(styles).toMatch(
    /\.markdown-content\s+table,\s*\n\s*\.markdown-content\s+\.markdown-table\s*\{[^}]*overflow-anchor:\s*none;/s,
  );
});

test("ActivityLogView waits for thread stop before exposing final output copy", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "assistant-last",
            eventType: "message.final",
            text: "当前最后一轮，但会话还没停止。",
          }),
        ],
      }),
    }),
  );

  expect(html).not.toContain('aria-label="复制消息"');
  expect(html).toContain('class="run-log-conversation-tail"');
  expect(html).not.toContain("run-log-streaming-dots");
  expect(html).toContain("run-log-active-tail");
});

test("ActivityLogView shows thinking when the prompt is the only row on the feed", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "initial-user-prompt",
            eventType: "thread.status",
            role: "user",
            text: "检查当前实现",
            metadata: { liveType: "thread.user_prompt" },
          }),
        ],
      }),
    }),
  );

  // Nothing agent-side has landed yet, so the tail is the only thing that can show the
  // send was received — a bare user bubble read as "the send did nothing".
  expect(html).toContain('class="run-log-thinking streaming empty"');
  expect(html).toContain("run-log-active-tail");
  expect(html).not.toContain("run-log-conversation-tail");
  expect(html).toContain("正在思考");
});

test("ActivityLogView shows thinking when a follow-up prompt is the newest row", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "previous-answer",
            sequence: 1,
            eventType: "message.final",
            text: "上一轮已经答完的内容。",
          }),
          item({
            id: "follow-up-prompt",
            sequence: 2,
            eventType: "thread.status",
            role: "user",
            text: "再改一下这里",
            metadata: { liveType: "thread.user_prompt" },
          }),
        ],
      }),
    }),
  );

  // A follow-up send is not acknowledged by the answer that came before it: until the
  // agent produces its first row for the new prompt, the tail is the only signal.
  expect(html).toContain("再改一下这里");
  expect(html).toContain("run-log-active-tail");
  expect(html).toContain("正在思考");
  expect(html).not.toContain("run-log-conversation-tail");
});

test("ActivityLogView shows thinking while the first request event is pending", () => {
  const html = renderToStaticMarkup(
    createElement(ActivityLogView, {
      thread: {
        id: "thread-initial-loading",
        title: "检查当前实现",
        prompt: "检查当前实现",
        workspacePath: "/tmp/project",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        message: "",
      },
    }),
  );

  expect(html).toContain("检查当前实现");
  // No V2 event has arrived, but the thread is already running: the prompt bubble
  // cannot be the whole feed, or a first send looks unacknowledged.
  expect(html).toContain('class="run-log-thinking streaming empty"');
  expect(html).toContain("run-log-active-tail");
  expect(html).toContain("正在思考");
  expect(html).not.toContain("run-log-projection-loading");
});

test("ActivityLogView hides the conversation tail while a request is waiting for its first token", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [requestSpan({ requestId: "req-waiting", status: "waiting_first_token" })],
        timeline: [
          item({
            id: "user-before-request",
            sequence: 1,
            eventType: "thread.status",
            role: "user",
            text: "继续检查",
            metadata: { liveType: "thread.user_prompt" },
          }),
          item({
            id: "request-started",
            sequence: 2,
            eventType: "request.started",
            requestId: "req-waiting",
            text: "",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("正在思考");
  expect(html).not.toContain("run-log-conversation-tail");
});

test("native thinking start shows the existing waiting row until thinking content arrives", () => {
  const render = (pending: boolean, text?: string, status = "running", ownerAgentId?: string) =>
    renderToStaticMarkup(
      createElement(ProjectionActivityLogView, {
        thinkingDisplayMode: "expanded",
        projection: projection({
          status,
          requestSpans: [
            {
              ...requestSpan({ requestId: "req-native-thinking" }),
              pendingThinkingMessageId: "thinking-body-message",
              ...(pending ? { pendingThinkingSince: "2026-01-01T00:00:02.000Z" } : {}),
              ...(ownerAgentId ? { ownerAgentId } : {}),
            },
          ],
          timeline: [
            item({ id: "earlier-output", sequence: 1, eventType: "message.final", text: "上一阶段答复" }),
            ...(text
              ? [
                  item({
                    id: "thinking-body",
                    sequence: 2,
                    eventType: "thinking.delta",
                    role: "thinking",
                    requestId: "req-native-thinking",
                    text,
                    metadata: { reasoningDisplay: "raw", conversationV2MessageId: "thinking-body-message" },
                  }),
                ]
              : []),
          ],
        }),
      }),
    );
  expect(render(true)).toContain("正在思考");
  expect(render(true).match(/run-log-thinking streaming empty/g)?.length).toBe(1);
  // Content replaces the wait immediately, even before projection extras finish refreshing.
  const withContent = render(true, "先检查实现，再确认边界");
  expect(withContent).toContain("先检查实现，再确认边界");
  expect(withContent).not.toContain("run-log-thinking streaming empty");
  expect(render(true, undefined, "completed")).not.toContain("run-log-thinking streaming empty");
  expect(render(true, undefined, "running", "child")).not.toContain("run-log-thinking streaming empty");
});

test("subagent native thinking start waits without appearing on the main agent", () => {
  const render = (pending: boolean, text?: string) =>
    renderToStaticMarkup(
      createElement(ProjectionSubagentDetailFeed, {
        agent: agent({
          agentId: "child-thinking",
          status: "active",
          timeline: [
            item({ id: "child-earlier", scope: "agent", eventType: "message.final", text: "上一阶段答复" }),
            ...(text
              ? [
                  item({
                    id: "child-thought",
                    sequence: 2,
                    scope: "agent",
                    eventType: "thinking.delta",
                    role: "thinking",
                    requestId: "req-child",
                    text,
                    metadata: { reasoningDisplay: "raw", conversationV2MessageId: "child-thought-message" },
                  }),
                ]
              : []),
          ],
        }),
        missionText: "检查代码",
        threadActive: true,
        thinkingDisplayMode: "expanded",
        requestSpansById: new Map([
          [
            "req-child",
            {
              ...requestSpan({ requestId: "req-child", ownerAgentId: "child-thinking" }),
              pendingThinkingMessageId: "child-thought-message",
              ...(pending ? { pendingThinkingSince: "2026-01-01T00:00:02.000Z" } : {}),
            },
          ],
        ]),
      }),
    );
  expect(render(true)).toContain("run-log-thinking streaming empty");
  const withContent = render(true, "检查子任务边界");
  expect(withContent).toContain("检查子任务边界");
  expect(withContent).not.toContain("run-log-thinking streaming empty");
});

test("native thinking start takes the live slot after a settled tool", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [
          {
            ...requestSpan({ requestId: "req-after-tool" }),
            pendingThinkingSince: "2026-01-01T00:00:02.000Z",
          },
        ],
        timeline: [
          item({
            id: "settled-read",
            eventType: "tool.completed",
            text: "Tool: Read",
            metadata: { tool: { name: "Read", toolUseId: "read-1", status: "completed" } },
          }),
        ],
      }),
    }),
  );
  expect(html).toContain("正在思考");
  expect(html.match(/run-log-thinking streaming empty/g)?.length).toBe(1);
});

test("ActivityLogView removes the waiting indicator after the first stream output", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [
          requestSpan({
            requestId: "req-streaming",
            status: "streaming",
            firstTokenAt: "2026-01-01T00:00:02.000Z",
          }),
        ],
        timeline: [
          item({
            id: "request-started-streaming",
            sequence: 1,
            eventType: "request.started",
            requestId: "req-streaming",
            text: "",
          }),
          item({
            id: "empty-stream-placeholder",
            sequence: 2,
            eventType: "message.delta",
            requestId: "req-streaming",
            role: "planner",
            text: "",
            streamKey: "stream:req-streaming",
          }),
          item({
            id: "first-stream-output",
            sequence: 3,
            eventType: "message.delta",
            requestId: "req-streaming",
            role: "planner",
            text: "首个输出",
            streamKey: "stream:req-streaming",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("首个输出");
  expect(html).not.toContain('class="run-log-thinking streaming empty"');
  expect(html).not.toContain("正在思考");
});

test("ActivityLogView keeps first-turn thinking spacing stable before request startup", () => {
  const runningAttempt = {
    attemptId: "attempt-first-message",
    phase: "initial" as const,
    status: "running" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
  const userPrompt = item({
    id: "first-user-prompt",
    sequence: 1,
    eventType: "thread.status",
    role: "user",
    text: "检查首次发送间距",
    at: "2026-01-01T00:00:00.100Z",
    metadata: { liveType: "thread.user_prompt" },
  });
  const render = (
    timeline: ThreadRunProjectionTimelineItem[],
    requestSpans: ThreadRunProjectionRequestSpan[],
  ) =>
    renderToStaticMarkup(
      createElement(ProjectionActivityLogView, {
        projection: projection({
          status: "running",
          attempts: [runningAttempt],
          timeline,
          requestSpans,
        }),
      }),
    );

  const beforeRequest = render([userPrompt], []);
  const afterRequest = render(
    [
      userPrompt,
      item({
        id: "first-request-started",
        sequence: 2,
        eventType: "request.started",
        requestId: "req-first-message",
        runAttemptId: runningAttempt.attemptId,
        text: "",
      }),
    ],
    [requestSpan({ requestId: "req-first-message", status: "waiting_first_token" })],
  );

  // The waiting line is up from the moment the user bubble is the only row on the feed,
  // and request.started only moves it from the tail onto the turn's request row — the
  // empty turn keeps its spacing either way.
  expect(beforeRequest).toContain("run-log-turn-process-inner is-empty");
  expect(afterRequest).toContain("run-log-turn-process-inner is-empty");
  expect(beforeRequest).toContain("run-log-active-tail");
  expect(afterRequest).toContain("run-log-active-tail");
  expect(beforeRequest).toContain("正在思考");
  expect(afterRequest).toContain("正在思考");
});

test("ActivityLogView suppresses the thinking indicator while a tool row is the latest content", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [requestSpan({ requestId: "req-waiting", status: "waiting_first_token" })],
        timeline: [
          item({
            id: "request-started",
            sequence: 1,
            eventType: "request.started",
            requestId: "req-waiting",
            text: "",
          }),
          item({
            id: "read-completed",
            sequence: 2,
            eventType: "tool.completed",
            text: "Tool: Read · config.ts",
            metadata: {
              tool: {
                name: "Read",
                detail: "config.ts",
                toolUseId: "toolu_read_config",
                status: "completed",
              },
            },
          }),
        ],
      }),
    }),
  );

  // The settled tool row is the latest content, so it is the tail state itself —
  // the「正在思考」line must not render beneath it.
  expect(html).toContain("config.ts");
  expect(html).not.toContain("正在思考");
  expect(html).not.toContain("run-log-active-tail");
  expect(html).not.toContain("run-log-conversation-tail");
});

test("ActivityLogView replaces answered clarification waiting with its question and answer", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "clarification-waiting",
            sequence: 1,
            eventType: "thread.status",
            role: "system",
            text: "等待你的回答…",
            metadata: { liveType: "thread.running" },
          }),
          item({
            id: "clarification-answer",
            sequence: 2,
            eventType: "message.final",
            role: "planner",
            text: "澄清回答：应该使用哪种部署方式？ → 蓝绿部署",
            metadata: { liveType: "clarification.answered" },
          }),
        ],
      }),
    }),
  );

  expect(html).not.toContain("等待你的回答");
  expect(html).toContain("应该使用哪种部署方式？");
  expect(html).toContain("蓝绿部署");
  expect(html).toContain("clarification-answer-card");
});

test("ActivityLogView hides the plan execution transition and its empty processed section", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        attempts: [
          {
            attemptId: "attempt-planning",
            phase: "planning",
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:05.000Z",
          },
        ],
        timeline: [
          item({
            id: "plan-cleared",
            sequence: 1,
            eventType: "thread.status",
            role: "system",
            runAttemptId: "attempt-planning",
            text: "计划已进入执行阶段。",
            metadata: { liveType: "thread.plan_cleared" },
          }),
        ],
      }),
    }),
  );

  expect(html).not.toContain("计划已进入执行阶段");
  expect(html).not.toContain("run-log-turn");
  expect(html).not.toContain("已处理");
});

test("ActivityLogView renders prompt images above the user text", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        timeline: [
          item({
            id: "user-with-image",
            eventType: "thread.status",
            role: "user",
            text: "分析这张图片",
            metadata: {
              liveType: "thread.user_prompt",
              promptImagePreviews: [{ id: "preview-1", mediaType: "image/jpeg", data: "YWJj" }],
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain('class="run-log-user-prompt-images"');
  expect(html).toContain('class="run-log-user-prompt-image"');
  expect(html).toContain('alt="用户上传的图片 1"');
  expect(html).toContain('aria-label="放大查看图片 1"');
  expect(html.indexOf("run-log-user-prompt-images")).toBeLessThan(html.indexOf("分析这张图片"));
});

test("ActivityLogView exposes final output copy after thread stops", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "assistant-final",
            eventType: "message.final",
            text: "会话停止后的最终输出。",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain('aria-label="复制消息"');
  expect(html).not.toContain("run-log-conversation-tail");
  expect(html).toContain("会话停止后的最终输出。");
});

test("ActivityLogView does not resurrect thinking for a terminal V2 projection", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      thread: {
        id: "thread-terminal-summary",
        title: "已完成的会话",
        prompt: "检查当前实现",
        workspacePath: "/tmp/project",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        message: "已完成",
      },
      projection: projection({
        status: "completed",
        requestSpans: [requestSpan({ requestId: "req-stale", status: "waiting_first_token" })],
        timeline: [
          item({
            id: "stale-user-prompt",
            sequence: 1,
            eventType: "thread.status",
            role: "user",
            text: "检查当前实现",
            metadata: { liveType: "thread.user_prompt" },
          }),
          item({
            id: "stale-request-started",
            sequence: 2,
            eventType: "request.started",
            requestId: "req-stale",
            text: "",
          }),
          item({
            id: "final-agent-message",
            sequence: 3,
            eventType: "message.final",
            role: "planner",
            text: "已经完成。",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("已经完成。");
  expect(html).toContain('aria-label="复制消息"');
  expect(html).not.toContain("正在思考");
  expect(html).not.toContain("run-log-active-tail");
});

test("ActivityLogView separates a completed attempt process from its final output", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        attempts: [
          {
            attemptId: "attempt-1",
            phase: "initial",
            retryIndex: 0,
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:04.000Z",
          },
        ],
        timeline: [
          item({
            id: "process-message",
            sequence: 1,
            eventType: "message.final",
            runAttemptId: "attempt-1",
            text: "先检查事件投影。",
            at: "2026-01-01T00:00:01.000Z",
          }),
          item({
            id: "final-message",
            sequence: 2,
            eventType: "message.final",
            runAttemptId: "attempt-1",
            text: "Feed 已完成整理。",
            at: "2026-01-01T00:00:04.000Z",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("已处理 4s");
  expect(html).toContain('class="run-log-turn is-completed is-collapsed"');
  expect(html).toContain('class="run-log-turn-process"');
  expect(html).toContain('aria-label="执行过程" aria-hidden="true"');
  expect(html).toContain('class="run-log-turn-final" aria-label="最终输出"');
  expect(html).not.toContain("先检查事件投影。");
  expect(html.indexOf("run-log-turn-final")).toBeLessThan(html.indexOf("Feed 已完成整理。"));
});

test("ActivityLogView labels a manually cancelled attempt with its elapsed time", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "idle",
        attempts: [
          {
            attemptId: "attempt-cancelled",
            phase: "initial",
            retryIndex: 0,
            status: "cancelled",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:05.000Z",
          },
        ],
        timeline: [
          item({
            id: "cancelled-progress",
            eventType: "message.final",
            runAttemptId: "attempt-cancelled",
            text: "正在检查。",
            at: "2026-01-01T00:00:04.000Z",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("你在 5秒 后停止了");
  expect(html).not.toContain("已处理 5s");
});

test("ActivityLogView labels an unexpectedly failed attempt with its elapsed time", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "failed",
        attempts: [
          {
            attemptId: "attempt-failed",
            phase: "initial",
            retryIndex: 0,
            status: "failed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:05.000Z",
          },
        ],
        timeline: [
          item({
            id: "failed-progress",
            eventType: "message.final",
            runAttemptId: "attempt-failed",
            text: "正在检查。",
            at: "2026-01-01T00:00:04.000Z",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("运行 5秒 后停止了");
  expect(html).not.toContain("已处理 5s");
});

test("ActivityLogView does not duplicate turn headings for skeleton subagent cards", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        attempts: [
          {
            attemptId: "attempt-1",
            phase: "execution",
            retryIndex: 0,
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:45.000Z",
          },
        ],
        timeline: [
          item({
            id: "user",
            sequence: 1,
            eventType: "thread.status",
            role: "user",
            text: "帮我改代码",
            at: "2026-01-01T00:00:00.000Z",
            metadata: { liveType: "thread.user_prompt" },
          }),
          item({
            id: "final",
            sequence: 4,
            eventType: "message.final",
            role: "planner",
            runAttemptId: "attempt-1",
            text: "全部完成。",
            at: "2026-01-01T00:00:45.000Z",
          }),
        ],
        agents: [
          agent({
            agentId: "agent_coder_1",
            status: "completed",
            startedAt: "2026-01-01T00:00:05.500Z",
            endedAt: "2026-01-01T00:00:40.000Z",
            durationMs: 34_500,
            runAttemptId: "attempt-1",
            parentToolUseId: "toolu_agent",
            delegationPrompt: "改路由",
            // Stopped skeleton cards keep empty agent process timelines.
            timeline: [],
          }),
        ],
      }),
    }),
  );

  expect(html.match(/已处理 45s/g)).toEqual(["已处理 45s"]);
  expect(html.match(/class="run-log-turn /g)?.length ?? 0).toBe(1);
});

test("ActivityLogView keeps block spacing between a completed turn and the next user prompt", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        attempts: [
          {
            attemptId: "attempt-before-follow-up",
            phase: "initial",
            retryIndex: 0,
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:06.000Z",
          },
        ],
        timeline: [
          item({
            id: "completed-tool",
            sequence: 1,
            eventType: "tool.completed",
            role: "tool",
            runAttemptId: "attempt-before-follow-up",
            text: "Tool: Read · README.md",
            at: "2026-01-01T00:00:05.000Z",
            metadata: {
              tool: { name: "Read", detail: "README.md", status: "completed" },
            },
          }),
          item({
            id: "follow-up-user-prompt",
            sequence: 2,
            eventType: "thread.status",
            role: "user",
            text: "继续",
            at: "2026-01-01T00:00:07.000Z",
            metadata: { liveType: "thread.user_prompt" },
          }),
        ],
      }),
    }),
  );

  expect(html).toMatch(
    /<div class="run-log-virtual-row" data-index="\d+"><section class="run-log-turn is-completed is-collapsed"[\s\S]*<\/section><\/div><div class="run-log-virtual-row" data-index="\d+"><div class="run-log-feed-entry"><article class="run-log-user-prompt"/,
  );
  expect(styles).toMatch(
    /\.codex-main:not\(\.codex-main-landing\)\s+\.run-log\s*>\s*\.run-log-turn\s*\+\s*\.run-log-feed-entry:not\(:where\(\.run-log-active-tail\)\)\s*,/,
  );
  expect(styles).toMatch(
    /\.run-log\s*>\s*\.run-log-virtual-row:has\(>\s*\.run-log-turn\)\s*\+\s*\.run-log-virtual-row:has\(>\s*\.run-log-feed-entry\)\s*>\s*\.run-log-feed-entry[\s\S]*?margin-top:\s*var\(--codex-feed-gap-block\);/,
  );
});

/**
 * Stable Feed rhythm (9d0bc14a): one process gap for tools / thinking / narrative /
 * imageView inside「处理中」, plus the same token for active-tail and top-level
 * process-like siblings. Do not swap process-inner back to --codex-feed-gap-step.
 */
test("run-log feed spacing contract keeps process rhythm on --codex-feed-gap-process", () => {
  expect(themes.match(/--codex-feed-gap-block:\s*14px;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(themes.match(/--codex-feed-gap-step:\s*6px;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(themes.match(/--codex-feed-gap-process:\s*20px;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  expect(styles).toMatch(/--codex-feed-gap-process:\s*20px;/);

  const processInnerBody = styles.match(
    /\.codex-main:not\(\.codex-main-landing\) \.run-log-turn-process-inner\s*\{([\s\S]*?)\n\}/,
  )?.[1];
  expect(processInnerBody).toBeTruthy();
  expect(processInnerBody).toMatch(/^\s*gap:\s*var\(--codex-feed-gap-process\);/m);
  expect(processInnerBody).toMatch(/^\s*padding-top:\s*var\(--codex-feed-gap-process\);/m);
  expect(processInnerBody).not.toMatch(/gap:\s*var\(--codex-feed-gap-step\)/);
  expect(processInnerBody).not.toMatch(/padding-top:\s*var\(--codex-feed-gap-step\)/);

  expect(styles).toMatch(
    /\.codex-main:not\(\.codex-main-landing\) \.run-log-turn-final\s*\{[\s\S]*?margin-top:\s*var\(--codex-feed-gap-process\);/,
  );
  expect(styles).toMatch(
    /\.run-log\s*>\s*\.run-log-feed-entry:is\([\s\S]*?:has\(\.run-log-thinking\)[\s\S]*?\)\s*\+\s*\.run-log-feed-entry[\s\S]*?margin-top:\s*var\(--codex-feed-gap-process\);/,
  );
  expect(styles).toMatch(
    /\.run-log\s*>\s*\.run-log-active-tail[\s\S]*?margin-top:\s*var\(--codex-feed-gap-process\);/,
  );
  expect(styles).toMatch(
    /\.run-log\s*>\s*\.run-log-feed-entry--tight\s*\+\s*\.run-log-feed-entry--tight:not\(:where\(\.run-log-active-tail\)\)[\s\S]*?margin-top:\s*var\(--codex-feed-gap-step\);/,
  );
  const statusDividerBody = feedStatusDividerStyles.match(/\.feed-status-divider\s*\{([\s\S]*?)\n\}/)?.[1];
  expect(statusDividerBody).toBeTruthy();
  expect(statusDividerBody).not.toMatch(/margin(?:-block)?:/);
  expect(styles).not.toMatch(
    /\.run-log-turn-process-inner\s*>\s*\.run-log-feed-entry:has\(\.run-log-context-action\)\s*\{[\s\S]*?margin-block:\s*14px;/,
  );
});

test("ActivityLogView keeps a running attempt process expanded without final output", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        attempts: [
          {
            attemptId: "attempt-running",
            phase: "follow_up",
            retryIndex: 0,
            status: "running",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        timeline: [
          item({
            id: "running-message",
            eventType: "message.final",
            runAttemptId: "attempt-running",
            text: "正在检查剩余文件。",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("处理中");
  expect(html).toContain('class="run-log-turn is-running is-expanded"');
  expect(html).toContain('class="run-log-turn-toggle" disabled="" aria-expanded="true"');
  expect(html).not.toContain("run-log-turn-chevron");
  expect(html).toContain('aria-label="执行过程" aria-hidden="false"');
  expect(html).not.toContain('class="run-log-turn-final"');
});

test("mid-turn prompts keep one running heading while every continuation remains expanded", () => {
  for (const status of ["running", "completed", "cancelled", "failed"] as const) {
    const timeline = [
      item({
        id: "user-first",
        eventType: "thread.status",
        sequence: 1,
        role: "user",
        text: "开始检查",
        at: "2026-01-01T00:00:00.000Z",
        metadata: { liveType: "thread.user_prompt" },
      }),
      item({
        id: "output-first",
        sequence: 3,
        eventType: "message.final",
        text: "先检查代码。",
        runAttemptId: "attempt-midturn",
        at: "2026-01-01T00:00:02.000Z",
      }),
      item({
        id: "user-mid",
        eventType: "thread.status",
        sequence: 4,
        role: "user",
        text: "补充第一条要求",
        at: "2026-01-01T00:00:03.000Z",
        metadata: { liveType: "thread.user_prompt" },
      }),
      item({
        id: "output-mid",
        sequence: 5,
        eventType: "message.final",
        text: "继续检查第一条要求。",
        runAttemptId: "attempt-midturn",
        at: "2026-01-01T00:00:04.000Z",
      }),
      item({
        id: "user-mid-2",
        eventType: "thread.status",
        sequence: 6,
        role: "user",
        text: "补充第二条要求",
        at: "2026-01-01T00:00:05.000Z",
        metadata: { liveType: "thread.user_prompt" },
      }),
      item({
        id: "output-mid-2",
        sequence: 7,
        eventType: "message.final",
        text: "继续检查第二条要求。",
        runAttemptId: "attempt-midturn",
        at: "2026-01-01T00:00:06.000Z",
      }),
    ];
    const html = renderToStaticMarkup(
      createElement(ProjectionActivityLogView, {
        projection: projection({
          status,
          timeline,
          attempts: [
            {
              attemptId: "attempt-midturn",
              status,
              startedAt: "2026-01-01T00:00:01.000Z",
              ...(status !== "running" ? { endedAt: "2026-01-01T00:00:08.000Z" } : {}),
            },
          ],
        }),
      }),
    );

    expect(html.match(/class="run-log-turn-toggle"/g)?.length).toBe(status === "running" ? 1 : 3);
    if (status === "running") {
      expect(html.match(/run-log-turn-status">处理中/g)?.length).toBe(1);
      expect(html.match(/is-expanded is-continuation/g)?.length).toBe(2);
      expect(html).toContain("先检查代码。");
      expect(html).toContain("继续检查第一条要求。");
      expect(html).toContain("继续检查第二条要求。");
      expect(html.indexOf("补充第一条要求")).toBeLessThan(html.indexOf("继续检查第一条要求。"));
      expect(html.indexOf("补充第二条要求")).toBeLessThan(html.indexOf("继续检查第二条要求。"));
    } else {
      expect(html).not.toContain("is-continuation");
    }
  }
});

test("a new follow-up attempt keeps its own running heading", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        attempts: [
          {
            attemptId: "attempt-first",
            status: "completed",
            startedAt: "2026-01-01T00:00:01.000Z",
            endedAt: "2026-01-01T00:00:03.000Z",
          },
          { attemptId: "attempt-next", status: "running", startedAt: "2026-01-01T00:00:05.000Z" },
        ],
        timeline: [
          item({
            id: "first-output",
            eventType: "message.final",
            sequence: 1,
            runAttemptId: "attempt-first",
            text: "第一轮完成。",
            at: "2026-01-01T00:00:02.000Z",
          }),
          item({
            id: "next-prompt",
            eventType: "thread.status",
            sequence: 2,
            role: "user",
            text: "下一轮",
            at: "2026-01-01T00:00:04.000Z",
            metadata: { liveType: "thread.user_prompt" },
          }),
          item({
            id: "next-output",
            sequence: 3,
            eventType: "message.final",
            runAttemptId: "attempt-next",
            text: "正在执行下一轮。",
            at: "2026-01-01T00:00:06.000Z",
          }),
        ],
      }),
    }),
  );
  expect(html.match(/class="run-log-turn-toggle"/g)?.length).toBe(2);
  expect(html.match(/run-log-turn-status">处理中/g)?.length).toBe(1);
  expect(html).not.toContain("is-continuation");
});

test("ActivityLogView collapses completed thinking behind a deep-thinking summary", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      thinkingDisplayMode: "collapsed",
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "thinking-final",
            eventType: "thinking.final",
            role: "thinking",
            requestId: "req-thinking",
            text: "先检查事件投影，再统一渲染结构。",
          }),
        ],
        requestSpans: [
          requestSpan({
            requestId: "req-thinking",
            status: "completed",
            endedAt: "2026-01-01T00:00:03.000Z",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain('class="run-log-thinking');
  expect(html).toContain("run-log-thinking-trigger");
  expect(html).toContain("run-log-thinking-icon");
  expect(html).toContain("run-log-thinking-chevron");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("已思考");
  expect(html).not.toContain("run-log-thinking-details");
  expect(html).not.toContain("run-log-thinking run-log-feed-surface");
  expect(html).not.toContain("run-log-feed-surface-icon");
  expect(html).not.toContain("run-log-thinking-timing-inline");
  expect(html).not.toContain("· 耗时");
  expect(html).not.toContain(">思考</span>");
  expect(html).not.toContain("先检查事件投影，再统一渲染结构。");
});

test("ActivityLogView appends turn-style duration to completed thinking summary", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      thinkingDisplayMode: "collapsed",
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "thinking-final-timed",
            eventType: "thinking.final",
            role: "thinking",
            requestId: "req-thinking-timed",
            text: "带耗时的思考内容。",
            at: "2026-01-01T00:00:05.000Z",
            metadata: {
              thinkingStartedAt: "2026-01-01T00:00:00.000Z",
              thinkingDurationMs: 5000,
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("已思考 5s");
  expect(html).not.toContain("带耗时的思考内容。");
});

test("ActivityLogView appends live duration while thinking streams", () => {
  const startedAt = new Date(Date.now() - 4_500).toISOString();
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      thinkingDisplayMode: "collapsed",
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "thinking-delta-timed",
            eventType: "thinking.delta",
            role: "thinking",
            requestId: "req-thinking-live",
            text: "正在输出的思考内容",
            metadata: { thinkingStartedAt: startedAt },
          }),
        ],
        requestSpans: [
          requestSpan({
            requestId: "req-thinking-live",
            status: "streaming",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("正在思考 4s");
  expect(html).toContain("正在输出的思考内容");
});

test("ActivityLogView expands streaming thinking with live body text", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      thinkingDisplayMode: "collapsed",
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "thinking-delta",
            eventType: "thinking.delta",
            role: "thinking",
            requestId: "req-thinking-stream",
            text: "正在输出的思考内容",
          }),
        ],
        requestSpans: [
          requestSpan({
            requestId: "req-thinking-stream",
            status: "streaming",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-thinking streaming");
  expect(html).toContain("is-expanded");
  expect(html).toContain("正在思考");
  expect(html).toContain("run-log-thinking-details");
  expect(html).toContain("正在输出的思考内容");
});

test("ActivityLogView collapses multiple completed thinking items by default", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      thinkingDisplayMode: "collapsed",
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "thinking-first",
            eventType: "thinking.final",
            role: "thinking",
            requestId: "req-thinking-multi",
            streamKey: "reasoning-first",
            text: "第一段思考。",
            metadata: { logicalEntityId: "reasoning-first" },
          }),
          item({
            id: "thinking-second",
            eventType: "thinking.final",
            role: "thinking",
            requestId: "req-thinking-multi",
            streamKey: "reasoning-second",
            text: "第二段思考。",
            metadata: { logicalEntityId: "reasoning-second" },
            sequence: 2,
          }),
        ],
        requestSpans: [
          requestSpan({
            requestId: "req-thinking-multi",
            status: "completed",
            endedAt: "2026-01-01T00:00:09.000Z",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("已思考");
  expect(html).not.toContain("第一段思考。");
  expect(html).not.toContain("第二段思考。");
  expect(html).not.toContain("run-log-thinking-timing-inline");
  expect(html).not.toContain("· 耗时");
});

test("ActivityLogView keeps a running file write action as the only loading state", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        requestSpans: [requestSpan({ requestId: "req_write", status: "streaming" })],
        timeline: [
          item({
            id: "write-started",
            requestId: "req_write",
            text: "Tool: Write · src/big-file.ts",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Write",
                detail: "src/big-file.ts",
                toolUseId: "toolu_write_big",
                status: "started",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).not.toContain("run-log-inline-loading");
  expect(html).not.toContain('aria-label="会话进行中"');
  expect(html).not.toContain("run-log-streaming-dot");
});

test("ActivityLogView keeps loading in collapsed running tool groups without a separate tail", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        requestSpans: [requestSpan({ requestId: "req_tools", status: "streaming" })],
        timeline: [
          item({
            id: "write-started",
            sequence: 1,
            requestId: "req_tools",
            text: "Tool: Write · src/big-file.ts",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Write",
                detail: "src/big-file.ts",
                toolUseId: "toolu_write_big",
                status: "started",
              },
            },
          }),
          item({
            id: "read-started",
            sequence: 2,
            requestId: "req_tools",
            text: "Tool: Read · src/config.ts",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Read",
                detail: "src/config.ts",
                toolUseId: "toolu_read_config",
                status: "started",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-tool-group-trigger is-running");
  expect(html).toContain("正在读取 config.ts");
  expect(html).not.toContain("已写入 1 个文件和已读取 1 个文件");
  expect(html).not.toContain("run-log-inline-loading");
  expect(html).not.toContain('aria-label="会话进行中"');
  expect(html).not.toContain("run-log-streaming-dot");
});

test("ActivityLogView switches command groups from live action back to completed totals", () => {
  const completedCommands = Array.from({ length: 6 }, (_, index) =>
    item({
      id: `bash-completed-${index + 1}`,
      sequence: index + 1,
      eventType: "tool.completed",
      text: `Tool: Bash · echo ${index + 1}`,
      metadata: {
        tool: {
          name: "Bash",
          detail: `echo ${index + 1}`,
          toolUseId: `toolu_bash_${index + 1}`,
          status: "completed",
        },
      },
    }),
  );
  const latestCommand = "/bin/zsh -lc \"sed -n '1,180p' src/services/very-long-tool-status-file.ts\"";
  const runningCommand = item({
    id: "bash-running-7",
    sequence: 7,
    text: `Tool: Bash · ${latestCommand}`,
    metadata: {
      tool: {
        name: "Bash",
        detail: latestCommand,
        toolUseId: "toolu_bash_7",
        status: "started",
      },
    },
  });

  const runningHtml = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({ timeline: [...completedCommands, runningCommand] }),
    }),
  );
  expect(runningHtml).toContain("正在运行 /bin/zsh -lc &quot;sed -n");
  expect(runningHtml).toContain("run-log-shimmer-text");
  expect(runningHtml).not.toContain("已运行 6 条命令");

  const completedHtml = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          ...completedCommands,
          item({
            ...runningCommand,
            eventType: "tool.completed",
            metadata: {
              tool: {
                name: "Bash",
                detail: latestCommand,
                toolUseId: "toolu_bash_7",
                status: "completed",
              },
            },
          }),
        ],
      }),
    }),
  );
  expect(completedHtml).toContain("已运行 7 条命令");
  expect(completedHtml).not.toContain("正在运行");
  expect(completedHtml).not.toContain("run-log-shimmer-text");
});

test("ActivityLogView renders reasoning-stage as ephemeral tip status", () => {
  const tipOnlyHtml = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        timeline: [
          item({
            id: "stage-final",
            eventType: "thinking.final",
            role: "thinking",
            sequence: 1,
            streamKey: "rs_stage_final",
            text: "定位入口",
            metadata: { reasoningDisplay: "summary" },
          }),
        ],
      }),
    }),
  );
  // Final tip stays until a later hard event supersedes it — live tip lives in active-tail.
  expect(tipOnlyHtml).toContain("定位入口");
  expect(tipOnlyHtml).toContain("run-log-active-tail");
  expect(tipOnlyHtml).toContain('class="run-log-thinking streaming empty"');
  expect(tipOnlyHtml).toContain("run-log-shimmer-text");
  expect(tipOnlyHtml.match(/run-log-thinking streaming empty/g)?.length).toBe(1);

  const streamingHtml = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        timeline: [
          item({
            id: "stage-1",
            eventType: "thinking.final",
            role: "thinking",
            sequence: 1,
            streamKey: "rs_stage_1",
            text: "定位入口",
            metadata: { reasoningDisplay: "summary" },
          }),
          item({
            id: "bash-1",
            eventType: "tool.started",
            role: "tool",
            sequence: 2,
            streamKey: "tool_bash_1",
            text: "Tool: Bash · ls",
            metadata: {
              tool: { name: "Bash", detail: "ls", status: "started" },
            },
          }),
          item({
            id: "stage-2",
            eventType: "thinking.delta",
            role: "thinking",
            sequence: 3,
            streamKey: "rs_stage_2",
            text: "检查测试",
            metadata: { reasoningDisplay: "summary" },
          }),
        ],
      }),
    }),
  );
  // Tool supersedes stage-1; only live tip stage-2 remains (in active-tail).
  expect(streamingHtml).not.toContain("定位入口");
  expect(streamingHtml).toContain("检查测试");
  expect(streamingHtml).toContain("run-log-active-tail");
  expect(streamingHtml).toContain('class="run-log-thinking streaming empty"');
  expect(streamingHtml).toContain("run-log-shimmer-text");
  expect(streamingHtml.match(/run-log-thinking streaming empty/g)?.length).toBe(1);
  // The latest reasoning summary reuses the running tool slot instead of
  // rendering a second row underneath it.
  expect(streamingHtml).not.toContain("正在运行");
  expect(streamingHtml).not.toContain("run-log-thinking-trigger");
  expect(streamingHtml).not.toContain("run-log-thinking-icon");

  const replacedHtml = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        timeline: [
          item({
            id: "stage-a",
            eventType: "thinking.delta",
            role: "thinking",
            sequence: 1,
            streamKey: "rs_a",
            text: "第一阶段",
            metadata: { reasoningDisplay: "summary" },
          }),
          item({
            id: "stage-b",
            eventType: "thinking.delta",
            role: "thinking",
            sequence: 2,
            streamKey: "rs_b",
            text: "第二阶段",
            metadata: { reasoningDisplay: "summary" },
          }),
        ],
      }),
    }),
  );
  expect(replacedHtml).not.toContain("第一阶段");
  expect(replacedHtml).toContain("第二阶段");
  expect(replacedHtml.match(/run-log-thinking streaming empty/g)?.length).toBe(1);
  expect(replacedHtml).toContain("run-log-active-tail");

  const completedHtml = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "stage-done",
            eventType: "thinking.final",
            role: "thinking",
            sequence: 1,
            streamKey: "rs_stage_done",
            text: "已完成阶段",
            metadata: { reasoningDisplay: "summary" },
          }),
          item({
            id: "bash-done",
            eventType: "tool.completed",
            role: "tool",
            sequence: 2,
            streamKey: "tool_bash_done",
            text: "Tool: Bash · ls",
            metadata: {
              tool: { name: "Bash", detail: "ls", status: "completed" },
            },
          }),
        ],
      }),
    }),
  );
  // Tool after summary clears the tip; durable tool row remains.
  expect(completedHtml).not.toContain("已完成阶段");
  expect(completedHtml).toContain("运行了命令");
});

test("ActivityLogView stops playing the ephemeral reasoning tip once the conversation is no longer live", () => {
  // 阅后即焚 tip has no durable form. A run that ended without a superseding hard
  // event (crash / lost runtime — nothing lands after the tip) must not leave the
  // tip parked on the Feed still cycling its stages.
  for (const status of ["failed", "cancelled", "blocked", "completed", "idle"]) {
    const html = renderToStaticMarkup(
      createElement(ProjectionActivityLogView, {
        projection: projection({
          status,
          timeline: [
            item({
              id: `stage-${status}`,
              eventType: "thinking.final",
              role: "thinking",
              sequence: 1,
              streamKey: "rs_stage_stopped",
              text: "定位入口\n检查测试",
              metadata: { reasoningDisplay: "summary" },
            }),
          ],
        }),
      }),
    );
    expect(html).not.toContain("定位入口");
    expect(html).not.toContain("run-log-thinking streaming empty");
    expect(html).not.toContain("run-log-shimmer-text");
    expect(html).not.toContain("run-log-thinking-carousel");
  }

  // The shape the dev store actually holds after an interrupted run: the tip is the last
  // content row, and the only thing after it is a lifecycle row, which is not one of the
  // superseding event types.
  const interruptedHtml = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "idle",
        timeline: [
          item({
            id: "stage-interrupted",
            eventType: "thinking.final",
            role: "thinking",
            sequence: 1,
            streamKey: "rs_interrupted",
            text: "检查测试",
            metadata: { reasoningDisplay: "summary" },
          }),
          item({
            id: "agent-interrupted",
            eventType: "agent.interrupted",
            role: "planner",
            sequence: 2,
            text: "",
          }),
        ],
      }),
    }),
  );
  expect(interruptedHtml).not.toContain("检查测试");
  expect(interruptedHtml).not.toContain("run-log-thinking streaming empty");
  expect(interruptedHtml).not.toContain("run-log-thinking-carousel");
});

test("ActivityLogView keeps empty waiting and reasoning summary mutually exclusive in one active-tail", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "request-started",
            sequence: 1,
            eventType: "request.started",
            requestId: "req-summary-wait",
            text: "",
          }),
          item({
            id: "stage-tip",
            sequence: 2,
            eventType: "thinking.delta",
            role: "thinking",
            requestId: "req-summary-wait",
            streamKey: "rs_tip",
            text: "定位入口",
            metadata: { reasoningDisplay: "summary" },
          }),
        ],
        requestSpans: [
          requestSpan({
            requestId: "req-summary-wait",
            status: "streaming",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("定位入口");
  expect(html).toContain("run-log-active-tail");
  expect(html.match(/run-log-thinking streaming empty/g)?.length).toBe(1);
  // Tip replaced empty「正在思考」in the same slot — do not keep both labels.
  expect(html).not.toContain("正在思考");
  expect(html.match(/定位入口/g)?.length).toBe(1);
});

function settledWriteTimeline() {
  return [
    item({
      id: "write-1",
      sequence: 1,
      eventType: "tool.completed",
      requestId: "req-writing",
      text: "Tool: Write",
      at: "2026-01-01T00:00:01.000Z",
      metadata: {
        tool: { name: "Write", detail: "src/app.ts", status: "completed", durationMs: 120 },
      },
    }),
  ];
}

test("ActivityLogView gives the writing tool call the tool aggregate's slot instead of stacking", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: settledWriteTimeline(),
        requestSpans: [
          requestSpan({
            requestId: "req-writing",
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:02.000Z",
            writingTool: { kind: "file", target: "src/math.ts", since: "2026-01-01T00:00:05.000Z" },
          }),
        ],
      }),
    }),
  );

  // One slot: the settled aggregate row is taken over, not stacked under the write line.
  expect(html).toContain("run-log-active-tail");
  expect(html).toContain("正在写入 src/math.ts");
  expect(html).not.toContain("run-log-tool-group");
  expect(html.match(/run-log-thinking streaming empty/g)?.length).toBe(1);
});

test("ActivityLogView keeps the tool aggregate row while nothing is being written", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: settledWriteTimeline(),
        requestSpans: [
          requestSpan({
            requestId: "req-writing",
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:02.000Z",
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-tool-group");
  expect(html).not.toContain("run-log-active-tail");
});

test("ActivityLogView does not let a write line hide a tool that is still running", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "bash-running",
            sequence: 1,
            eventType: "tool.started",
            requestId: "req-writing",
            text: "Tool: Bash",
            at: "2026-01-01T00:00:01.000Z",
            metadata: { tool: { name: "Bash", detail: "bun test", status: "started" } },
          }),
        ],
        requestSpans: [
          requestSpan({
            requestId: "req-writing",
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:02.000Z",
            writingTool: { kind: "command", target: "bun test", since: "2026-01-01T00:00:05.000Z" },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-tool-group");
  expect(html).not.toContain("run-log-active-tail");
});

test("ActivityLogView swaps the aggregate row in place inside a running turn", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        attempts: [
          {
            attemptId: "attempt-writing",
            phase: "follow_up",
            retryIndex: 0,
            status: "running",
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        timeline: [
          item({
            id: "write-in-turn",
            sequence: 1,
            eventType: "tool.completed",
            runAttemptId: "attempt-writing",
            requestId: "req-writing",
            text: "Tool: Write",
            at: "2026-01-01T00:00:01.000Z",
            metadata: {
              tool: { name: "Write", detail: "src/app.ts", status: "completed", durationMs: 120 },
            },
          }),
        ],
        requestSpans: [
          requestSpan({
            requestId: "req-writing",
            status: "completed",
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:02.000Z",
            writingTool: { kind: "file", target: "src/math.ts", since: "2026-01-01T00:00:05.000Z" },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain('class="run-log-turn is-running is-expanded"');
  expect(html).toContain("正在写入 src/math.ts");
  expect(html).not.toContain("run-log-tool-group");
  // The turn the swap empties must not keep a hollow process gap above the write line.
  expect(html).toContain("run-log-turn-process-inner is-empty");
});

test("ActivityLogView closes an orphan tool row left by a cancelled attempt", () => {
  const projectionWithOrphan = (attemptStatus: "cancelled" | "running") =>
    projection({
      status: "running",
      attempts: [
        {
          attemptId: "attempt-stopped",
          phase: "follow_up",
          retryIndex: 0,
          status: attemptStatus,
          startedAt: "2026-01-01T00:00:00.000Z",
          ...(attemptStatus === "cancelled" && { endedAt: "2026-01-01T00:00:02.000Z" }),
        },
        {
          attemptId: "attempt-follow-up",
          phase: "follow_up",
          retryIndex: 1,
          status: "running",
          startedAt: "2026-01-01T00:00:10.000Z",
        },
      ],
      timeline: [
        item({
          id: "orphan-tool",
          sequence: 1,
          eventType: "tool.started",
          runAttemptId: "attempt-stopped",
          requestId: "req-orphan",
          text: "Tool: mcp__mysql__mysql_query",
          at: "2026-01-01T00:00:01.000Z",
          metadata: {
            tool: { name: "mcp__mysql__mysql_query", detail: "mysql/mysql_query", status: "started" },
          },
        }),
        item({
          id: "follow-up-prompt",
          sequence: 2,
          eventType: "thread.status",
          role: "user",
          text: "继续",
          at: "2026-01-01T00:00:10.000Z",
          metadata: { liveType: "thread.user_prompt" },
        }),
      ],
    });

  // The run the call started in was stopped and the call never reported terminal, so the row
  // cannot keep presenting itself as running: it would count elapsed time forever and hold the
  // Feed's live slot shut, costing every later turn its 「正在思考」row.
  const stopped = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, { projection: projectionWithOrphan("cancelled") }),
  );
  expect(stopped).toContain("run-log-active-tail");
  expect(stopped).toContain("正在思考");

  const stoppedViewModel = buildThreadRunProjectionViewModel(projectionWithOrphan("cancelled"), {
    id: "thr_loading",
    prompt: "",
  });
  const stoppedOrphan = stoppedViewModel.mainFeedEntries
    .flatMap((entry) =>
      entry.kind === "tool-group"
        ? entry.entries.map((child) => child.item)
        : entry.kind === "timeline" || entry.kind === "agent-echo"
          ? [entry.item]
          : [],
    )
    .find((timelineItem) => timelineItem.id === "orphan-tool");
  const stoppedBlock = stoppedOrphan ? projectionItemToDetailBlock(stoppedOrphan) : undefined;
  // The interrupted call keeps its row but stops claiming to be live.
  expect(stoppedBlock?.kind === "action" && stoppedBlock.lifecycle === "failed").toBe(true);
  expect(
    stoppedViewModel.mainFeedEntries.some((entry) =>
      entry.kind === "tool-group"
        ? entry.entries.some((child) => {
            const block = projectionItemToDetailBlock(child.item);
            return block?.kind === "action" && block.lifecycle === "running";
          })
        : false,
    ),
  ).toBe(false);

  // The same shape inside a live attempt is a genuine in-flight call and must keep its row.
  const live = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, { projection: projectionWithOrphan("running") }),
  );
  expect(live).not.toContain("run-log-active-tail");
  const liveViewModel = buildThreadRunProjectionViewModel(projectionWithOrphan("running"), {
    id: "thr_loading",
    prompt: "",
  });
  const liveOrphan = liveViewModel.mainFeedEntries
    .flatMap((entry) =>
      entry.kind === "tool-group"
        ? entry.entries.map((child) => child.item)
        : entry.kind === "timeline" || entry.kind === "agent-echo"
          ? [entry.item]
          : [],
    )
    .find((timelineItem) => timelineItem.id === "orphan-tool");
  const liveBlock = liveOrphan ? projectionItemToDetailBlock(liveOrphan) : undefined;
  expect(liveBlock?.kind === "action" && liveBlock.lifecycle === "running").toBe(true);
});

test("splitThinkingCarouselLines prefers newlines and sentence boundaries over camelCase", () => {
  expect(
    splitThinkingCarouselLines(
      "Planning summary placement after tool outputs\nRefining summary and tool collapse logic",
    ),
  ).toEqual(["Planning summary placement after tool outputs", "Refining summary and tool collapse logic"]);
  expect(splitThinkingCarouselLines("先定位事件合并。再检查 Feed 投影。")).toEqual([
    "先定位事件合并。",
    "再检查 Feed 投影。",
  ]);
  expect(splitThinkingCarouselLines("Done.Next stage starts")).toEqual(["Done.", "Next stage starts"]);
  // No camelCase heuristic — glued TitleCase without punctuation stays one stage.
  expect(
    splitThinkingCarouselLines(
      "Planning summary placement after tool outputsRefining summary and tool collapse logic",
    ),
  ).toEqual(["Planning summary placement after tool outputsRefining summary and tool collapse logic"]);
  expect(splitThinkingCarouselLines("HTTPServer remains one stage")).toEqual([
    "HTTPServer remains one stage",
  ]);
  expect(splitThinkingCarouselLines("Ship iPhone build next")).toEqual(["Ship iPhone build next"]);
});

test("reasoningSummaryLabel separates adjacent bold summary stage titles", () => {
  expect(reasoningSummaryLabel("**Planning ordered file reading****Confirming path**")).toBe(
    "Planning ordered file reading\nConfirming path",
  );
  expect(reasoningSummaryLabel("**Planning ordered file reading**\n**Confirming path**")).toBe(
    "Planning ordered file reading\nConfirming path",
  );
});

test("ActivityLogView renders subagent card without mounting subagent detail timeline", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        timeline: [],
        agents: [
          agent({
            agentId: "agent_coder_1",
            taskName: "implement_drawer",
            delegationPrompt: "实现抽屉",
            timeline: [
              item({
                id: "agent-detail",
                eventType: "message.final",
                scope: "agent",
                role: "coder",
                text: "这段正文只应该在右侧详情里出现",
              }),
            ],
          }),
        ],
      }),
      onOpenSubagent: () => undefined,
    }),
  );

  expect(html).toContain("subagent-run-row");
  expect(html).toContain("subagent-run-row run-log-feed-surface");
  expect(html).toContain("Implement Drawer");
  expect(html).toContain("实现抽屉");
  expect(html).not.toContain("#coder_1");
  expect(html).not.toContain("subagent-run-agent-chip");
  expect(html).not.toContain("这段正文只应该在右侧详情里出现");
  expect(html).not.toContain("work-session-details-compact");
});

test("WorkspaceFloatingCards lists subagents without mounting unselected detail timelines", () => {
  const subagent = agent({
    agentId: "agent_coder_1",
    nickname: "Goodall",
    taskName: "implement_drawer",
    delegationPrompt: "实现抽屉",
    timeline: [
      item({
        id: "agent-detail",
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: "这段详情不应该默认挂载",
      }),
    ],
  });
  const element = createElement(WorkspaceFloatingCards, {
    hasActiveThread: true,
    subagentRunCards: [
      {
        key: subagent.agentId,
        agent: subagent,
        timelineIds: subagent.timeline.map((entry) => entry.id),
        running: false,
        missionText: "实现抽屉",
        openable: true,
      },
    ],
    onOpenSubagent: () => undefined,
  });
  const chineseHtml = renderLocalized(element, "zh-CN");
  const englishHtml = renderLocalized(element, "en-US");

  expect(chineseHtml).toContain("workspace-subagent-runs-list");
  expect(chineseHtml).toContain("子智能体");
  expect(chineseHtml).toContain("Goodall");
  expect(chineseHtml).toContain("Implement Drawer");
  expect(chineseHtml).not.toContain("实现抽屉");
  expect(chineseHtml).not.toContain("这段详情不应该默认挂载");
  expect(englishHtml).toContain("Subagents");
  expect(englishHtml).not.toContain("这段详情不应该默认挂载");
});

test("ProjectionSubagentDetailFeed renders subagent details as a conversation", () => {
  const subagent = agent({
    agentId: "agent_coder_1",
    status: "completed",
    durationMs: 128_000,
    delegationPrompt: "只读检查路由链路",
    timeline: [
      item({
        id: "agent-detail",
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: "检查完成，问题在 role fallback。",
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: subagent,
      missionText: "只读检查路由链路",
      images: [{ id: "image-1", mediaType: "image/png", data: "YWJj" }],
      requestSpansById: new Map(),
      threadActive: false,
    }),
  );

  expect(html).toContain("subagent-conversation-prompt");
  expect(html).toContain("run-log subagent-conversation-log-content");
  expect(html).toContain("run-log-feed-entry");
  expect(html).toContain("run-log-user-prompt-bubble");
  expect(html).toContain("run-log-user-prompt-body-wrap");
  expect(html).toContain("run-log-user-prompt-images");
  expect(html).toContain("data:image/png;base64,YWJj");
  expect(html).toContain("只读检查路由链路");
  expect(html).toContain("已处理 2m 8s");
  expect(html).toContain("检查完成，问题在 role fallback。");
  expect(html).toContain('class="run-log-turn-final"');
  expect(html).not.toContain("subagent-conversation-result");
  expect(html).not.toMatch(/>执行结果</);
  expect(html).not.toMatch(/>最终汇总</);
  // Long mission text must live inside the scrollable log so the feed stays reachable.
  expect(html.indexOf("subagent-conversation-log")).toBeGreaterThan(-1);
  expect(html.indexOf("subagent-conversation-prompt")).toBeGreaterThan(
    html.indexOf("subagent-conversation-log"),
  );
});

test("ProjectionSubagentDetailFeed collapses a thinking delta prefix into its final item", () => {
  const subagent = agent({
    agentId: "agent_thinking_stream",
    status: "active",
    timeline: [
      item({
        id: "thinking-delta",
        sequence: 1,
        eventType: "thinking.delta",
        scope: "agent",
        role: "thinking",
        requestId: "request-1",
        streamKey: "thinking-stream-1",
        text: "The",
      }),
      item({
        id: "thinking-final",
        sequence: 2,
        eventType: "thinking.final",
        scope: "agent",
        role: "thinking",
        requestId: "request-1",
        streamKey: "thinking-stream-1",
        text: "The tool result needs closer inspection.",
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: subagent,
      missionText: "检查工具输出",
      requestSpansById: new Map(),
      threadActive: true,
      thinkingDisplayMode: "collapsed",
    }),
  );

  expect(html).toContain("已思考");
  expect(html.match(/已思考/g)?.length).toBe(1);
  expect(html).not.toContain("The tool result needs closer inspection.");
  expect(html).not.toMatch(/>The</);
});

test("ProjectionSubagentDetailFeed marks only the last completed summary as result and removes its phase echo", () => {
  const completedAgent = agent({
    agentId: "agent_coder_final",
    status: "completed",
    timeline: [
      item({
        id: "intermediate-message",
        sequence: 1,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: "我先检查了事件投影。",
      }),
      item({
        id: "final-phase-echo",
        sequence: 2,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: "修复完成，重复结果已移除。",
        metadata: { activityOrigin: "sdk.upstream_error" },
      }),
      item({
        id: "final-summary",
        sequence: 3,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: "修复完成，重复结果已移除。",
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: completedAgent,
      missionText: "修复子代理结果展示",
      requestSpansById: new Map(),
      threadActive: false,
    }),
  );

  expect(html.match(/class="run-log-turn-final"/g)?.length ?? 0).toBe(1);
  expect(html.match(/修复完成，重复结果已移除。/g)?.length ?? 0).toBe(1);
  expect(html).not.toContain("我先检查了事件投影。");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("run-log-phase");
});

test("ProjectionSubagentDetailFeed does not expose a result before the subagent ends", () => {
  const runningAgent = agent({
    agentId: "agent_coder_running",
    status: "active",
    timeline: [
      item({
        id: "running-message",
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: "当前只是执行过程中的正文。",
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: runningAgent,
      missionText: "继续执行",
      requestSpansById: new Map(),
      threadActive: true,
    }),
  );

  expect(html).toContain("当前只是执行过程中的正文。");
  expect(html).not.toContain("run-log-turn-final");
  expect(html).not.toContain("执行结果");
});

test("ProjectionSubagentDetailFeed renders four runtime metric cards with billing and model combined", () => {
  const measuredAgent = agent({
    agentId: "agent_coder_metrics",
    status: "completed",
    usage: {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 900,
      cacheCreationTokens: 80,
      ecoCostUsd: 0.0123,
      modelId: "claude-sonnet-4-5",
    },
    context: {
      occupied: 24000,
      limit: 200000,
      occupancyPct: 12,
      modelId: "claude-sonnet-4-5",
    },
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: measuredAgent,
      missionText: "统计运行指标",
      requestSpansById: new Map(),
      threadActive: false,
    }),
  );

  for (const label of ["输入输出", "缓存", "上下文", "计费 / 模型"]) {
    expect(html).toContain(label);
  }
  expect(html).toContain("subagent-run-instance-metric--billing-model");
  expect(html.match(/subagent-run-instance-metric /g)?.length ?? 0).toBe(4);
});

test("ActivityLogView summarizes Bash with adjacent file tools", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "bash-done",
            sequence: 1,
            eventType: "tool.completed",
            text: "Tool: Bash · bun test",
            metadata: {
              tool: {
                name: "Bash",
                detail: "bun test",
                toolUseId: "toolu_bash",
                status: "completed",
                output: "2 pass",
              },
            },
          }),
          item({
            id: "read-done-after-bash",
            sequence: 2,
            eventType: "tool.completed",
            text: "Tool: Read · src/index.ts",
            metadata: {
              tool: {
                name: "Read",
                detail: "src/index.ts",
                toolUseId: "toolu_read_after_bash",
                status: "completed",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-tool-group");
  expect(html).toContain("已读取 1 个文件和已运行 1 条命令");
  expect(html).not.toContain("run-log-action--bash-card");
});

test("ActivityLogView renders imageView as a standalone collapsed preview", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "image-view-feed",
            eventType: "tool.completed",
            text: "Tool: ViewImage · /tmp/feed-preview.png",
            metadata: {
              itemType: "imageView",
              tool: {
                name: "ViewImage",
                detail: "/tmp/feed-preview.png",
                toolUseId: "item_image_view_feed",
                status: "completed",
                imageView: { path: "/tmp/feed-preview.png" },
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-image-view");
  expect(html).toContain('class="run-log-tool-group-trigger run-log-image-view-summary"');
  expect(html).toContain('class="run-log-action-icon-wrap"');
  expect(html).toContain('class="lucide lucide-images run-log-action-icon"');
  expect(html).not.toContain("run-log-tool-group-chevron open");
  expect(html).toContain("已查看 1 张图像");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("feed-preview.png");
  expect(html).not.toContain("/tmp/feed-preview.png");
  expect(html).not.toContain("正在读取本地图片");
  expect(html).not.toContain('class="run-log-tool-group"');
});

test("ActivityLogView upgrades persisted imageView gaps instead of rendering unknown payload", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "tre:codex:unprojected:exec-image-view-feed",
            eventType: "thread.status",
            text: "未知类型 · imageView",
            metadata: {
              liveType: "codex.item.unprojected",
              itemType: "imageView",
              unprojectedPhase: "completed",
              payloadJson: JSON.stringify({
                type: "imageView",
                id: "exec-image-view-feed",
                path: "/tmp/feed-preview.png",
              }),
              gap: true,
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-image-view");
  expect(html).toContain("已查看 1 张图像");
  expect(html).not.toContain("run-log-unknown-item");
  expect(html).not.toContain("未知类型原始数据");
  expect(html).not.toContain("/tmp/feed-preview.png");
});

test("ActivityLogView shimmers a running imageView and hides waiting thinking", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [requestSpan({ requestId: "req_image", status: "streaming" })],
        timeline: [
          item({
            id: "thinking-empty",
            sequence: 1,
            requestId: "req_image",
            eventType: "thinking.delta",
            role: "thinking",
            text: "",
            streamKey: "thinking:req_image",
            metadata: { liveType: "thinking.delta" },
          }),
          item({
            id: "image-view-running",
            sequence: 2,
            requestId: "req_image",
            eventType: "tool.started",
            text: "Tool: mcp__eco_image_view__view_image · /tmp/feed-preview.png",
            metadata: {
              liveType: "tool.started",
              itemType: "mcpToolCall",
              tool: {
                name: "mcp__eco_image_view__view_image",
                detail: "/tmp/feed-preview.png",
                toolUseId: "item_mcp_view_running",
                status: "started",
                imageView: { path: "/tmp/feed-preview.png" },
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-image-view");
  expect(html).toContain("正在查看 1 张图像");
  expect(html).toContain("run-log-shimmer-text");
  expect(html).not.toContain('aria-label="会话进行中"');
  expect(html).not.toContain("正在思考");
});

test("ActivityLogView hides waiting thinking while context compaction is running", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [requestSpan({ requestId: "req_compact", status: "streaming" })],
        timeline: [
          item({
            id: "thinking-empty",
            sequence: 1,
            requestId: "req_compact",
            eventType: "thinking.delta",
            role: "thinking",
            text: "",
            streamKey: "thinking:req_compact",
            metadata: { liveType: "thinking.delta" },
          }),
          item({
            id: "compact-start",
            sequence: 2,
            eventType: "context.compaction.started",
            text: "正在自动压缩上下文",
            metadata: { liveType: "context.compaction.started" },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("正在自动压缩上下文");
  expect(html).toContain("run-log-context-action");
  expect(html).toContain('<span class="run-log-shimmer-text" aria-live="polite">正在自动压缩上下文</span>');
  expect(html).not.toContain("正在思考");
  expect(html).not.toContain("run-log-streaming-dots");
  expect(html).not.toContain('aria-label="会话进行中"');
});

test.each([
  "正在自动压缩上下文",
  "正在手动压缩上下文",
  "正在压缩上下文",
])("ActivityLogView shimmers %s while counting elapsed time in the text flow", (label) => {
  const startedAt = new Date(Date.now() - 10_500).toISOString();
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "compact-start",
            eventType: "context.compaction.started",
            text: label,
            at: startedAt,
            metadata: { liveType: "context.compaction.started" },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain(
    `<span class="run-log-shimmer-text" aria-live="polite">${label}</span><span class="run-log-action-elapsed run-log-action-elapsed--inline">10s</span>`,
  );
  expect(html).not.toContain('class="run-log-action-meta run-log-action-elapsed"');
});

test.each([
  { eventType: "context.compaction.completed", label: "上下文已自动压缩" },
  { eventType: "context.compaction.failed", label: "上下文压缩失败：请求失败" },
])("ActivityLogView stops shimmering after $eventType and retains the duration", ({ eventType, label }) => {
  const startedAt = "2026-01-01T00:00:01.000Z";
  const endedAt = "2026-01-01T00:00:14.000Z";
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "idle",
        timeline: [
          item({
            id: "compact-start",
            sequence: 1,
            eventType: "context.compaction.started",
            text: "正在自动压缩上下文",
            at: startedAt,
          }),
          item({
            id: "compact-done",
            sequence: 2,
            eventType,
            text: label,
            at: endedAt,
            metadata: { compactionTiming: { startedAt, endedAt, durationMs: 13_000 } },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain(
    `${label}<span class="run-log-action-elapsed run-log-action-elapsed--inline">13s</span>`,
  );
  expect(html).not.toContain("run-log-shimmer-text");
  expect(html).not.toContain('class="run-log-action-meta run-log-action-elapsed"');
});

test("ActivityLogView keeps a running tool group's elapsed time after its summary", () => {
  const at = new Date(Date.now() - 10_500).toISOString();
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        attempts: [{ attemptId: "attempt_loading", status: "running", startedAt: at }],
        timeline: [
          item({
            id: "tool-run",
            eventType: "tool.started",
            text: "Tool: Bash",
            at,
            metadata: { name: "Bash", status: "started", liveType: "tool.started" },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain('class="run-log-tool-group-elapsed">10s<');
  expect(html).not.toContain("run-log-action-elapsed--inline");
});

test("ActivityLogView hides waiting thinking while an MCP tool is running", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [requestSpan({ requestId: "req_mcp", status: "streaming" })],
        timeline: [
          item({
            id: "thinking-empty",
            sequence: 1,
            requestId: "req_mcp",
            eventType: "thinking.delta",
            role: "thinking",
            text: "",
            streamKey: "thinking:req_mcp",
            metadata: { liveType: "thinking.delta" },
          }),
          item({
            id: "mcp-running",
            sequence: 2,
            requestId: "req_mcp",
            eventType: "tool.started",
            text: "Tool: mcp__eco_browser__browser_snapshot",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "mcp__eco_browser__browser_snapshot",
                detail: "snapshot",
                toolUseId: "toolu_mcp_snapshot",
                status: "started",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("正在调用 eco_browser · browser snapshot");
  expect(html).not.toContain('aria-label="会话进行中"');
  expect(html).not.toContain("正在思考");
});

test("ActivityLogView shows external MCP names in running and completed group headers", () => {
  for (const server of ["mysql", "mongo"]) {
    for (const phase of ["started", "completed"] as const) {
      const name = `mcp__${server}__query`;
      const html = renderToStaticMarkup(
        createElement(ProjectionActivityLogView, {
          projection: projection({
            status: phase === "started" ? "running" : "completed",
            timeline: [
              item({
                id: `${server}-${phase}`,
                eventType: `tool.${phase}`,
                text: `Tool: ${name}`,
                metadata: {
                  liveType: `tool.${phase}`,
                  tool: { name, toolUseId: `${server}-query`, status: phase },
                },
              }),
            ],
          }),
        }),
      );
      expect(html).toContain(`${phase === "started" ? "正在调用" : "调用了"} ${server} · query`);
      expect(html).not.toContain("正在调用 MCP");
      expect(html).not.toContain("调用了 MCP 工具");
    }
  }
});

test("ActivityLogView separates mysql and mongo in a completed MCP group summary", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: ["mysql", "mysql", "mongo"].map((server, index) => {
          const name = `mcp__${server}__query`;
          return item({
            id: `mcp-completed-${index}`,
            sequence: index + 1,
            eventType: "tool.completed",
            text: `Tool: ${name}`,
            metadata: {
              liveType: "tool.completed",
              tool: { name, toolUseId: `mcp-query-${index}`, status: "completed" },
            },
          });
        }),
      }),
    }),
  );
  expect(html).toContain("已调用 mysql 2 次和已调用 mongo 1 次");
  expect(html).not.toContain("已调用 3 个 MCP 工具");
});

test("ActivityLogView hides waiting thinking while a file tool is running", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        requestSpans: [requestSpan({ requestId: "req_write_think", status: "streaming" })],
        timeline: [
          item({
            id: "thinking-empty",
            sequence: 1,
            requestId: "req_write_think",
            eventType: "thinking.delta",
            role: "thinking",
            text: "",
            streamKey: "thinking:req_write_think",
            metadata: { liveType: "thinking.delta" },
          }),
          item({
            id: "write-started",
            sequence: 2,
            requestId: "req_write_think",
            eventType: "tool.started",
            text: "Tool: Write · src/big-file.ts",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Write",
                detail: "src/big-file.ts",
                toolUseId: "toolu_write_think",
                status: "started",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("正在写入");
  expect(html).not.toContain('aria-label="会话进行中"');
  expect(html).not.toContain("正在思考");
});

test("ActivityLogView renders Eco MCP view_image as the image preview, not a web search", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "eco-mcp-image-view-feed",
            eventType: "tool.completed",
            text: "Tool: mcp__eco_image_view__view_image · /tmp/feed-preview.png",
            metadata: {
              itemType: "mcpToolCall",
              tool: {
                name: "mcp__eco_image_view__view_image",
                detail: "/tmp/feed-preview.png",
                toolUseId: "item_mcp_view_feed",
                status: "completed",
                imageView: { path: "/tmp/feed-preview.png" },
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-image-view");
  expect(html).toContain("已查看 1 张图像");
  expect(html).not.toContain("联网搜索");
  expect(html).not.toContain("调用了 MCP 工具");
});

test("ActivityLogView labels PI mcp proxy discovery as searching MCP tools", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "pi-mcp-search",
            eventType: "tool.completed",
            text: "Tool: mcp",
            metadata: {
              tool: {
                name: "mcp",
                toolUseId: "tool_mcp_search",
                status: "completed",
                mcpDiscovery: { kind: "search" },
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("查找 MCP 工具");
  expect(html).not.toContain("已查找 MCP 工具");
  expect(html).not.toContain("调用了 MCP 工具");
  expect(html).not.toContain("联网搜索");
  expect(html).not.toContain("已搜索代码");
});

test("ActivityLogView labels running PI mcp proxy discovery as searching MCP tools", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "pi-mcp-search-running",
            eventType: "tool.started",
            text: "Tool: mcp",
            metadata: {
              tool: {
                name: "mcp",
                toolUseId: "tool_mcp_search_running",
                status: "started",
                mcpDiscovery: { kind: "search" },
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("正在查找 MCP 工具");
  expect(html).not.toContain("正在调用 MCP");
  expect(html).not.toContain("联网搜索");
});

test("ActivityLogView still labels a real PI mcp tool call as MCP", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "pi-mcp-real-tool",
            eventType: "tool.completed",
            text: "Tool: mcp",
            metadata: {
              tool: {
                name: "mcp",
                toolUseId: "tool_mcp_real",
                status: "completed",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("调用了 MCP 工具");
  expect(html).not.toContain("查找 MCP 工具");
  expect(html).not.toContain("联网搜索");
});

test("ActivityLogView collapses a single completed tool behind the shared summary", () => {
  const cases = [
    { name: "Bash", detail: "bun test", expected: "运行了命令" },
    { name: "Read", detail: "src/App.tsx", expected: "读取了 App.tsx" },
    { name: "Edit", detail: "src/App.tsx", expected: "编辑了 App.tsx" },
  ] as const;

  for (const toolCase of cases) {
    const html = renderToStaticMarkup(
      createElement(ProjectionActivityLogView, {
        projection: projection({
          status: "completed",
          timeline: [
            item({
              id: `single-${toolCase.name.toLowerCase()}`,
              eventType: "tool.completed",
              text: `Tool: ${toolCase.name} · ${toolCase.detail}`,
              metadata: {
                tool: {
                  name: toolCase.name,
                  detail: toolCase.detail,
                  toolUseId: `toolu_single_${toolCase.name.toLowerCase()}`,
                  status: "completed",
                  ...(toolCase.name === "Bash" && { output: "2 pass" }),
                },
              },
            }),
          ],
        }),
      }),
    );

    expect(html).toContain("run-log-tool-group-trigger");
    expect(html).toContain(toolCase.expected);
    expect(html).not.toContain("run-log-action-trigger");
    expect(html).not.toContain("run-log-action--bash-card");
  }
});

test("ProjectionToolGroupEntry keeps a single Bash command behind a child disclosure", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "single-bash-expanded",
          eventType: "tool.completed",
          text: "Tool: Bash · bun test",
          metadata: {
            tool: {
              name: "Bash",
              detail: "bun test",
              toolUseId: "toolu_single_bash_expanded",
              status: "completed",
              outputPreview: "2 pass",
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("single Bash tool group missing");
  }

  const html = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );

  expect(html.match(/运行了 bun test/g)?.length).toBe(1);
  expect(html).toContain("运行了命令");
  expect(html).toContain("run-log-tool-group-child-trigger");
  expect(html).toContain("bun test");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("run-log-bash-command");
  expect(html).not.toContain("run-log-bash-output");
  expect(html).not.toContain("2 pass");
});

test("ProjectionToolGroupEntry renders Read/Grep children as icon plus action line, not a special verb row", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "read-structured",
          eventType: "tool.completed",
          text: "Tool: Read · ActivityLogView.tsx:L120-159",
          metadata: {
            tool: {
              name: "Read",
              detail: "ActivityLogView.tsx:L120-159",
              toolUseId: "toolu_read_child",
              status: "completed",
              readTarget: {
                filePath: "/repo/apps/desktop/src/renderer/ActivityLogView.tsx",
                offset: 120,
                limit: 40,
              },
            },
          },
        }),
        item({
          id: "grep-structured",
          eventType: "tool.completed",
          text: "Tool: Grep · RunLogAction",
          sequence: 2,
          metadata: {
            tool: {
              name: "Grep",
              detail: "RunLogAction",
              toolUseId: "toolu_grep_child",
              status: "completed",
              grepTarget: {
                pattern: "RunLogAction",
                path: "apps/desktop/src/renderer",
              },
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("Read/Grep tool group missing");
  }

  const html = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );

  expect(html).toContain("run-log-action-icon");
  expect(html).toContain("lucide-book-open");
  expect(html).toContain("读取了 ActivityLogView.tsx L120-159");
  expect(html).toContain("搜索了 RunLogAction");
  expect(html).not.toContain("run-log-action--read-target");
  expect(html).not.toContain("run-log-action--grep-target");
  expect(html).not.toContain("run-log-read-target-verb");
  expect(html).not.toContain("run-log-grep-target-verb");
});

test("ProjectionToolGroupEntry shows concrete details for grouped tool children", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "bash-test",
          sequence: 1,
          eventType: "tool.completed",
          text: "Tool: Bash · bun test",
          metadata: {
            tool: {
              name: "Bash",
              detail: "bun test",
              toolUseId: "toolu_bash_test",
              status: "completed",
            },
          },
        }),
        item({
          id: "bash-lint",
          sequence: 2,
          eventType: "tool.completed",
          text: "Tool: Bash · bun lint",
          metadata: {
            tool: {
              name: "Bash",
              detail: "bun lint",
              toolUseId: "toolu_bash_lint",
              status: "completed",
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("grouped Bash tools missing");
  }

  const html = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );

  expect(html).toContain("已运行 2 条命令");
  expect(html).toContain("运行了 bun test");
  expect(html).toContain("运行了 bun lint");
  expect(html).not.toContain("运行了命令");
});

test("ActivityLogView summarizes a failed Edit as an edit, not a command", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "failed",
        timeline: [
          item({
            id: "edit-started",
            sequence: 1,
            eventType: "tool.started",
            text: "Tool: edit · panel.ts",
            metadata: {
              tool: {
                name: "edit",
                toolUseId: "tc_edit",
                status: "started",
                fileChange: { path: "panel.ts", kind: "edit", additions: 1, deletions: 0 },
              },
            },
          }),
          item({
            id: "edit-failed",
            sequence: 2,
            eventType: "tool.failed",
            text: "Tool failed: edit: Found 2 occurrences of the text",
            metadata: {
              tool: {
                name: "edit",
                toolUseId: "tc_edit",
                status: "failed",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("编辑了 panel.ts");
  expect(html).not.toContain("编辑了文件");
  expect(html).not.toContain("运行了命令");
  expect(html.match(/run-log-tool-group-trigger/g)?.length).toBe(1);
});

test("ActivityLogView flattens a failed Bash command behind a subtle status dot", () => {
  const failedProjection = projection({
    status: "failed",
    timeline: [
      item({
        id: "bash-started",
        sequence: 1,
        eventType: "tool.started",
        text: "Tool: Bash · bun test",
        metadata: {
          tool: {
            name: "Bash",
            detail: "bun test",
            toolUseId: "toolu_bash_failed",
            status: "started",
          },
        },
      }),
      item({
        id: "bash-failed",
        sequence: 2,
        eventType: "tool.failed",
        text: "Tool failed: Bash: Exit code 1",
        metadata: {
          tool: {
            name: "Bash",
            detail: "Exit code 1\n1 test failed",
            toolUseId: "toolu_bash_failed",
            status: "failed",
            outputPreview: "Exit code 1\n1 test failed",
          },
        },
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: failedProjection,
    }),
  );

  expect(html).toContain("run-log-tool-group-trigger");
  expect(html).toContain("运行了命令");
  // Aggregated group titles omit the failure dot; open the group to see it on the Bash child.
  expect(html).not.toContain("run-log-tool-status-dot");
  expect(html).not.toContain("工具未完成");
  expect(html).not.toContain("run-log-tool-group-trigger is-failed");
  expect(html).not.toContain("run-log-bash-command");
  expect(html).not.toContain("run-log-bash-output");
  expect(html).not.toContain("1 test failed");

  const entry = buildThreadRunProjectionViewModel(failedProjection).mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("failed Bash tool group missing");
  }
  const expandedHtml = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );

  expect(expandedHtml).toContain("运行了命令");
  expect(expandedHtml).toContain("运行了 bun test");
  expect(expandedHtml).toContain("bun test");
  expect(expandedHtml).toContain("run-log-tool-group-child-trigger");
  expect(expandedHtml).not.toContain("run-log-action--bash-card");
  expect(expandedHtml).toContain('aria-expanded="false"');
  expect(expandedHtml.match(/run-log-tool-status-dot/g)?.length).toBe(1);
  expect(expandedHtml).not.toContain("run-log-bash-command");
  expect(expandedHtml).not.toContain("run-log-bash-output");
  expect(expandedHtml).not.toContain("1 test failed");
});

test("failed Bash action uses the completed command style plus a status dot", () => {
  const renderCommand = (status: "completed" | "failed") =>
    renderToStaticMarkup(
      createElement(ProjectionActivityLogView, {
        projection: projection({
          timeline: [
            item({
              id: `bash-${status}`,
              eventType: "tool.completed",
              text: "Tool: Bash · bun test",
              metadata: {
                tool: {
                  name: "Bash",
                  detail: "bun test",
                  toolUseId: `toolu_bash_${status}`,
                  status,
                  outputPreview: "2 pass",
                },
              },
            }),
          ],
        }),
      }),
    );

  const completedHtml = renderCommand("completed");
  const failedHtml = renderCommand("failed");
  const triggerClass = (html: string) => html.match(/class="([^"]*run-log-tool-group-trigger[^"]*)"/)?.[1];

  expect(triggerClass(failedHtml)).toBe(triggerClass(completedHtml));
  // Collapsed aggregate summary has no failure dot.
  expect(completedHtml).not.toContain("run-log-tool-status-dot");
  expect(failedHtml).not.toContain("run-log-tool-status-dot");
  expect(failedHtml).not.toContain("is-failed");

  const entry = buildThreadRunProjectionViewModel(
    projection({
      timeline: [
        item({
          id: "bash-failed",
          eventType: "tool.completed",
          text: "Tool: Bash · bun test",
          metadata: {
            tool: {
              name: "Bash",
              detail: "bun test",
              toolUseId: "toolu_bash_failed",
              status: "failed",
              outputPreview: "2 pass",
            },
          },
        }),
      ],
    }),
  ).mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("failed Bash tool group missing");
  }
  const expandedFailedHtml = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );
  // Failure indicator belongs on the Bash child title after expand.
  expect(expandedFailedHtml.match(/run-log-tool-status-dot/g)?.length).toBe(1);
});

test("ActivityLogView aggregates a group that mixes commands with a failed image view", () => {
  const mixedProjection = projection({
    status: "completed",
    timeline: [
      item({
        id: "bash-ok-1",
        sequence: 1,
        eventType: "tool.completed",
        text: 'Tool: Bash · export PATH="$PATH:/sdk/platform-tools"; adb devices',
        metadata: {
          tool: {
            name: "Bash",
            detail: 'export PATH="$PATH:/sdk/platform-tools"; adb devices',
            toolUseId: "toolu_bash_ok_1",
            status: "completed",
          },
        },
      }),
      item({
        id: "image-view-failed",
        sequence: 2,
        eventType: "tool.failed",
        text: "Tool failed: mcp: Failed to call tool: Request timed out",
        metadata: {
          itemType: "mcpToolCall",
          tool: {
            name: "mcp__eco_image_view__view_image",
            detail: "Failed to call tool: Request timed out",
            toolUseId: "toolu_image_view_failed",
            status: "failed",
            imageView: { path: "/tmp/cascade_land_fix_small.png" },
          },
        },
      }),
      item({
        id: "bash-ok-2",
        sequence: 3,
        eventType: "tool.completed",
        text: "Tool: Bash · bun test",
        metadata: {
          tool: {
            name: "Bash",
            detail: "bun test",
            toolUseId: "toolu_bash_ok_2",
            status: "completed",
          },
        },
      }),
    ],
  });

  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, { projection: mixedProjection }),
  );

  // The group title summarizes every tool call it holds; one failed image view must
  // never retitle a group of commands.
  expect(html).toContain("已运行 2 条命令和已处理 1 张图像");
  expect(html).not.toContain("已查看 1 张图像");

  const entry = buildThreadRunProjectionViewModel(mixedProjection).mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("mixed tool group missing");
  }
  const expandedHtml = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );

  expect(expandedHtml).toContain("已运行 2 条命令和已处理 1 张图像");
  expect(expandedHtml).toContain("运行了 bun test");
  // The failed image view keeps its own copy and status dot on the child row.
  expect(expandedHtml).toContain("已查看 1 张图像");
  expect(expandedHtml.match(/run-log-tool-status-dot/g)?.length).toBe(1);
});

test("ActivityLogView keeps a lone failed tool's own copy as the group title", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "image-view-failed",
            sequence: 1,
            eventType: "tool.failed",
            text: "Tool failed: mcp: Failed to call tool: Request timed out",
            metadata: {
              itemType: "mcpToolCall",
              tool: {
                name: "mcp__eco_image_view__view_image",
                detail: "Failed to call tool: Request timed out",
                toolUseId: "toolu_image_view_failed",
                status: "failed",
                imageView: { path: "/tmp/cascade_land_fix_small.png" },
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("已查看 1 张图像");
  expect(html.match(/run-log-tool-group-trigger/g)?.length).toBe(1);
});

test("SubagentTaskDrawer shows live running status text in subagent tabs", () => {
  const subagent = agent({
    agentId: "agent_coder_1",
    status: "active",
    timeline: [],
  });
  const html = renderToStaticMarkup(
    createElement(SubagentTaskDrawer, {
      open: true,
      fullscreen: false,
      cards: [
        {
          key: subagent.agentId,
          agent: subagent,
          timelineIds: [],
          running: true,
          statusText: "正在读取 src/config.ts",
          missionText: "检查配置",
          openable: true,
        },
      ],
      activeTab: subagent.agentId,
      openTabIds: [subagent.agentId],
      backgroundTasks: [],
      onSelectAgent: () => undefined,
      onSelectPlan: () => undefined,
      onCloseTab: () => undefined,
      onSelectBackgroundTasks: () => undefined,
      onSelectReview: () => undefined,
      workspacePath: "/tmp/workspace",
      onSelectFiles: () => undefined,
      onSelectFileViewer: () => undefined,
      onSelectBrowser: () => undefined,
      onOpenHomeTool: () => undefined,
      onNavigateNewTab: async () => undefined,
      onSelectNewTab: () => undefined,
      onNewBrowserTab: () => undefined,
      onSelectReviewPath: () => undefined,
      onOpenTerminalTask: () => undefined,
      onStopTerminalTask: () => undefined,
    }),
  );

  expect(html).toContain("subagent-task-panel-tab-meta");
  expect(html).toContain("正在读取 src/config.ts");
});

test("ProjectionSubagentDetailFeed groups detail tools across empty terminal thinking rows", () => {
  const subagent = agent({
    agentId: "agent_coder_1",
    status: "active",
    delegationPrompt: "整理文件操作",
    timeline: [
      item({
        id: "read-done",
        sequence: 1,
        eventType: "tool.completed",
        scope: "agent",
        role: "coder",
        agentId: "agent_coder_1",
        text: "Tool: Read · src/input.ts",
        metadata: {
          tool: {
            name: "Read",
            detail: "src/input.ts",
            toolUseId: "toolu_read",
            status: "completed",
          },
        },
      }),
      item({
        id: "empty-thinking-after-read",
        sequence: 2,
        eventType: "thinking.final",
        scope: "agent",
        role: "coder",
        agentId: "agent_coder_1",
        text: "",
        metadata: { itemType: "reasoning" },
      }),
      item({
        id: "write-done",
        sequence: 3,
        eventType: "tool.completed",
        scope: "agent",
        role: "coder",
        agentId: "agent_coder_1",
        text: "Tool: Write · src/output.ts",
        metadata: {
          tool: {
            name: "Write",
            detail: "src/output.ts",
            toolUseId: "toolu_write",
            status: "completed",
          },
        },
      }),
      item({
        id: "empty-thinking-after-write",
        sequence: 4,
        eventType: "thinking.final",
        scope: "agent",
        role: "coder",
        agentId: "agent_coder_1",
        text: "",
        metadata: { itemType: "reasoning" },
      }),
      item({
        id: "edit-done",
        sequence: 5,
        eventType: "tool.completed",
        scope: "agent",
        role: "coder",
        agentId: "agent_coder_1",
        text: "Tool: Edit · src/existing.ts",
        metadata: {
          tool: {
            name: "Edit",
            detail: "src/existing.ts",
            toolUseId: "toolu_edit",
            status: "completed",
          },
        },
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: subagent,
      missionText: "整理文件操作",
      requestSpansById: new Map(),
      threadActive: true,
    }),
  );

  expect(html).toContain("run-log-tool-group-trigger");
  expect(html).toContain("已读取 1 个文件");
  expect(html).toContain("已写入 1 个文件");
  expect(html).toContain("已编辑 1 个文件");
  expect(html.match(/class="run-log-tool-group-trigger/g)?.length ?? 0).toBe(1);
  expect(html.match(/class="run-log-action(?:\s|")/g)?.length ?? 0).toBe(0);
});

test("ProjectionSubagentDetailFeed renders follow-up instructions as prompt bubbles without repeating the mission", () => {
  const mission = "实现后端通知分流";
  const subagent = agent({
    agentId: "agent_coder_1",
    status: "active",
    delegationPrompt: mission,
    timeline: [
      item({
        id: "initial-agent-prompt",
        sequence: 1,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: mission,
        metadata: { liveType: "message.user", itemType: "userMessage" },
      }),
      // Some Codex child histories echo the delegated task as a regular
      // assistant message. It must not duplicate the mission header.
      item({
        id: "initial-agent-echo",
        sequence: 2,
        eventType: "message.final",
        scope: "agent",
        role: "assistant",
        text: mission,
        metadata: { itemType: "agentMessage" },
      }),
      item({
        id: "agent-output",
        sequence: 3,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        text: "初版实现已完成。",
        metadata: { itemType: "agentMessage" },
      }),
      item({
        id: "follow-up-request-started",
        sequence: 4,
        eventType: "request.started",
        scope: "agent",
        role: "coder",
        requestId: "req_follow_up",
        text: "Requesting model…",
      }),
      item({
        id: "follow-up-agent-prompt",
        sequence: 5,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        requestId: "req_follow_up",
        text: '状态确认：请立刻停止当前等待，直接汇报你现在的情况：\n\n1. 已执行过哪些命令？是否已成功拿到广州天气数据？\n2. 如果卡在 require_escalated 审批上，请说明具体命令；不要继续无限等待。\n3. 如果已有真实数据，立刻按原格式返回结果；如果没有，明确说"未获取到"，并附上失败命令与报错原文。',
        // Persisted V2 user messages can retain only itemType. They are still
        // messages sent by the parent agent and must render as outgoing prompts.
        metadata: { itemType: "userMessage" },
      }),
      item({
        id: "follow-up-agent-output",
        sequence: 6,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        requestId: "req_follow_up",
        text: "验签逻辑已修正。",
        metadata: { itemType: "agentMessage" },
      }),
      item({
        id: "same-request-follow-up-agent-prompt",
        sequence: 7,
        eventType: "message.final",
        scope: "agent",
        role: "coder",
        requestId: "req_follow_up",
        text: "继续补充回归测试。",
        metadata: { liveType: "message.user", itemType: "userMessage" },
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: subagent,
      missionText: mission,
      requestSpansById: new Map([
        ["req_follow_up", requestSpan({ requestId: "req_follow_up", status: "streaming" })],
      ]),
      threadActive: true,
    }),
  );

  expect(html.match(/<article class="run-log-user-prompt/g)?.length ?? 0).toBe(3);
  expect(html.match(/subagent-conversation-turn/g)?.length ?? 0).toBe(3);
  expect(html.match(/class="run-log-turn-toggle/g)?.length ?? 0).toBe(3);
  expect(html.match(new RegExp(mission, "g"))?.length ?? 0).toBe(1);
  expect(html).toContain("状态确认：请立刻停止当前等待");
  expect(html).toContain("继续补充回归测试。");
  expect(html).toContain("初版实现已完成。");
  const statusPromptIndex = html.indexOf("状态确认：请立刻停止当前等待");
  expect(statusPromptIndex).toBeGreaterThan(-1);
  expect(statusPromptIndex).toBeLessThan(html.indexOf("正在思考"));
  const sameRequestPromptIndex = html.indexOf("继续补充回归测试。");
  expect(sameRequestPromptIndex).toBeGreaterThan(-1);
  expect(sameRequestPromptIndex).toBeLessThan(html.indexOf("正在思考", sameRequestPromptIndex));
});

test("ProjectionToolGroupEntry keeps file-change details behind a second disclosure level", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "edit-a",
          sequence: 1,
          eventType: "tool.completed",
          text: "Tool: Edit · src/a.ts",
          metadata: {
            tool: {
              name: "Edit",
              detail: "src/a.ts",
              toolUseId: "toolu_edit_a",
              status: "completed",
              fileChange: {
                path: "src/a.ts",
                additions: 1,
                deletions: 1,
                previewLines: [
                  { kind: "remove", text: "const value = 1;" },
                  { kind: "add", text: "const value = 2;" },
                ],
              },
            },
          },
        }),
        item({
          id: "edit-b",
          sequence: 2,
          eventType: "tool.completed",
          text: "Tool: Edit · src/b.ts",
          metadata: {
            tool: {
              name: "Edit",
              detail: "src/b.ts",
              toolUseId: "toolu_edit_b",
              status: "completed",
              fileChange: {
                path: "src/b.ts",
                additions: 1,
                deletions: 0,
                previewLines: [{ kind: "add", text: "export const ready = true;" }],
              },
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("file-change tool group missing");
  }

  const html = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );

  expect(html.match(/class="run-log-action-trigger/g)?.length ?? 0).toBe(2);
  expect(html.match(/aria-expanded="false"/g)?.length ?? 0).toBe(2);
  expect(html).toContain("编辑了 a.ts");
  expect(html).toContain("编辑了 b.ts");
  expect(html).not.toContain("run-log-action-card-detail");
  expect(html).not.toContain("const value = 2;");
  expect(html).not.toContain("export const ready = true;");
});

test("ProjectionSubagentDetailFeed replaces a running tool row with its completed state", () => {
  const subagent = agent({
    agentId: "agent_coder_1",
    status: "active",
    timeline: [
      item({
        id: "bash-started",
        sequence: 1,
        eventType: "tool.started",
        scope: "agent",
        role: "coder",
        text: "Tool: Bash · bun test",
        metadata: {
          tool: {
            name: "Bash",
            detail: "bun test",
            toolUseId: "toolu_bash",
            status: "started",
          },
        },
      }),
      item({
        id: "bash-completed",
        sequence: 2,
        eventType: "tool.completed",
        scope: "agent",
        role: "coder",
        text: "Tool: Bash · bun test",
        metadata: {
          tool: {
            name: "Bash",
            detail: "bun test",
            toolUseId: "toolu_bash",
            status: "completed",
            durationMs: 250,
          },
        },
      }),
    ],
  });

  const html = renderToStaticMarkup(
    createElement(ProjectionSubagentDetailFeed, {
      agent: subagent,
      missionText: "运行测试",
      requestSpansById: new Map(),
      threadActive: true,
    }),
  );

  expect(html).toContain("运行了命令");
  expect(html).not.toContain("正在运行 bun test");
});

test("SubagentTaskDrawer renders grouped subagent tool calls in its standalone panel", () => {
  const subagent = agent({
    agentId: "agent_coder_1",
    status: "active",
    delegationPrompt: "整理文件操作",
    timeline: [
      item({
        id: "read-done",
        sequence: 1,
        eventType: "tool.completed",
        scope: "agent",
        role: "coder",
        agentId: "agent_coder_1",
        text: "Tool: Read · src/input.ts",
        metadata: {
          tool: {
            name: "Read",
            detail: "src/input.ts",
            toolUseId: "toolu_read",
            status: "completed",
          },
        },
      }),
      item({
        id: "edit-done",
        sequence: 2,
        eventType: "tool.completed",
        scope: "agent",
        role: "coder",
        agentId: "agent_coder_1",
        text: "Tool: Edit · src/existing.ts",
        metadata: {
          tool: {
            name: "Edit",
            detail: "src/existing.ts",
            toolUseId: "toolu_edit",
            status: "completed",
          },
        },
      }),
    ],
  });
  const html = renderToStaticMarkup(
    createElement(SubagentTaskDrawer, {
      open: true,
      fullscreen: false,
      cards: [
        {
          key: subagent.agentId,
          agent: subagent,
          timelineIds: subagent.timeline.map((entry) => entry.id),
          running: true,
          missionText: "整理文件操作",
          openable: true,
        },
      ],
      projection: projection({
        status: "running",
        timeline: [],
        agents: [subagent],
      }),
      activeTab: subagent.agentId,
      openTabIds: [subagent.agentId],
      backgroundTasks: [],
      onSelectAgent: () => undefined,
      onSelectPlan: () => undefined,
      onCloseTab: () => undefined,
      onSelectBackgroundTasks: () => undefined,
      onSelectReview: () => undefined,
      workspacePath: "/tmp/workspace",
      onSelectFiles: () => undefined,
      onSelectFileViewer: () => undefined,
      onSelectBrowser: () => undefined,
      onOpenHomeTool: () => undefined,
      onNavigateNewTab: async () => undefined,
      onSelectNewTab: () => undefined,
      onNewBrowserTab: () => undefined,
      onSelectReviewPath: () => undefined,
      onOpenTerminalTask: () => undefined,
      onStopTerminalTask: () => undefined,
    }),
  );

  expect(html).toContain("subagent-task-side-panel");
  expect(html).toContain("run-log-tool-group-trigger");
  expect(html).toContain("已读取 1 个文件和已编辑 1 个文件");
});

test("ActivityLogView summarizes task progress tools without calling them subagents", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "task-create",
            sequence: 1,
            text: "Tool: TaskCreate · implement drawer",
            metadata: {
              tool: {
                name: "TaskCreate",
                detail: "implement drawer",
                toolUseId: "toolu_task_create",
                status: "completed",
              },
            },
          }),
          item({
            id: "task-update",
            sequence: 2,
            text: "Tool: TaskUpdate · implement drawer",
            metadata: {
              tool: {
                name: "TaskUpdate",
                detail: "implement drawer",
                toolUseId: "toolu_task_update",
                status: "completed",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("已创建 1 个任务");
  expect(html).toContain("已更新任务 1 次");
  expect(html).not.toContain("已调用 2 个子代理");
});

test("ActivityLogView does not add a separate status for a stale running action", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        requestSpans: [
          requestSpan({
            requestId: "req_done",
            status: "completed",
            endedAt: "2026-01-01T00:00:03.000Z",
          }),
        ],
        timeline: [
          item({
            id: "write-started",
            requestId: "req_done",
            text: "Tool: Write · src/big-file.ts",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Write",
                detail: "src/big-file.ts",
                toolUseId: "toolu_write_big",
                status: "started",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-tool-group-trigger is-running");
  expect(html).not.toContain("run-log-inline-loading");
  expect(html).not.toContain("run-log-conversation-tail");
});

test("ActivityLogView does not show inline loading for orphan running actions while thread continues", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "running",
        timeline: [
          item({
            id: "bash-started",
            text: "Tool: Bash · sleep 8",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Bash",
                detail: "sleep 8",
                toolUseId: "toolu_sleep",
                status: "started",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-tool-group-trigger is-running");
  expect(html).toContain("正在运行 sleep 8");
  expect(html).toContain("run-log-shimmer-text");
  expect(html).not.toContain("run-log-action-trigger");
  expect(html).not.toContain("run-log-action--bash-card");
  expect(html).not.toContain("run-log-bash-command");
  expect(html).not.toContain("run-log-inline-loading");
  expect(html).not.toContain("run-log-conversation-tail");
});

test("ActivityLogView does not leave inline loading on orphan running actions after the thread ends", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectionActivityLogView, {
      projection: projection({
        status: "completed",
        timeline: [
          item({
            id: "bash-started",
            text: "Tool: Bash · sleep 8",
            metadata: {
              liveType: "tool.started",
              tool: {
                name: "Bash",
                detail: "sleep 8",
                toolUseId: "toolu_sleep",
                status: "started",
              },
            },
          }),
        ],
      }),
    }),
  );

  expect(html).toContain("run-log-tool-group-trigger is-running");
  expect(html).not.toContain("run-log-inline-loading");
  expect(html).not.toContain("run-log-conversation-tail");
});

test("iconForToolName maps eco browser and image generation tools", () => {
  expect(iconForToolName("mcp__eco_agent_browser__agent_browser_click")).toBe("browser");
  expect(iconForToolName("mcp__eco_agent_browser__agent_browser_open")).toBe("browser");
  expect(iconForToolName("mcp__eco_image_generation__create_image")).toBe("image");
  expect(iconForToolName("ViewImage")).toBe("images");
  expect(iconForToolName("mcp__eco_image_view__view_image")).toBe("images");
  expect(iconForToolName("WebSearch")).toBe("network");
  expect(iconForToolName("Read")).toBe("read");
  expect(iconForToolName("TotallyUnknown")).toBe("tool");
});

test("codemode keeps the calls its script made inside the script's card", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "codemode-row",
          eventType: "tool.completed",
          text: "Tool: codemode",
          metadata: {
            tool: {
              name: "codemode",
              toolUseId: "code_1",
              status: "completed",
              durationMs: 3_400,
              codemode: {
                script: 'const a = await tools.read({ path: "a.ts" });\nreturn a.length;',
                output: "1234",
              },
            },
          },
        }),
        item({
          id: "codemode-nested-1",
          eventType: "tool.completed",
          text: "Tool: read · a.ts",
          metadata: {
            conversationV2ParentToolCallId: "code_1",
            tool: {
              name: "read",
              toolUseId: "code_1/1",
              status: "completed",
              readTarget: { filePath: "a.ts", fileName: "a.ts" },
            },
          },
        }),
        item({
          id: "codemode-nested-2",
          eventType: "tool.completed",
          text: "Tool: read · b.ts",
          metadata: {
            conversationV2ParentToolCallId: "code_1",
            tool: {
              name: "read",
              toolUseId: "code_1/2",
              status: "completed",
              readTarget: { filePath: "b.ts", fileName: "b.ts" },
            },
          },
        }),
        item({
          id: "codemode-sibling",
          eventType: "tool.completed",
          text: "Tool: read · c.ts",
          metadata: {
            tool: {
              name: "read",
              toolUseId: "toolu_sibling",
              status: "completed",
              readTarget: { filePath: "c.ts", fileName: "c.ts" },
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("codemode tool group missing");
  }

  // The header describes what the model asked for: one script and one read, not "已执行 3 个工具".
  const display = resolveToolGroupDisplayState(entry.entries, Date.now());
  expect(display.summary.label).toBe("已读取 1 个文件和已运行 1 个代码脚本");
  // A script alone gets the code icon; next to a file read the group keeps the read icon.
  expect(display.summary.icon).toBe("read");

  // The card starts collapsed like every other tool child: the row carries the call count, and the
  // script's panes only reach the DOM once the user opens it.
  const collapsed = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );
  expect(collapsed).toContain("run-log-codemode");
  expect(collapsed).toContain("运行了代码脚本");
  expect(collapsed).toContain("2 次调用");
  expect(collapsed).toContain('aria-expanded="false"');
  expect(collapsed).not.toContain("run-log-codemode-details");
  expect(collapsed).not.toContain("const a = await tools.read");
  // The model-issued read next to the script keeps its own row; the script's own calls do not —
  // they live inside the card, not beside it.
  expect(collapsed).toContain("读取了 c.ts");
  expect(collapsed).not.toContain("读取了 a.ts");
  expect(collapsed).not.toContain("读取了 b.ts");

  // Opened, the card is the script, what it called and what it returned.
  const codemodeBlock = projectionItemToDetailBlock(entry.entries[0]?.item ?? ({} as never));
  if (codemodeBlock?.kind !== "action") {
    throw new Error("codemode action block missing");
  }
  const html = renderToStaticMarkup(
    createElement(ProjectionCodemodeDetails, {
      block: codemodeBlock,
      nestedChildren: entry.entries.slice(1, 3),
      requestSpansById: new Map(),
    }),
  );
  expect(html).toContain("run-log-codemode-details");
  expect(html).toContain("const a = await tools.read");
  expect(html).toContain("1234");
  expect(html).toContain("脚本里的调用");
  expect(html).toContain("run-log-codemode-calls-list");
  // The script's own calls appear once, nested — not again as siblings of the script.
  expect(html.match(/读取了 a\.ts/g)?.length).toBe(1);
  expect(html.match(/读取了 b\.ts/g)?.length).toBe(1);
  expect(html).not.toContain("读取了 c.ts");
});

test("codemode keeps a lone script behind its row too", () => {
  // No nested calls, same disclosure: the row is one line either way and the script stays a click away.
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "lone-codemode",
          eventType: "tool.completed",
          text: "Tool: codemode",
          metadata: {
            tool: {
              name: "codemode",
              toolUseId: "code_7",
              status: "completed",
              codemode: { script: "return 1 + 1;", output: "2" },
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("codemode tool group missing");
  }
  const html = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );
  expect(html).toContain("run-log-codemode");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("run-log-codemode-details");
  expect(html).not.toContain("return 1 + 1;");
});

test("codemode nests its calls when the legacy row carries the link on the tool metadata", () => {
  // A legacy thread-run row has no column for the nesting link, so it rides inside `metadata.tool`.
  // Reading only the conversationV2 key would leave the script's calls as siblings of the script.
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "legacy-codemode-row",
          eventType: "tool.completed",
          text: "Tool: codemode",
          metadata: {
            tool: {
              name: "codemode",
              toolUseId: "code_9",
              status: "completed",
              codemode: { script: 'tools.bash({ command: "echo one" });', output: "one" },
            },
          },
        }),
        item({
          id: "legacy-codemode-nested",
          eventType: "tool.completed",
          text: "Tool: Bash · echo one",
          metadata: {
            tool: {
              name: "Bash",
              toolUseId: "code_9/1",
              status: "completed",
              parentToolCallId: "code_9",
              detail: "echo one",
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("codemode tool group missing");
  }
  // Nesting worked: the header describes the script alone, not the command it ran.
  expect(resolveToolGroupDisplayState(entry.entries, Date.now()).summary.label).toBe("运行了代码脚本");
});

test("codemode card caps the height of its script, call list and output panes", () => {
  // One knob for all three panes: a 300-line script or 60 nested calls must not stretch the Feed.
  expect(styles).toMatch(/\.run-log-codemode-details\s*\{[^}]*--codemode-pane-max-height:\s*240px;/s);
  expect(styles).toMatch(
    /\.run-log-codemode-script \.run-log-bash-command-text\s*\{[^}]*max-height:\s*var\(--codemode-pane-max-height/s,
  );
  expect(styles).toMatch(
    /\.run-log-codemode-calls-list\s*\{[^}]*max-height:\s*var\(--codemode-pane-max-height[^}]*overflow-y:\s*auto;/s,
  );
  // RunLogBashOutput renders the scroll wrap without the .run-log-bash-terminal shell, so a cap on
  // the shell silently never matches — the cap belongs on the wrap.
  expect(styles).toMatch(
    /\.run-log-codemode-output \.run-log-bash-output-wrap\s*\{[^}]*max-height:\s*var\(--codemode-pane-max-height[^}]*overflow-y:\s*auto;/s,
  );
  expect(styles).not.toMatch(/\.run-log-codemode-output \.run-log-bash-terminal/);
});

test("codemode lists each call once when PI's details duplicate its own tool rows", () => {
  const view = buildThreadRunProjectionViewModel(
    projection({
      status: "completed",
      timeline: [
        item({
          id: "codemode-row",
          eventType: "tool.completed",
          text: "Tool: codemode",
          metadata: {
            tool: {
              name: "codemode",
              toolUseId: "code_9",
              status: "completed",
              codemode: {
                script: 'await tools.read({ path: "a.ts" });',
                output: "done",
                calls: [
                  // Same id as the tool event PI ran: it already has its own row.
                  { id: "code_9/1", name: "read", args: '{"path":"a.ts"}', status: "ok", durationMs: 90 },
                  // Cancelled at script end: no tool event, so only PI's record shows it.
                  { id: "code_9/?", name: "bash", args: '{"command":"ls"}', status: "cancelled" },
                ],
              },
            },
          },
        }),
        item({
          id: "codemode-nested",
          eventType: "tool.completed",
          text: "Tool: read · a.ts",
          metadata: {
            conversationV2ParentToolCallId: "code_9",
            tool: {
              name: "read",
              toolUseId: "code_9/1",
              status: "completed",
              readTarget: { filePath: "a.ts", fileName: "a.ts" },
            },
          },
        }),
      ],
    }),
  );
  const entry = view.mainFeedEntries[0];
  if (entry?.kind !== "tool-group") {
    throw new Error("codemode tool group missing");
  }
  const codemodeBlock = projectionItemToDetailBlock(entry.entries[0]?.item ?? ({} as never));
  if (codemodeBlock?.kind !== "action") {
    throw new Error("codemode action block missing");
  }
  // The collapsed row still counts both calls: the badge is what tells the user to open the card.
  const row = renderToStaticMarkup(
    createElement(ProjectionToolGroupEntry, {
      entry,
      requestSpansById: new Map(),
      defaultExpanded: true,
    }),
  );
  expect(row).toContain("2 次调用");

  const html = renderToStaticMarkup(
    createElement(ProjectionCodemodeDetails, {
      block: codemodeBlock,
      nestedChildren: entry.entries.slice(1),
      requestSpansById: new Map(),
    }),
  );
  // The tool row wins; PI's record of the same call adds nothing.
  expect(html.match(/读取了 a\.ts/g)?.length).toBe(1);
  expect(html).toContain("run-log-codemode-call");
  expect(html).toContain("bash");
  // One row from the tool event plus one record with no row, not 2 + 2.
  expect(html.match(/run-log-codemode-call"/g)?.length).toBe(1);
});
