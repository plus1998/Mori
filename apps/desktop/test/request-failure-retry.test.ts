import { expect, test } from "bun:test";
import {
  buildRequestFailureRetryTargets,
  isRetryableRequestFailureItem,
  readUserPromptRetryIdentity,
} from "../src/renderer/request-failure-retry";
import type { ThreadRunProjectionTimelineItem } from "../src/shared/ipc";
import {
  supportsHistoryRewrite,
  supportsOneClickRequestRetry,
  usesRewindOnRequestRetry,
} from "../src/shared/thread-request-retry";

function item(
  input: Partial<ThreadRunProjectionTimelineItem> & { id: string },
): ThreadRunProjectionTimelineItem {
  return {
    id: input.id,
    sequence: input.sequence ?? 1,
    eventType: input.eventType ?? "message.final",
    scope: input.scope ?? "main",
    text: input.text ?? "",
    at: input.at ?? "2026-01-01T00:00:00.000Z",
    ...(input.role && { role: input.role }),
    ...(input.agentId && { agentId: input.agentId }),
    ...(input.runAttemptId && { runAttemptId: input.runAttemptId }),
    ...(input.requestId && { requestId: input.requestId }),
    ...(input.streamKey && { streamKey: input.streamKey }),
    ...(input.metadata && { metadata: input.metadata }),
  };
}

const userPrompt = item({
  id: "user-1",
  sequence: 1,
  eventType: "thread.status",
  role: "user",
  text: "请继续实现登录页",
  streamKey: "user:abc",
  metadata: {
    liveType: "thread.user_prompt",
    rewindTarget: { activityLineId: "user:abc" },
  },
});

test("supportsOneClickRequestRetry covers rewrite cores and ACP, not Pi", () => {
  expect(supportsHistoryRewrite("claude")).toBe(true);
  expect(supportsHistoryRewrite("codex")).toBe(true);
  expect(supportsHistoryRewrite("acp")).toBe(false);
  expect(usesRewindOnRequestRetry("claude")).toBe(true);
  expect(usesRewindOnRequestRetry("codex")).toBe(false);
  expect(usesRewindOnRequestRetry("acp")).toBe(false);
  expect(supportsOneClickRequestRetry("claude")).toBe(true);
  expect(supportsOneClickRequestRetry("codex")).toBe(true);
  expect(supportsOneClickRequestRetry("acp")).toBe(true);
  expect(supportsOneClickRequestRetry("pi")).toBe(false);
});

test("empty user text is usable for continuation but not prompt replay", () => {
  const imageOnly = { ...userPrompt, text: "" };
  expect(readUserPromptRetryIdentity(imageOnly)).toBeUndefined();
  expect(readUserPromptRetryIdentity(imageOnly, { allowEmptyPrompt: true })).toMatchObject({
    activityLineId: "user:abc",
    prompt: "",
  });
});

test("image-only user messages remain retryable after a request failure", () => {
  const imageOnly = {
    ...userPrompt,
    text: "",
    metadata: {
      ...userPrompt.metadata,
      promptImagePreviews: [{ id: "image-only", mediaType: "image/png", data: "YWJj" }],
    },
  };
  const failure = item({ id: "image-failure", sequence: 2, eventType: "api.error", text: "HTTP 502" });
  const targets = buildRequestFailureRetryTargets({
    items: [imageOnly, failure],
    coreKind: "claude",
    threadStatus: "failed",
  });
  expect(targets.get("image-failure")).toEqual({ activityLineId: "user:abc", prompt: "", hasImages: true });
});

test("readUserPromptRetryIdentity prefers rewindTarget then streamKey", () => {
  expect(readUserPromptRetryIdentity(userPrompt)).toEqual({
    activityLineId: "user:abc",
    prompt: "请继续实现登录页",
    hasImages: false,
  });
  expect(
    readUserPromptRetryIdentity(
      item({
        id: "tre:live_1",
        eventType: "thread.status",
        role: "user",
        text: "Cursor 失败后再试",
        streamKey: "user:from-stream",
        metadata: { liveType: "thread.user_prompt" },
      }),
    ),
  ).toEqual({
    activityLineId: "user:from-stream",
    prompt: "Cursor 失败后再试",
    hasImages: false,
  });
});

