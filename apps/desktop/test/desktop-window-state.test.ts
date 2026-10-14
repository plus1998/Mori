import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fitBoundsToWorkArea } from "../src/main/desktop-window-bounds";
import {
  createDesktopWindowStateStore,
  type DisplayGeometry,
  findDisplayForWindowState,
  normalizeWindowState,
  resolveRestoredWindowSizing,
} from "../src/main/desktop-window-state";

const primary: DisplayGeometry = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1050 },
};
const rightOfPrimary: DisplayGeometry = {
  id: 2,
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 30, width: 2560, height: 1410 },
};
const leftOfPrimary: DisplayGeometry = {
  id: 3,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1050 },
};
const displays = [primary, rightOfPrimary, leftOfPrimary];

function resolve(saved: Parameters<typeof resolveRestoredWindowSizing>[0]["saved"]) {
  return resolveRestoredWindowSizing({
    saved,
    displays,
    fallbackDisplay: primary,
    preferredWidth: 1320,
    preferredHeight: 860,
    minWidth: 480,
    minHeight: 600,
  });
}

describe("normalizeWindowState", () => {
  test("accepts the persisted envelope", () => {
    expect(
      normalizeWindowState({
        version: 1,
        bounds: { x: 100, y: 50, width: 1320.4, height: 860.6 },
        displayId: 2,
        isMaximized: true,
      }),
    ).toEqual({ bounds: { x: 100, y: 50, width: 1320, height: 861 }, displayId: 2, isMaximized: true });
  });

  test("rejects frames that cannot be placed", () => {
    expect(normalizeWindowState(undefined)).toBeUndefined();
    expect(normalizeWindowState(null)).toBeUndefined();
    expect(normalizeWindowState("bounds")).toBeUndefined();
    expect(
      normalizeWindowState({ bounds: { x: 0, y: 0, width: 0, height: 800 }, displayId: 1 }),
    ).toBeUndefined();
    expect(
      normalizeWindowState({ bounds: { x: Number.NaN, y: 0, width: 800, height: 600 }, displayId: 1 }),
    ).toBeUndefined();
    // Without a display id the saved screen cannot be resolved, so the frame is dropped.
    expect(normalizeWindowState({ bounds: { x: 0, y: 0, width: 800, height: 600 } })).toBeUndefined();
  });
});

describe("fitBoundsToWorkArea", () => {
  test("keeps a frame dragged past the right edge reachable", () => {
    expect(
      fitBoundsToWorkArea(primary.workArea, { x: 1900, y: 0, width: 1320, height: 860 }, 480, 600),
    ).toEqual({
      bounds: { x: 1800, y: 0, width: 1320, height: 860 },
      minWidth: 480,
      minHeight: 600,
    });
  });

  test("keeps the title bar below the menu bar on an offset work area", () => {
    expect(
      fitBoundsToWorkArea(rightOfPrimary.workArea, { x: 1920, y: -400, width: 1320, height: 860 }, 480, 600),
    ).toEqual({
      bounds: { x: 1920, y: 30, width: 1320, height: 860 },
      minWidth: 480,
      minHeight: 600,
    });
  });

  test("fits a saved frame that is larger than the current work area", () => {
    expect(
      fitBoundsToWorkArea(primary.workArea, { x: 0, y: 0, width: 3000, height: 2000 }, 480, 600),
    ).toEqual({
      bounds: { x: 0, y: 0, width: 1920, height: 1050 },
      minWidth: 480,
      minHeight: 600,
    });
    // A work area shorter than the minimum has to lower the minimum too.
    expect(
      fitBoundsToWorkArea(
        { x: 0, y: 30, width: 800, height: 560 },
        { x: 0, y: 30, width: 1320, height: 860 },
        480,
        600,
      ),
    ).toEqual({
      bounds: { x: 0, y: 30, width: 800, height: 560 },
      minWidth: 480,
      minHeight: 560,
    });
  });

  test("keeps negative coordinates on a display left of the primary one", () => {
    expect(
      fitBoundsToWorkArea(leftOfPrimary.workArea, { x: -1900, y: 100, width: 1320, height: 860 }, 480, 600),
    ).toEqual({ bounds: { x: -1900, y: 100, width: 1320, height: 860 }, minWidth: 480, minHeight: 600 });
  });
});

