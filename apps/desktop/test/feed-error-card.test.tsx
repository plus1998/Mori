import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationV2ProjectionActivityLogView as ActivityLogView } from "../src/renderer/ActivityLogView";
import { FeedErrorCard } from "../src/renderer/FeedErrorCard";
import { projectionItemToDetailBlock } from "../src/renderer/conversation-v2-projection-view";
import type {
  ThreadRunProjectionSnapshot,
  ThreadRunProjectionTimelineItem,
  ThreadSummary,
} from "../src/shared/ipc";

function timelineItem(
  id: string,
  sequence: number,
  input: Partial<ThreadRunProjectionTimelineItem>,
): ThreadRunProjectionTimelineItem {
  return {
    id,
    sequence,
    eventType: input.eventType ?? "api.error",
    scope: input.scope ?? "main",
    role: input.role ?? "main",
    text: input.text ?? "Model request failed",
    at: input.at ?? `2026-01-01T00:00:0${sequence}.000Z`,
    ...(input.metadata && { metadata: input.metadata }),
  };
}

function failedProjection(failure: ThreadRunProjectionTimelineItem): ThreadRunProjectionSnapshot {
  const prompt = timelineItem("prompt", 1, {
    eventType: "thread.status",
    role: "user",
    text: "Try the model",
    metadata: { liveType: "thread.user_prompt" },
  });
  return {
    thread: {
      threadId: "thread-error-card",
      status: "failed",
      generatedAt: "2026-01-01T00:00:03.000Z",
    },
    attempts: [],
    agents: [],
    requestSpans: [],
    timeline: [prompt, failure],
    diagnostics: [],
    sourceEventCount: 2,
  };
}

const failedThread: ThreadSummary = {
  id: "thread-error-card",
  title: "Model error",
  prompt: "Try the model",
  workspacePath: "C:/workspace",
  status: "failed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  message: "",
  coreKind: "claude",
};

function renderFailure(
  failure: ThreadRunProjectionTimelineItem,
  options: {
    coreKind?: ThreadSummary["coreKind"];
    progress?: ThreadRunProjectionTimelineItem;
    onOpenChatGptSubscriptionAccounts?: (accountId?: string) => void;
  } = {},
): string {
  const projection = failedProjection(failure);
  if (options.progress) projection.timeline.splice(1, 0, options.progress);
  return renderToStaticMarkup(
    createElement(ActivityLogView, {
      projection,
      thread: { ...failedThread, coreKind: options.coreKind ?? failedThread.coreKind },
      onSwitchCodexAccount: () => undefined,
      ...(options.onOpenChatGptSubscriptionAccounts && {
        onOpenChatGptSubscriptionAccounts: options.onOpenChatGptSubscriptionAccounts,
      }),
      onRetryFailedRequest: () => undefined,
    }),
  );
}

test("feed error card renders a model error and text retry action", () => {
  const markup = renderToStaticMarkup(
    createElement(FeedErrorCard, {
      message: "Selected model is at capacity. Please try a different model.",
      actionLabel: "重试",
      onAction: () => undefined,
      title: "Model request failed",
    }),
  );

  expect(markup).toContain('class="feed-error-card"');
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Selected model is at capacity");
  expect(markup).toContain('class="feed-error-card-retry"');
  expect(markup).toContain(">重试</button>");
  expect(markup).not.toContain("refresh-cw");
});

test("feed error card keeps optional request context and expandable detail", () => {
  const markup = renderToStaticMarkup(
    createElement(FeedErrorCard, {
      context: "Coder · model-x",
      message: "Connection failed",
      detail: "ECONNRESET",
    }),
  );

  expect(markup).toContain("Coder · model-x");
  expect(markup).toContain("<details");
  expect(markup).toContain("ECONNRESET");
  expect(markup).toContain("feed-error-card-disclosure");
  expect(markup).not.toContain("feed-error-card-retry");
});

