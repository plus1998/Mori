import { expect, test } from "bun:test";
import { createElement } from "react";
import { ThreadNotificationPanel } from "../src/renderer/ThreadNotificationPanel";
import { renderLocalized } from "./i18n-test";

test("通知面板提供微信通知和朗读；微信开关保留当前对话状态", () => {
  for (const enabled of [false, true]) {
    const markup = renderLocalized(
      createElement(ThreadNotificationPanel, {
        wechatFollowEnabled: enabled,
        onWechatFollowChange: async () => {},
        readAloudContent: "原有朗读设置",
        readAloudHasError: false,
        onClose() {},
      }),
      "zh-CN",
    );
    expect(markup).toContain("通知");
    expect(markup).toContain("微信通知");
    expect(markup).toContain("朗读");
    expect(markup).toContain('aria-label="完工通知"');
    expect(markup.includes('checked=""')).toBe(enabled);
    expect(markup).toContain("仅对当前对话生效");
    expect(markup).toContain("原有朗读设置");
  }
});

test("朗读失败时通知面板直接显示朗读页，保留微信开关", () => {
  const markup = renderLocalized(
    createElement(ThreadNotificationPanel, {
      wechatFollowEnabled: false,
      onWechatFollowChange: async () => {},
      readAloudContent: "朗读错误",
      readAloudHasError: true,
      onClose() {},
    }),
    "zh-CN",
  );
  expect(markup).toMatch(/role="tab"[^>]*id="[^"]*-read-tab"[^>]*aria-selected="true"/);
  expect(markup).toContain("朗读错误");
  expect(markup).toContain('aria-label="完工通知"');
});
