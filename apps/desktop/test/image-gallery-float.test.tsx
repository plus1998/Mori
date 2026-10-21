import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "../src/renderer/i18n";
import { ImageGalleryFloat } from "../src/renderer/ImageGalleryFloat";
import {
  type ImageGalleryQueueItem,
  imageGalleryDisplayItem,
  imageGalleryGenerationItem,
} from "../src/renderer/image-gallery-float-state";

const noop = () => {};

function renderFloat(items: ImageGalleryQueueItem[]) {
  return renderToStaticMarkup(
    createElement(ImageGalleryFloat, {
      items,
      onAdvance: noop,
      onCloseAll: noop,
    }),
  );
}

test("renders the right-docked gallery as a vertical queue of three layers at most", () => {
  const items = [
    imageGalleryGenerationItem("art-gen", 0),
    imageGalleryGenerationItem("art-gen", 1),
    imageGalleryGenerationItem("art-gen", 2),
    imageGalleryDisplayItem("art-disp"),
  ];
  const markup = renderFloat(items);
  expect(markup).toContain('class="image-gallery-float"');
  expect(markup).toContain('aria-label="图片画廊"');
  // 只渲染当前张与后两张，其他图片随浏览进入视口。
  const frameCount = (markup.match(/class="image-gallery-card-frame"/g) ?? []).length;
  expect(frameCount).toBe(3);
  // 只有当前张提供关闭操作，加载中不提供无效的预览按钮。
  const closeIcons = (markup.match(/image-gallery-card-overlay--close"/g) ?? []).length;
  const closeAllIcons = (markup.match(/image-gallery-card-overlay--close-all/g) ?? []).length;
  expect(closeIcons).toBe(1);
  expect(closeAllIcons).toBe(1);
  expect(markup).not.toContain("image-gallery-card-overlay--preview");
  expect(markup).toContain('aria-label="第 1 张，共 4 张"');
  expect(markup).toContain('aria-keyshortcuts="ArrowRight"');
});

test("loading cards can be dismissed and peek cards stay out of keyboard focus", () => {
  const markup = renderFloat([imageGalleryDisplayItem("art-1"), imageGalleryDisplayItem("art-2")]);
  expect(markup).toContain("image-gallery-card-media--loading");
  expect(markup).toContain('aria-label="关闭这张"');
  expect(markup).toContain('aria-label="关闭全部图片"');
  expect(markup).toContain('aria-hidden="true" inert=""');
  const closeIcons = (markup.match(/image-gallery-card-overlay--close"/g) ?? []).length;
  expect(closeIcons).toBe(1);
});

test("a single image keeps close-all available without pagination", () => {
  const markup = renderFloat([imageGalleryDisplayItem("art-only")]);
  expect(markup).toContain('aria-label="关闭全部图片"');
  expect(markup).not.toContain("image-gallery-navigation");
});
