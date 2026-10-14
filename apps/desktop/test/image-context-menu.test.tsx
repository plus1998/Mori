import { expect, test } from "bun:test";
import { createElement } from "react";
import { CONTEXT_MENU_Z_INDEX, contextMenuBoxForPoint } from "../src/renderer/context-menu-layout";
import { ImageContextMenuPanel } from "../src/renderer/ImageContextMenu";
import { renderLocalized } from "./i18n-test";

test("image context menu offers a copy-image action in both languages", () => {
  const chinese = renderLocalized(
    createElement(ImageContextMenuPanel, { onCopyImage: () => undefined }),
    "zh-CN",
  );
  expect(chinese).toContain("image-context-menu-item");
  expect(chinese).toContain("复制图像");

  const english = renderLocalized(
    createElement(ImageContextMenuPanel, { onCopyImage: () => undefined }),
    "en-US",
  );
  expect(english).toContain("Copy image");
});

test("image context menu opens at the pointer and clamps to the viewport", () => {
  const open = contextMenuBoxForPoint({ x: 420, y: 300 }, { height: 36 }, { width: 1280, height: 800 });
  expect(open).toEqual({ position: "fixed", left: 420, top: 300, width: 188, zIndex: CONTEXT_MENU_Z_INDEX });

  const edge = contextMenuBoxForPoint({ x: 1279, y: 799 }, { height: 36 }, { width: 1280, height: 800 });
  expect(edge.left).toBe(1280 - 8 - 188);
  expect(edge.top).toBe(800 - 8 - 36);
});
