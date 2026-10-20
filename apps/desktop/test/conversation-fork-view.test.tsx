import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ConversationBootstrap } from "@eco/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityLogView, buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import { installConversationV2Bootstrap } from "../src/renderer/conversation-v2-renderer-state";
import { i18n } from "../src/renderer/i18n";

let previousLanguage: string;
beforeEach(async () => {
  previousLanguage = i18n.language;
  await i18n.changeLanguage("zh-CN");
});
afterEach(async () => {
  await i18n.changeLanguage(previousLanguage);
});

function state(withAssistant = false) {
  const bootstrap: ConversationBootstrap = {
    protocolVersion: 2,
    storeEpoch: "fork-view",
    conversationId: "source",
    snapshotSeq: 2,
    historyRevision: 0,
    messages: [
      {
        messageId: "user-1",
        conversationId: "source",
        turnId: "turn-1",
        createdSeq: 1,
        versionSeq: 1,
        contentVersion: 0,
        role: "user",
        channel: "answer",
        body: "原始消息",
        status: "final",
        isDeleted: false,
        occurredAt: "2026-10-15T00:00:00Z",
        historyTarget: { activityLineId: "local-user", userMessageId: "native-user" },
      },
    ],
    runs: [],
    turns: [],
    tools: [],
    toolSummaryCounts: {},
    agents: [],
    todos: [],
    hasOlder: false,
  };
  if (withAssistant) {
    bootstrap.messages.push({
      messageId: "assistant-1",
      conversationId: "source",
      turnId: "turn-1",
      runId: "run-1",
      createdSeq: 2,
      versionSeq: 2,
      contentVersion: 0,
      role: "assistant",
      channel: "answer",
      body: "Agent answer",
      status: "final",
      isDeleted: false,
    });
    bootstrap.runs.push({
      runId: "run-1",
      conversationId: "source",
      turnId: "turn-1",
      status: "completed",
      versionSeq: 3,
      startedAt: "2026-10-15T00:00:00Z",
      endedAt: "2026-10-15T00:00:01Z",
      timingQuality: "recorded",
      toolCount: 0,
    });
    bootstrap.snapshotSeq = 3;
  }
  return installConversationV2Bootstrap(bootstrap);
}

test("V2 projection preserves the durable native node identity for fork actions", () => {
  const projection = buildConversationV2OnlyProjection(state());
  expect(projection.timeline[0]?.metadata?.rewindTarget).toEqual({
    activityLineId: "local-user",
    userMessageId: "native-user",
  });
});

for (const coreKind of ["claude", "codex", "pi"] as const)
  test(`${coreKind} user row exposes a fork action independently from history editing`, () => {
    const html = renderToStaticMarkup(
      createElement(ActivityLogView, {
        conversationV2: state(),
        thread: {
          id: "source",
          title: "Source",
          prompt: "原始消息",
          workspacePath: "/tmp",
          coreKind,
          status: "completed",
          message: "",
          createdAt: "2026-10-15T00:00:00Z",
          updatedAt: "2026-10-15T00:00:00Z",
        },
        onForkMessage: async () => {},
      }),
    );
    expect(html).toContain('aria-label="从此处分叉"');
    expect(html).toContain("原始消息");
    expect(html).toContain("run-log-message-meta--sticky");
    expect(html).toContain("run-log-fork-button");
    const forkButton = html.match(/<button[^>]*run-log-fork-button[^>]*>([\s\S]*?)<\/button>/)?.[1];
    expect(forkButton).toContain("<svg");
    expect(forkButton).not.toContain("<span");
    expect(html).toMatch(/aria-label="复制消息"[^>]*>[\s\S]*?<\/button><button[^>]*run-log-fork-button/);
  });

test("first-node fork renders an idle empty history without an endless loading indicator", () => {
  const empty = { ...state(), messages: new Map(), appliedSeq: 1 };
  const html = renderToStaticMarkup(
    createElement(ActivityLogView, {
      conversationV2: empty,
      thread: {
        id: "source",
        title: "Empty fork",
        prompt: "",
        workspacePath: "/tmp",
        coreKind: "claude",
        status: "idle",
        message: "",
        createdAt: "2026-10-15T00:00:00Z",
        updatedAt: "2026-10-15T00:00:00Z",
      },
    }),
  );
  expect(html).not.toContain("run-log-projection-loading");
  expect(html).not.toContain('role="status"');
});

for (const coreKind of ["claude", "codex", "pi"] as const) {
  for (const status of ["running", "queued"] as const) {
    test(`${coreKind} ${status} hides message edit and fork actions`, () => {
      const html = renderToStaticMarkup(
        createElement(ActivityLogView, {
          conversationV2: state(),
          thread: {
            id: "source",
            title: "Source",
            prompt: "原始消息",
            workspacePath: "/tmp",
            coreKind,
            status,
            message: "",
            createdAt: "2026-10-15T00:00:00Z",
            updatedAt: "2026-10-15T00:00:00Z",
          },
          onRestorePrompt: () => {},
          onLoadUserMessageEdit: async () => {
            throw new Error("must not run");
          },
          onRewriteUserMessage: async () => {
            throw new Error("must not run");
          },
          onForkMessage: async () => {
            throw new Error("must not run");
          },
        }),
      );
      expect(html).not.toContain('aria-label="从此处分叉"');
      expect(html).not.toContain("run-log-fork-button");
      expect(html).not.toContain('aria-label="编辑消息"');
    });
  }
}

test("English fork affordance is accessible without a visible text label", async () => {
  await i18n.changeLanguage("en-US");
  const html = renderToStaticMarkup(
    createElement(ActivityLogView, { conversationV2: state(), onForkMessage: async () => {} }),
  );
  expect(html).toContain('aria-label="Fork from here"');
  expect(html).not.toContain(">Fork</span>");
  expect(html).toContain("run-log-message-meta--sticky");
});

for (const coreKind of ["claude", "codex", "pi"] as const)
  test(`${coreKind} completed agent answer has an icon-only fork immediately after copy`, () => {
    const html = renderToStaticMarkup(
      createElement(ActivityLogView, {
        conversationV2: state(true),
        thread: {
          id: "source",
          title: "Source",
          prompt: "原始消息",
          workspacePath: "/tmp",
          coreKind,
          status: "completed",
          message: "",
          createdAt: "2026-10-15T00:00:00Z",
          updatedAt: "2026-10-15T00:00:01Z",
        },
        onForkMessage: async () => {},
      }),
    );
    expect(html.match(/run-log-fork-button/g)).toHaveLength(2);
    const agent = html.slice(html.indexOf("Agent answer"));
    expect(agent).toMatch(/aria-label="复制消息"[^>]*>[\s\S]*?<\/button><button[^>]*run-log-fork-button/);
    expect(agent).not.toContain(">分叉</span>");
  });
