import { expect, test } from "bun:test";
import { createElement } from "react";
import {
  ActivityHeaderProjectInfo,
  ActivityHeaderProjectInfoPanel,
} from "../src/renderer/ActivityHeaderProjectInfo";
import { activityHeaderProjectInfoPopoverBoxForRect } from "../src/renderer/activity-header-project-info-layout";
import { renderLocalized } from "./i18n-test";

test("project info popover aligns below the folder icon and stays in the viewport", () => {
  const box = activityHeaderProjectInfoPopoverBoxForRect(
    { top: 8, bottom: 34, left: 72, right: 98, width: 26, height: 26 },
    { width: 1280, height: 800 },
  );
  expect(box.top).toBe(40);
  expect(box.left).toBe(72);
  expect(box.width).toBe(300);
});

test("project info popover clamps to the left viewport edge", () => {
  const box = activityHeaderProjectInfoPopoverBoxForRect(
    { top: 8, bottom: 34, left: 2, right: 28, width: 26, height: 26 },
    { width: 400, height: 800 },
  );
  expect(box.left).toBe(8);
  expect(box.width).toBeLessThanOrEqual(384);
});

test("activity header project info trigger uses the closed folder icon", () => {
  const markup = renderLocalized(
    createElement(ActivityHeaderProjectInfo, {
      projectName: "eco-coding",
      projectPath: "/Users/plus/Desktop/workspace/ai/eco-coding",
      threadCount: 3,
      threadId: "thr_1234567890",
      onError: () => undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("lucide-folder-closed");
  expect(markup).toContain("activity-header-project-info-trigger");
});

test("project info panel shows project name, session count, path, and thread id", () => {
  const markup = renderLocalized(
    createElement(ActivityHeaderProjectInfoPanel, {
      projectName: "eco-coding",
      projectPath: "/Users/plus/Desktop/workspace/ai/eco-coding",
      threadCount: 3,
      threadId: "thr_1234567890",
      onOpenProjectFolder: () => undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("eco-coding");
  expect(markup).toContain("3 个对话");
  expect(markup).toContain("项目路径");
  expect(markup).toContain("/Users/plus/Desktop/workspace/ai/eco-coding");
  expect(markup).toContain("对话 ID");
  expect(markup).toContain("thr_1234567890");
  expect(markup).not.toContain("Cursor 会话 ID");
  expect(markup).toContain("在文件管理器中打开");
});

test("english project info panel uses thread terminology", () => {
  const markup = renderLocalized(
    createElement(ActivityHeaderProjectInfoPanel, {
      projectName: "eco-coding",
      projectPath: "/Users/plus/Desktop/workspace/ai/eco-coding",
      threadCount: 3,
      threadId: "thr_1234567890",
      onOpenProjectFolder: () => undefined,
    }),
    "en-US",
  );
  expect(markup).toContain("eco-coding");
  expect(markup).toContain("3 threads");
  expect(markup).toContain("Project path");
  expect(markup).toContain("Thread ID");
  expect(markup).not.toContain("Cursor session ID");
  expect(markup).toContain("Open in file manager");
});

test("project info panel shows Cursor ACP session id next to the eco thread id", () => {
  const markup = renderLocalized(
    createElement(ActivityHeaderProjectInfoPanel, {
      projectName: "eco-coding",
      projectPath: "/Users/plus/Desktop/workspace/ai/eco-coding",
      threadCount: 1,
      threadId: "thr_1234567890",
      acpSessionId: "cursor-acp-session-abc",
      onOpenProjectFolder: () => undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("对话 ID");
  expect(markup).toContain("thr_1234567890");
  expect(markup).toContain("Cursor 会话 ID");
  expect(markup).toContain("cursor-acp-session-abc");
});