test("isRetryableRequestFailureItem accepts connection, upstream, and thread failures", () => {
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "runtime-event-failure",
        eventType: "api.error",
        text: "记录 agent.stopped 事件失败",
        metadata: { activityOrigin: "eco.runtime_event_persist_failure" },
      }),
    ),
  ).toBe(false);
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "reconnect",
        eventType: "api.error",
        text: "【连接失败】HTTP 502：upstream unavailable",
        metadata: {
          activityOrigin: "proxy.connection_error",
          apiError: { statusCode: 502, message: "upstream unavailable" },
        },
      }),
    ),
  ).toBe(true);
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "upstream",
        eventType: "message.final",
        text: "API Error: 503 Loading model.",
        metadata: { activityOrigin: "sdk.upstream_error" },
      }),
    ),
  ).toBe(true);
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "retrying",
        eventType: "request.retry_scheduled",
        text: "API retry 2/5…",
        metadata: { activityOrigin: "sdk.api_retry", retry: { attempt: 2, maxRetries: 5 } },
      }),
    ),
  ).toBe(false);
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "agent-error",
        scope: "agent",
        eventType: "api.error",
        text: "subagent boom",
        metadata: { activityOrigin: "proxy.connection_error" },
      }),
    ),
  ).toBe(false);
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "cursor-exhausted",
        eventType: "message.final",
        text: "Error: RetriableError: [resource_exhausted] Error",
        metadata: { activityOrigin: "sdk.upstream_error" },
      }),
    ),
  ).toBe(true);
  // Without emit-time origin, renderer must not guess from message text.
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "cursor-exhausted-raw",
        eventType: "message.final",
        text: "Error: RetriableError: [resource_exhausted] Error",
      }),
    ),
  ).toBe(false);
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "blocked-visible",
        eventType: "thread.status",
        text: "上游模型暂时过载或连接中断，请稍后重试。",
        metadata: { activityOrigin: "eco.thread_blocked", liveType: "thread.blocked" },
      }),
    ),
  ).toBe(true);
  expect(
    isRetryableRequestFailureItem(
      item({
        id: "blocked-wrap",
        eventType: "thread.status",
        text: "Claude Code returned an error result: API Error: 503 Loading model. 可在下方继续对话。",
        metadata: { activityOrigin: "eco.thread_blocked", liveType: "thread.blocked" },
      }),
    ),
  ).toBe(false);
});

test("buildRequestFailureRetryTargets maps Cursor RetriableError finals tagged at emit", () => {
  const targets = buildRequestFailureRetryTargets({
    coreKind: "acp",
    threadStatus: "failed",
    items: [
      userPrompt,
      item({
        id: "fail",
        sequence: 2,
        eventType: "message.final",
        text: "Error: RetriableError: [resource_exhausted] Error",
        metadata: { activityOrigin: "sdk.upstream_error" },
      }),
    ],
  });
  expect(targets.get("fail")).toEqual({
    activityLineId: "user:abc",
    prompt: "请继续实现登录页",
    hasImages: false,
  });
});

test("buildRequestFailureRetryTargets maps the latest failure to the preceding user prompt", () => {
  const targets = buildRequestFailureRetryTargets({
    coreKind: "claude",
    threadStatus: "failed",
    items: [
      userPrompt,
      item({
        id: "fail",
        sequence: 2,
        eventType: "api.error",
        text: "【连接失败】HTTP 502：upstream unavailable",
        metadata: {
          activityOrigin: "proxy.connection_error",
          apiError: { statusCode: 502, message: "upstream unavailable" },
        },
      }),
    ],
  });
  expect(targets.get("fail")).toEqual({
    activityLineId: "user:abc",
    prompt: "请继续实现登录页",
    hasImages: false,
  });
});

test("buildRequestFailureRetryTargets only attaches retry to the latest failure in a turn", () => {
  const earlierFail = item({
    id: "fail-1",
    sequence: 2,
    eventType: "api.error",
    text: "【连接失败】HTTP 502",
    metadata: { activityOrigin: "proxy.connection_error" },
  });
  const laterFail = item({
    id: "fail-2",
    sequence: 3,
    eventType: "message.final",
    text: "API Error: 503 Loading model.",
    metadata: { activityOrigin: "sdk.upstream_error" },
  });
  const targets = buildRequestFailureRetryTargets({
    coreKind: "claude",
    threadStatus: "failed",
    items: [userPrompt, earlierFail, laterFail],
  });
  expect(targets.has("fail-1")).toBe(false);
  expect(targets.get("fail-2")).toMatchObject({ activityLineId: "user:abc" });
});

test("buildRequestFailureRetryTargets hides retry while the thread is running", () => {
  const targets = buildRequestFailureRetryTargets({
    coreKind: "claude",
    threadStatus: "running",
    items: [
      userPrompt,
      item({
        id: "fail",
        sequence: 2,
        eventType: "api.error",
        text: "【连接失败】HTTP 502",
        metadata: { activityOrigin: "proxy.connection_error" },
      }),
    ],
  });
  expect(targets.size).toBe(0);
});

test("ACP started exhaustion retries from the visible blocked banner", () => {
  const targets = buildRequestFailureRetryTargets({
    coreKind: "acp",
    threadStatus: "blocked",
    items: [
      userPrompt,
      item({
        id: "body",
        sequence: 2,
        eventType: "message.final",
        text: "I'll inspect the login page.\n\nError: T: [resource_exhausted] Error",
      }),
      item({
        id: "blocked",
        sequence: 3,
        eventType: "thread.status",
        text: "上游模型暂时过载或连接中断，请稍后重试。",
        metadata: { activityOrigin: "eco.thread_blocked", liveType: "thread.blocked" },
      }),
    ],
  });
  expect(targets.get("blocked")).toEqual({
    activityLineId: "user:abc",
    prompt: "请继续实现登录页",
    hasImages: false,
  });
  expect(targets.has("body")).toBe(false);
});

