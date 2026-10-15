import { expect, test } from "bun:test";
import { createElement } from "react";
import { ContextCard } from "../src/renderer/ContextCard";
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
