import { expect, test } from "bun:test";
import { createElement } from "react";
import { ComposerContextMenuPanel } from "../src/renderer/ComposerContextMenu";
import { composerClipboardImageFile, readComposerClipboard } from "../src/renderer/composer-clipboard-paste";
import { CONTEXT_MENU_Z_INDEX, contextMenuBoxForPoint } from "../src/renderer/context-menu-layout";
import { renderLocalized } from "./i18n-test";

test("composer context menu lists cut, copy, paste, and select-all", () => {
  const markup = renderLocalized(
    createElement(ComposerContextMenuPanel, {
      hasSelection: true,
      onCut: () => undefined,
      onCopy: () => undefined,
      onPaste: () => undefined,
      onSelectAll: () => undefined,
    }),
    "zh-CN",
  );
  expect(markup).toContain("composer-context-menu-item");
  expect(markup).toContain("剪切");
  expect(markup).toContain("复制");
  expect(markup).toContain("粘贴");
  expect(markup).toContain("全选");
  expect(markup).not.toContain("disabled");
});

test("composer context menu disables cut and copy without a selection but keeps paste", () => {
  const markup = renderLocalized(
    createElement(ComposerContextMenuPanel, {
      hasSelection: false,
      onCut: () => undefined,
      onCopy: () => undefined,
      onPaste: () => undefined,
      onSelectAll: () => undefined,
    }),
    "en-US",
  );
  expect(markup.match(/disabled/g)?.length).toBe(2);
  expect(markup).toContain("Cut");
  expect(markup).toContain("Copy");
  expect(markup).toContain("Paste");
  expect(markup).toContain("Select All");
});

test("composer context menu opens at the pointer and clamps to the viewport", () => {
  const open = contextMenuBoxForPoint({ x: 420, y: 300 }, { height: 132 }, { width: 1280, height: 800 });
  expect(open).toEqual({ position: "fixed", left: 420, top: 300, width: 188, zIndex: CONTEXT_MENU_Z_INDEX });

  const edge = contextMenuBoxForPoint({ x: 1279, y: 799 }, { height: 132 }, { width: 1280, height: 800 });
  expect(edge.left).toBe(1280 - 8 - 188);
  expect(edge.top).toBe(800 - 8 - 132);
});

test("clipboard image bytes become a PNG file the Composer can attach", () => {
  const file = composerClipboardImageFile({ pngBase64: btoa("\x89PNG\r\n"), byteLength: 8 });
  expect(file?.name).toBe("clipboard-paste.png");
  expect(file?.type).toBe("image/png");
  expect(composerClipboardImageFile(null)).toBeNull();
  expect(composerClipboardImageFile({ pngBase64: "", byteLength: 0 })).toBeNull();
  expect(composerClipboardImageFile({ pngBase64: "not base64 $$$", byteLength: 4 })).toBeNull();
});

test("right-click paste prefers the clipboard image, then falls back to text", async () => {
  const png = btoa("\x89PNG\r\n");
  const imageFirst = await readComposerClipboard({
    readClipboardImage: async () => ({ pngBase64: png, byteLength: 8 }),
    readClipboardText: async () => "ignored text",
  });
  expect(imageFirst?.kind).toBe("image");

  const textOnly = await readComposerClipboard({
    readClipboardImage: async () => null,
    readClipboardText: async () => "branch name",
  });
  expect(textOnly).toEqual({ kind: "text", text: "branch name" });

  const empty = await readComposerClipboard({
    readClipboardImage: async () => null,
    readClipboardText: async () => "",
  });
  expect(empty).toBeNull();

  expect(await readComposerClipboard(undefined)).toBeNull();
});

test("right-click paste survives a failing clipboard image read", async () => {
  const content = await readComposerClipboard({
    readClipboardImage: async () => {
      throw new Error("clipboard unavailable");
    },
    readClipboardText: async () => "still readable",
  });
  expect(content).toEqual({ kind: "text", text: "still readable" });
});