test("ACP only retries failures after the latest user prompt", () => {
  const olderFail = item({
    id: "old-fail",
    sequence: 2,
    eventType: "api.error",
    text: "【连接失败】HTTP 502",
    metadata: { activityOrigin: "proxy.connection_error" },
  });
  const laterUser = item({
    id: "user-2",
    sequence: 3,
    eventType: "thread.status",
    role: "user",
    text: "换个模型再试",
    metadata: {
      liveType: "thread.user_prompt",
      rewindTarget: { activityLineId: "user:later" },
    },
  });
  const latestFail = item({
    id: "new-fail",
    sequence: 4,
    eventType: "api.error",
    text: "【连接失败】HTTP 503",
    metadata: { activityOrigin: "proxy.connection_error" },
  });
  const targets = buildRequestFailureRetryTargets({
    coreKind: "acp",
    threadStatus: "failed",
    items: [userPrompt, olderFail, laterUser, latestFail],
  });
  expect(targets.has("old-fail")).toBe(false);
  expect(targets.get("new-fail")).toMatchObject({
    activityLineId: "user:later",
    prompt: "换个模型再试",
  });
});

test("Codex retries early connection failures without rewind", () => {
  const targets = buildRequestFailureRetryTargets({
    coreKind: "codex",
    threadStatus: "failed",
    items: [
      userPrompt,
      item({
        id: "fail",
        sequence: 2,
        eventType: "api.error",
        text: "【连接失败】HTTP 502：upstream unavailable",
        metadata: {
          activityOrigin: "proxy.connection_error",
          apiError: { statusCode: 502, message: "upstream unavailable" },
        },
      }),
    ],
  });
  expect(targets.get("fail")).toEqual({
    activityLineId: "user:abc",
    prompt: "请继续实现登录页",
    hasImages: false,
  });
});

test("Codex hides retry after agent message or tool progress", () => {
  const withAssistant = buildRequestFailureRetryTargets({
    coreKind: "codex",
    threadStatus: "failed",
    items: [
      userPrompt,
      item({
        id: "speech",
        sequence: 2,
        eventType: "message.final",
        role: "assistant",
        text: "先看一下登录页结构。",
      }),
      item({
        id: "fail",
        sequence: 3,
        eventType: "api.error",
        text: "【连接失败】HTTP 502",
        metadata: { activityOrigin: "proxy.connection_error" },
      }),
    ],
  });
  expect(withAssistant.size).toBe(0);

  const withTool = buildRequestFailureRetryTargets({
    coreKind: "codex",
    threadStatus: "failed",
    items: [
      userPrompt,
      item({
        id: "tool",
        sequence: 2,
        eventType: "tool.completed",
        text: "Read login.tsx",
        metadata: { toolName: "Read" },
      }),
      item({
        id: "fail",
        sequence: 3,
        eventType: "api.error",
        text: "【连接失败】HTTP 502",
        metadata: { activityOrigin: "proxy.connection_error" },
      }),
    ],
  });
  expect(withTool.size).toBe(0);
});

test("Codex only retries failures after the latest user prompt", () => {
  const laterUser = item({
    id: "user-2",
    sequence: 3,
    eventType: "thread.status",
    role: "user",
    text: "再试一次",
    metadata: {
      liveType: "thread.user_prompt",
      rewindTarget: { activityLineId: "user:later" },
    },
  });
  const targets = buildRequestFailureRetryTargets({
    coreKind: "codex",
    threadStatus: "failed",
    items: [
      userPrompt,
      item({
        id: "old-fail",
        sequence: 2,
        eventType: "api.error",
        text: "【连接失败】HTTP 502",
        metadata: { activityOrigin: "proxy.connection_error" },
      }),
      laterUser,
      item({
        id: "new-fail",
        sequence: 4,
        eventType: "api.error",
        text: "【连接失败】HTTP 503",
        metadata: { activityOrigin: "proxy.connection_error" },
      }),
    ],
  });
  expect(targets.has("old-fail")).toBe(false);
  expect(targets.get("new-fail")).toMatchObject({
    activityLineId: "user:later",
    prompt: "再试一次",
  });
});

test("Pi has no one-click retry target", () => {
  const targets = buildRequestFailureRetryTargets({
    coreKind: "pi",
    threadStatus: "failed",
    items: [
      userPrompt,
      item({
        id: "fail",
        sequence: 2,
        eventType: "api.error",
        text: "【连接失败】HTTP 502",
        metadata: { activityOrigin: "proxy.connection_error" },
      }),
    ],
  });
  expect(targets.size).toBe(0);
});