test("ActivityLogView shows the upstream 400 reason instead of a bare status code", () => {
  const reason =
    "Upstream provider sk-deepseek-t156tt · model=deepseek-flash · url=https://slb-v1.api.fan/v1/responses · status=400 · Context window exhausted: window=262144, input=299189, reserve=1. Compact the input before retrying.";
  const markup = renderFailure(
    timelineItem("context-window-400", 2, {
      eventType: "api.error",
      text: `【连接失败】HTTP 400：${reason}`,
      metadata: {
        liveType: "thread.api_error",
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 400, message: reason },
      },
    }),
  );

  expect(markup).toContain('class="feed-error-card"');
  expect(markup).toContain("连接失败 · HTTP 400");
  expect(markup).toContain("Context window exhausted: window=262144, input=299189, reserve=1.");
  expect(markup).toContain("feed-error-card-disclosure");
});

test("ActivityLogView routes model API errors through the shared error card", () => {
  const markup = renderFailure(
    timelineItem("api-failure", 2, {
      eventType: "api.error",
      text: "Selected model is at capacity. Please try a different model.",
      metadata: {
        liveType: "thread.api_error",
        apiError: { message: "Selected model is at capacity. Please try a different model." },
      },
    }),
  );

  expect(markup).toContain('class="feed-error-card"');
  expect(markup).toContain("Selected model is at capacity");
  expect(markup).toContain('class="feed-error-card-retry"');
});

test("ActivityLogView routes upstream final errors through the shared error card", () => {
  const markup = renderFailure(
    timelineItem("upstream-failure", 2, {
      eventType: "message.final",
      text: "API Error: 503 Loading model.",
      metadata: { activityOrigin: "sdk.upstream_error" },
    }),
  );

  expect(markup).toContain('class="feed-error-card"');
  expect(markup).toContain("API Error: 503 Loading model.");
  expect(markup).toContain('class="feed-error-card-retry"');
});

test("ActivityLogView routes terminal thread and reconnect failures through the shared error card", () => {
  const threadFailure = renderFailure(
    timelineItem("thread-failure", 2, {
      eventType: "thread.status",
      text: "The model request was blocked",
      metadata: { activityOrigin: "eco.thread_blocked", liveType: "thread.blocked" },
    }),
  );
  const reconnectFailure = renderFailure(
    timelineItem("reconnect-failure", 2, {
      eventType: "api.error",
      text: "Connection failed: upstream unavailable",
      metadata: {
        activityOrigin: "proxy.connection_error",
        apiError: { statusCode: 503, message: "upstream unavailable" },
      },
    }),
  );

  expect(threadFailure).toContain('class="feed-error-card"');
  expect(threadFailure).toContain("The model request was blocked");
  expect(reconnectFailure).toContain('class="feed-error-card"');
  expect(reconnectFailure).toContain('class="feed-error-card-retry"');
});

test("ActivityLogView does not treat tool failures as model request errors", () => {
  const markup = renderFailure(
    timelineItem("tool-failure", 2, {
      eventType: "tool.failed",
      role: "tool",
      text: "Tool failed: Bash: command exited with 1",
      metadata: {
        tool: { name: "Bash", detail: "exit 1", status: "failed", exitCode: 1 },
      },
    }),
  );

  expect(markup).not.toContain("feed-error-card");
  expect(markup).toContain("run-log-tool-group");
});

const codexUsageLimitMessage =
  "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 24th, 2026 9:36 AM.";

test.each([
  codexUsageLimitMessage,
  codexUsageLimitMessage.replace("You’ve", "You've"),
])("Codex usage exhaustion offers switch account instead of retry: %s", (message) => {
  const markup = renderFailure(
    timelineItem("codex-usage-limit", 3, {
      eventType: "api.error",
      text: message,
      metadata: { liveType: "thread.api_error", apiError: { message } },
    }),
    { coreKind: "codex" },
  );

  expect(markup).toContain('class="feed-error-card"');
  expect(markup).toContain(">切换账号</button>");
  expect(markup).toContain("Oct 24th, 2026 9:36 AM.");
  expect(markup).not.toContain(">重试</button>");
});

