import { expect, test } from "bun:test";
import {
  clampLightboxZoom,
  computeContainSize,
  createLightboxZoomTransform,
  formatLightboxZoomPercent,
  fitImgIntoStage,
  lightboxZoomCssTransform,
  LIGHTBOX_ZOOM_MAX,
  LIGHTBOX_ZOOM_MIN,
  panLightboxZoom,
  resetLightboxZoom,
  stepLightboxZoom,
  zoomLightboxAtPoint,
} from "../src/renderer/lightbox-zoom";

test("clampLightboxZoom respects min/max", () => {
  expect(clampLightboxZoom(0)).toBe(LIGHTBOX_ZOOM_MIN);
  expect(clampLightboxZoom(100)).toBe(LIGHTBOX_ZOOM_MAX);
  expect(clampLightboxZoom(Number.NaN)).toBe(1);
});

test("zoomLightboxAtPoint keeps focal point stable", () => {
  const current = createLightboxZoomTransform(1, 0, 0);
  const point = { x: 100, y: 50 };
  const next = zoomLightboxAtPoint(current, 2, point);
  expect(next.scale).toBe(2);
  const localX = (point.x - current.x) / current.scale;
  const localY = (point.y - current.y) / current.scale;
  expect(next.x + localX * next.scale).toBeCloseTo(point.x);
  expect(next.y + localY * next.scale).toBeCloseTo(point.y);
});

test("stepLightboxZoom in and out", () => {
  const start = createLightboxZoomTransform();
  const zoomed = stepLightboxZoom(start, 1, { x: 40, y: 40 });
  expect(zoomed.scale).toBeGreaterThan(1);
  const back = stepLightboxZoom(zoomed, -1, { x: 40, y: 40 });
  expect(back.scale).toBeCloseTo(1);
  expect(back.x).toBe(0);
  expect(back.y).toBe(0);
});

test("panLightboxZoom only when zoomed", () => {
  expect(panLightboxZoom(createLightboxZoomTransform(), { x: 10, y: 5 })).toEqual(
    createLightboxZoomTransform(),
  );
  expect(panLightboxZoom(createLightboxZoomTransform(2, 1, 2), { x: 10, y: 5 })).toEqual({
    scale: 2,
    x: 11,
    y: 7,
  });
});

test("reset and format helpers", () => {
  expect(resetLightboxZoom()).toEqual({ scale: 1, x: 0, y: 0 });
  expect(formatLightboxZoomPercent(1.2)).toBe("120%");
  expect(lightboxZoomCssTransform({ scale: 1.5, x: 8, y: -3 })).toBe(
    "translate(8px, -3px) scale(1.5)",
  );
});

test("computeContainSize upscales svg-like content to fill stage", () => {
  expect(computeContainSize({ width: 400, height: 200 }, { width: 1000, height: 800 })).toEqual({
    width: 1000,
    height: 500,
  });
});

test("computeContainSize can refuse image upscaling past native", () => {
  expect(
    computeContainSize({ width: 200, height: 100 }, { width: 1000, height: 800 }, { allowUpscale: false }),
  ).toEqual({ width: 200, height: 100 });
});

test("workspace raster fitting fills the canvas while default lightboxes retain native size", () => {
  const img = { naturalWidth: 200, naturalHeight: 100, style: {} } as HTMLImageElement;
  const stage = { clientWidth: 1000, clientHeight: 800 } as HTMLElement;
  fitImgIntoStage(img, stage);
  expect([img.style.width, img.style.height]).toEqual(["200px", "100px"]);
  fitImgIntoStage(img, stage, true);
  expect([img.style.width, img.style.height]).toEqual(["1000px", "500px"]);
});
