import { expect, test } from "bun:test";
import { createElement } from "react";
import { FeedTextContextMenuPanel } from "../src/renderer/FeedTextContextMenu";
import { renderLocalized } from "./i18n-test";

test("Feed text selection menu offers Copy in both languages", () => {
  const chinese = renderLocalized(
    createElement(FeedTextContextMenuPanel, { onCopy: () => undefined }),
    "zh-CN",
  );
  expect(chinese).toContain("feed-text-context-menu-item");
  expect(chinese).toContain("复制");

  const english = renderLocalized(
    createElement(FeedTextContextMenuPanel, { onCopy: () => undefined }),
    "en-US",
  );
  expect(english).toContain("feed-text-context-menu-item");
  expect(english).toContain("Copy");
});
