import { expect, test } from "bun:test";
import { createElement } from "react";
import { ContextCard } from "../src/renderer/ContextCard";
import { ThreadInfoFloatStack } from "../src/renderer/ThreadInfoPanel";
import type { ThreadContextSnapshot } from "../src/shared/ipc";
import { renderLocalized } from "./i18n-test";

test("renders a structured empty context state", () => {
  const markup = renderLocalized(
    createElement(ContextCard, { placeholder: "用量随每轮模型响应更新" }),
    "zh-CN",
  );

  expect(markup).toContain('class="context-card context-card-empty"');
  expect(markup).toContain('role="status"');
  expect(markup).toContain('class="context-card-empty-header"');
  expect(markup).toContain('class="context-card-empty-icon"');
  expect(markup).toContain('class="context-card-empty-meter"');
  expect(markup).toContain('class="context-card-empty-track"');
  expect(markup).toContain("上下文");
  expect(markup).toContain("用量随每轮模型响应更新");
  expect(markup).toContain("暂无占用数据");
});

test("context errors replace stale occupancy and window values with an alert", () => {
  const context: ThreadContextSnapshot = {
    error: "缺少供应商身份（providerId），无法确定上下文窗口。",
    occupied: 315_741,
    limit: 272_000,
    occupancyPct: 100,
    limitsResolved: true,
    segments: [],
    updatedAt: 0,
  };
  const markup = renderLocalized(createElement(ContextCard, { context, showWhenEmpty: false }), "zh-CN");
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("上下文统计失败");
  expect(markup).toContain("缺少供应商身份（providerId）");
  expect(markup).not.toContain("context-card-hero");
  expect(markup).not.toContain("100%");
  expect(markup).not.toContain("272");
});

test("context controls show an error indicator instead of an occupancy ring", () => {
  for (const variant of ["composer", "panel"] as const) {
    const markup = renderLocalized(
      createElement(ThreadInfoFloatStack, {
        variant,
        showContext: true,
        showBillingSection: false,
        showBilling: false,
        tokenBadge: null,
        plannerLabel: "",
        contextPlaceholder: "",
        context: {
          error: "缺少供应商身份（providerId）",
          occupied: 315_741,
          limit: 272_000,
          occupancyPct: 100,
          limitsResolved: true,
          segments: [],
          updatedAt: 0,
        },
      }),
      "zh-CN",
    );
    expect(markup).toContain('aria-label="上下文统计失败"');
    expect(markup).not.toContain("thread-info-context-ring");
    expect(markup).not.toContain("100%");
  }
});