describe("findDisplayForWindowState", () => {
  test("prefers the saved display id", () => {
    expect(
      findDisplayForWindowState(displays, {
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        displayId: 2,
        isMaximized: false,
      })?.id,
    ).toBe(2);
  });

  test("follows the frame to another display when the id changed", () => {
    expect(
      findDisplayForWindowState(displays, {
        bounds: { x: 2000, y: 100, width: 800, height: 600 },
        displayId: 99,
        isMaximized: false,
      })?.id,
    ).toBe(2);
  });

  test("returns nothing when no display covers the frame", () => {
    expect(
      findDisplayForWindowState(displays, {
        bounds: { x: 5000, y: 0, width: 800, height: 600 },
        displayId: 99,
        isMaximized: false,
      }),
    ).toBeUndefined();
  });
});

describe("resolveRestoredWindowSizing", () => {
  test("centers the preferred size when nothing was saved", () => {
    expect(resolve(undefined)).toEqual({
      bounds: { x: 300, y: 95, width: 1320, height: 860 },
      minWidth: 480,
      minHeight: 600,
      isMaximized: false,
    });
  });

  test("restores size, position and maximized state on the saved display", () => {
    expect(
      resolve({ bounds: { x: 2100, y: 120, width: 1440, height: 900 }, displayId: 2, isMaximized: true }),
    ).toEqual({
      bounds: { x: 2100, y: 120, width: 1440, height: 900 },
      minWidth: 480,
      minHeight: 600,
      isMaximized: true,
    });
  });

  test("pulls a frame back onto a display that moved or shrank", () => {
    expect(
      resolve({ bounds: { x: -3500, y: -200, width: 1320, height: 860 }, displayId: 3, isMaximized: false }),
    ).toEqual({
      bounds: { x: -3120, y: 0, width: 1320, height: 860 },
      minWidth: 480,
      minHeight: 600,
      isMaximized: false,
    });
  });

  test("falls back to the cursor display when the saved screen is gone", () => {
    expect(
      resolve({ bounds: { x: 5000, y: 0, width: 1320, height: 860 }, displayId: 7, isMaximized: true }),
    ).toEqual({
      bounds: { x: 300, y: 95, width: 1320, height: 860 },
      minWidth: 480,
      minHeight: 600,
      isMaximized: false,
    });
  });
});

describe("DesktopWindowStateStore", () => {
  const state = { bounds: { x: 2100, y: 120, width: 1440, height: 900 }, displayId: 2, isMaximized: true };

  function tempFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "eco-window-state-"));
    return path.join(dir, "window-state.json");
  }

  test("round-trips through a synchronous read on the next launch", () => {
    const filePath = tempFile();
    try {
      createDesktopWindowStateStore(filePath).saveSync(state);
      expect(createDesktopWindowStateStore(filePath).load()).toEqual(state);
    } finally {
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("queued writes land on disk after flush", async () => {
    const filePath = tempFile();
    try {
      const store = createDesktopWindowStateStore(filePath);
      store.save(state);
      await store.flush();
      expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ version: 1, ...state });
      expect(createDesktopWindowStateStore(filePath).load()).toEqual(state);
    } finally {
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("a queued write never overwrites a newer synchronous write", async () => {
    const filePath = tempFile();
    try {
      const store = createDesktopWindowStateStore(filePath);
      store.save({ ...state, bounds: { x: 10, y: 10, width: 800, height: 600 } });
      store.saveSync(state);
      await store.flush();
      expect(createDesktopWindowStateStore(filePath).load()).toEqual(state);
    } finally {
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  test("a corrupt file falls back to no saved state", () => {
    const filePath = tempFile();
    try {
      writeFileSync(filePath, "{ truncated", "utf8");
      expect(createDesktopWindowStateStore(filePath).load()).toBeUndefined();
    } finally {
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
