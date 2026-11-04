import { expect, test } from "bun:test";
import {
  clampComposerFloatingLeft,
  composerFloatingAvailableWidth,
  composerFloatingStyleForAnchor,
  composerFloatingViewport,
} from "../src/renderer/composer-floating";
import { withGlobalWindow } from "./support/global-document";

const viewportWindow = { innerWidth: 1200, innerHeight: 800 };

test("composerFloatingViewport uses the window edges", () => {
  withGlobalWindow(viewportWindow, () => {
    const viewport = composerFloatingViewport();
    expect(viewport.left).toBe(8);
    expect(viewport.right).toBe(1192);
    expect(viewport.width).toBe(1184);
  });
});

test("clampComposerFloatingLeft clamps to the window viewport", () => {
  withGlobalWindow(viewportWindow, () => {
    expect(clampComposerFloatingLeft(1100, 220)).toBe(972);
    expect(clampComposerFloatingLeft(0, 220)).toBe(8);
  });
});

test("composerFloatingAvailableWidth never exceeds window minus margins", () => {
  withGlobalWindow(viewportWindow, () => {
    const width = composerFloatingAvailableWidth();
    // The task panel margins are the only space the composer gives up.
    expect(width).toBeLessThanOrEqual(viewportWindow.innerWidth - 16);
  });
});

test("composerFloatingStyleForAnchor aligns popovers to the anchor trailing edge", () => {
  withGlobalWindow(viewportWindow, () => {
    const anchor = {
      getBoundingClientRect: () =>
        ({
          left: 980,
          right: 1040,
          top: 640,
          bottom: 668,
          width: 60,
          height: 28,
        }) as DOMRect,
    } as HTMLElement;

    const style = composerFloatingStyleForAnchor(anchor, {
      width: 320,
      align: "end",
      prefer: "above",
    });

    expect(style.left).toBe(720);
    expect(style.width).toBe(320);
  });
});

test("below preference uses space below the anchor before moving above", () => {
  withGlobalWindow(viewportWindow, () => {
    const anchor = {
      getBoundingClientRect: () => ({ left: 900, right: 924, top: 150, bottom: 174 }) as DOMRect,
    } as HTMLElement;
    const style = composerFloatingStyleForAnchor(anchor, { prefer: "below", minHeight: 120 });
    expect(style.top).toBe(182);
    expect(style.bottom).toBeUndefined();
    expect(style.maxHeight).toBe(610);
  });
});

test("below preference moves above only when the remaining lower space is too short", () => {
  withGlobalWindow(viewportWindow, () => {
    const anchor = {
      getBoundingClientRect: () => ({ left: 900, right: 924, top: 700, bottom: 724 }) as DOMRect,
    } as HTMLElement;
    const style = composerFloatingStyleForAnchor(anchor, { prefer: "below", minHeight: 120 });
    expect(style.top).toBeUndefined();
    expect(style.bottom).toBe(108);
    expect(style.maxHeight).toBe(684);
  });
});
