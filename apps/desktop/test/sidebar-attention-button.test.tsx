import { expect, test } from "bun:test";
import { createElement } from "react";
import { SidebarAttentionButton } from "../src/renderer/SidebarAttentionButton";
import { renderLocalized } from "./i18n-test";

const item = {
  id: "plan:t-1",
  threadId: "t-1",
  title: "生图与 OAuth API 开放",
  kind: "plan" as const,
  detail: "将 ChatGPT OAuth 和登录生图开放为 API",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("attention panel labels single and bulk ignore and explains retained approval state in both locales", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const markup = renderLocalized(
      createElement(SidebarAttentionButton, {
        items: [item],
        open: true,
        onOpenChange() {},
        onSelectThread() {},
        onDismissItems() {},
      }),
      locale,
    );
    expect(markup).toContain(locale === "zh-CN" ? "全部忽略" : "Ignore all");
    expect(markup).toContain(
      locale === "zh-CN" ? "忽略通知：生图与 OAuth API 开放" : "Ignore notification: 生图与 OAuth API 开放",
    );
    expect(markup).toContain(locale === "zh-CN" ? "等待批准" : "awaiting approval");
    expect(markup).toContain("sidebar-core-attention-dot");
    // The ignore control is a sibling so it cannot trigger the open-conversation action.
    expect(markup).toMatch(/<\/button><button[^>]*class="sidebar-core-attention-dismiss"/);
  }
});

test("an empty attention panel drops the badge and bulk action and shows persistence failures", () => {
  const markup = renderLocalized(
    createElement(SidebarAttentionButton, {
      items: [],
      open: true,
      onOpenChange() {},
      onSelectThread() {},
      onDismissItems() {},
      dismissalError: true,
    }),
    "zh-CN",
  );
  expect(markup).not.toContain("sidebar-core-attention-dot");
  expect(markup).not.toContain("全部忽略");
  expect(markup).toContain("暂无需要关注的通知");
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("无法读取或保存忽略记录");
});