test("Codex usage exhaustion can switch accounts after the turn has produced output", () => {
  const markup = renderFailure(
    timelineItem("codex-usage-limit", 3, {
      text: codexUsageLimitMessage,
      metadata: { apiError: { message: codexUsageLimitMessage } },
    }),
    {
      coreKind: "codex",
      progress: timelineItem("assistant-output", 2, { eventType: "message.final", text: "Work so far" }),
    },
  );

  expect(markup).toContain("Work so far");
  expect(markup).toContain(">切换账号</button>");
});

test("Codex usage exhaustion recognizes the structured error code", () => {
  const markup = renderFailure(
    timelineItem("codex-usage-limit", 2, {
      text: "Account quota exhausted",
      metadata: { apiError: { message: "Account quota exhausted", code: "usage_limit_reached" } },
    }),
    { coreKind: "codex" },
  );

  expect(markup).toContain(">切换账号</button>");
});

test("subscription quota failures show the account-specific usage recovery card", () => {
  const item = timelineItem("subscription-quota-limit", 2, {
    text: "该账号的 ChatGPT 订阅用量受限，本轮已停止。",
    metadata: {
      apiError: {
        statusCode: 200,
        code: "subscription_sharing_usage_limit_exceeded",
        message: "该账号的 ChatGPT 订阅用量受限，本轮已停止。",
        accountId: "account-quota",
        providerRequestId: "req_quota",
        responseId: "resp_quota",
      },
    },
  });
  const markup = renderFailure(item, {
    coreKind: "codex",
    onOpenChatGptSubscriptionAccounts: () => undefined,
  });

  expect(markup).toContain("该账号的 ChatGPT 订阅用量受限，本轮已停止。");
  expect(markup).toContain('href="https://chatgpt.com/settings/usage"');
  expect(markup).toContain(">查看 Usage</a>");
  expect(markup).toContain(">手动测试账号</button>");
  expect(markup).not.toContain(">切换账号</button>");
  expect(markup).not.toContain(">重试</button>");
  expect(projectionItemToDetailBlock(item)).toMatchObject({
    kind: "api-error",
    code: "subscription_sharing_usage_limit_exceeded",
    accountId: "account-quota",
  });
});

test("ordinary usage and rate-limit codes do not enter subscription quota recovery", () => {
  for (const apiError of [
    {
      statusCode: 200,
      code: "usage_limit_reached",
      message: "该账号的 ChatGPT 订阅用量受限，本轮已停止。",
      accountId: "account-general",
    },
    {
      statusCode: 429,
      code: "rate_limit_exceeded",
      message: "Too many requests, please try again later",
      accountId: "account-general",
    },
  ]) {
    const markup = renderFailure(
      timelineItem(`non-quota-${apiError.code}`, 2, {
        text: apiError.message,
        metadata: { apiError },
      }),
      {
        coreKind: "codex",
        onOpenChatGptSubscriptionAccounts: () => undefined,
      },
    );
    expect(markup).not.toContain(">手动测试账号</button>");
    expect(markup).not.toContain('href="https://chatgpt.com/settings/usage"');
  }
});

test("other cores and ordinary Codex rate limits retain their retry action", () => {
  const otherCore = renderFailure(
    timelineItem("other-core", 2, {
      text: codexUsageLimitMessage,
      metadata: { apiError: { message: codexUsageLimitMessage } },
    }),
  );
  const rateLimit = renderFailure(
    timelineItem("codex-rate-limit", 2, {
      text: "Too many requests, please try again later",
      metadata: { apiError: { statusCode: 429, message: "Too many requests, please try again later" } },
    }),
    { coreKind: "codex" },
  );

  for (const markup of [otherCore, rateLimit]) {
    expect(markup).not.toContain(">切换账号</button>");
    expect(markup).toContain(">重试</button>");
  }
});

test("the error card action invokes account switching without propagating to the feed", () => {
  let switched = false;
  let prevented = false;
  let stopped = false;
  const card = FeedErrorCard({
    message: codexUsageLimitMessage,
    actionLabel: "切换账号",
    onAction: () => {
      switched = true;
    },
  });
  const button = card.props.children[2];
  button.props.onClick({
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });
  expect(switched).toBe(true);
  expect(prevented).toBe(true);
  expect(stopped).toBe(true);
});
