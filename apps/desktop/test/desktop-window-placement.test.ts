import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { centerBoundsInWorkArea, fitWindowToWorkArea } from "../src/main/desktop-window-bounds";

const indexSource = readFileSync(fileURLToPath(new URL("../src/main/index.ts", import.meta.url)), "utf8");

describe("centerBoundsInWorkArea", () => {
  test("centers on a primary display work area", () => {
    expect(centerBoundsInWorkArea({ x: 0, y: 0, width: 1920, height: 1080 }, 1320, 860)).toEqual({
      x: 300,
      y: 110,
      width: 1320,
      height: 860,
    });
  });

  test("centers on a left secondary display with negative coordinates", () => {
    expect(centerBoundsInWorkArea({ x: -1920, y: 0, width: 1920, height: 1080 }, 1320, 860)).toEqual({
      x: -1620,
      y: 110,
      width: 1320,
      height: 860,
    });
  });

  test("clamps window size when larger than the work area", () => {
    expect(centerBoundsInWorkArea({ x: 0, y: 0, width: 800, height: 600 }, 1320, 860)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 600,
    });
  });

  test("centers clamped window within offset work area", () => {
    expect(centerBoundsInWorkArea({ x: 100, y: 50, width: 800, height: 600 }, 1320, 860)).toEqual({
      x: 100,
      y: 50,
      width: 800,
      height: 600,
    });
  });

  test("keeps the minimum size inside the work area", () => {
    // A MacBook scaled to 1408x881 leaves a 774pt work area: an 860pt window with
    // a 600pt minimum still fits, so only the requested height is reduced.
    expect(fitWindowToWorkArea({ x: 0, y: 30, width: 1408, height: 774 }, 1320, 860, 480, 600)).toEqual({
      bounds: { x: 44, y: 30, width: 1320, height: 774 },
      minWidth: 480,
      minHeight: 600,
    });
    // Electron will not shrink a window below its minimum, so a work area shorter
    // than the minimum has to lower the minimum too.
    expect(fitWindowToWorkArea({ x: 0, y: 30, width: 800, height: 560 }, 1320, 860, 480, 600)).toEqual({
      bounds: { x: 0, y: 30, width: 800, height: 560 },
      minWidth: 480,
      minHeight: 560,
    });
  });
});

describe("createMainWindow startup bounds", () => {
  test("uses the work-area-fitted size instead of the requested size", () => {
    expect(indexSource).toContain("resolveStartupWindowSizing(");
    expect(indexSource).toContain("...initialSizing.bounds,");
    expect(indexSource).toContain("minWidth: initialSizing.minWidth,");
    expect(indexSource).toContain("minHeight: initialSizing.minHeight,");
    expect(indexSource).not.toContain("resolveInitialWindowBounds(width, height)");
  });

  test("restores the saved frame and writes it back from the real window", () => {
    // Read before the boot window exists, so it opens where the last one closed.
    expect(indexSource).toContain("windowStateStore.load();");
    expect(indexSource).toContain("windowStateStore?.load(),");
    expect(indexSource).toContain("trackWindowState(window);");
    expect(indexSource).toContain('window.on("resize", scheduleSave);');
    expect(indexSource).toContain('window.on("move", scheduleSave);');
    expect(indexSource).toContain("windowStateStore.saveSync(state);");
    // A maximized window must persist its un-maximized size, not the display-sized frame.
    expect(indexSource).toContain("window.getNormalBounds()");
    expect(indexSource).toContain("isMaximized: window.isMaximized()");
    expect(indexSource).toContain("window.maximize();");
  });
});
