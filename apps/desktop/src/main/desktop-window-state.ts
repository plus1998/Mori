import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Rectangle } from "electron";
import {
  fitBoundsToWorkArea,
  fitWindowToWorkArea,
  type WindowBounds,
  type WindowSizing,
} from "./desktop-window-bounds";

export { WINDOW_MIN_VISIBLE_HEIGHT, WINDOW_MIN_VISIBLE_WIDTH } from "./desktop-window-bounds";

export const WINDOW_STATE_FILE_NAME = "window-state.json";

/** Envelope version; a bare state object (no envelope) is accepted too. */
const WINDOW_STATE_STORE_VERSION = 1;

/** Debounce for the resize/move listeners: one write per gesture, not per pixel. */
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 400;

export interface DesktopWindowState {
  /** Un-maximized frame: the size the window returns to when un-maximized. */
  bounds: WindowBounds;
  /** Display the window lived on, so a multi-monitor setup restores the same screen. */
  displayId: number;
  isMaximized: boolean;
}

/** Electron `Display` subset, kept structural so the math stays unit-testable. */
export interface DisplayGeometry {
  id: number;
  bounds: Rectangle;
  workArea: Rectangle;
}

export interface RestoredWindowSizing extends WindowSizing {
  isMaximized: boolean;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeBounds(value: unknown): WindowBounds | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !isFiniteNumber(record.x) ||
    !isFiniteNumber(record.y) ||
    !isFiniteNumber(record.width) ||
    !isFiniteNumber(record.height)
  ) {
    return undefined;
  }
  const width = Math.round(record.width);
  const height = Math.round(record.height);
  if (width <= 0 || height <= 0) {
    return undefined;
  }
  return { x: Math.round(record.x), y: Math.round(record.y), width, height };
}

/** Reject anything malformed: a corrupt file must fall back to the default placement. */
export function normalizeWindowState(value: unknown): DesktopWindowState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const payload = "state" in record ? record.state : record;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const state = payload as Record<string, unknown>;
  const bounds =
    normalizeBounds(state.bounds) ??
    normalizeBounds({ x: state.x, y: state.y, width: state.width, height: state.height });
  if (!bounds || !isFiniteNumber(state.displayId)) {
    return undefined;
  }
  return {
    bounds,
    displayId: Math.round(state.displayId),
    isMaximized: state.isMaximized === true,
  };
}

function intersectionArea(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Resolve the display a saved frame belongs to. The display id is the primary
 * key, but it is not stable across replug / adapter re-enumeration, so a frame
 * that still lands on some display keeps its coordinates on that display.
 * Returning undefined means "the saved screen is gone": the caller re-centers.
 */
export function findDisplayForWindowState(
  displays: DisplayGeometry[],
  state: DesktopWindowState,
): DisplayGeometry | undefined {
  const byId = displays.find((display) => display.id === state.displayId);
  if (byId) {
    return byId;
  }
  let best: DisplayGeometry | undefined;
  let bestArea = 0;
  for (const display of displays) {
    const area = intersectionArea(display.bounds, state.bounds);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Startup placement: a saved frame is restored on its own display (fitted back
 * into that display's work area), otherwise the window is centered on the
 * fallback display at the preferred size, exactly as before any state existed.
 */
export function resolveRestoredWindowSizing(input: {
  saved: DesktopWindowState | undefined;
  displays: DisplayGeometry[];
  fallbackDisplay: DisplayGeometry;
  preferredWidth: number;
  preferredHeight: number;
  minWidth: number;
  minHeight: number;
}): RestoredWindowSizing {
  const { saved, preferredWidth, preferredHeight, minWidth, minHeight } = input;
  const display = saved ? findDisplayForWindowState(input.displays, saved) : undefined;
  if (!saved || !display) {
    return {
      ...fitWindowToWorkArea(
        input.fallbackDisplay.workArea,
        preferredWidth,
        preferredHeight,
        minWidth,
        minHeight,
      ),
      isMaximized: false,
    };
  }
  return {
    ...fitBoundsToWorkArea(display.workArea, saved.bounds, minWidth, minHeight),
    isMaximized: saved.isMaximized,
  };
}

/**
 * Last window frame, kept in a small JSON file under userData. Read
 * synchronously at startup: the first BrowserWindow must be created at the
 * restored bounds, and an async read would either delay the boot window or let
 * it appear centered and then jump.
 */
export class DesktopWindowStateStore {
  private state: DesktopWindowState | undefined;
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private writeSeq = 0;
  /** Counts accepted states so a queued write never overwrites a newer frame. */
  private stateSeq = 0;

  constructor(private readonly filePath: string) {}

  load(): DesktopWindowState | undefined {
    if (this.loaded) {
      return this.state;
    }
    this.loaded = true;
    try {
      this.state = normalizeWindowState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch {
      this.state = undefined;
    }
    return this.state;
  }

  peek(): DesktopWindowState | undefined {
    return this.state;
  }

  /** Queues an atomic write; the in-memory value updates immediately. */
  save(state: DesktopWindowState): void {
    const normalized = normalizeWindowState(state);
    if (!normalized) {
      return;
    }
    this.loaded = true;
    this.state = normalized;
    this.stateSeq += 1;
    void this.enqueueWrite(normalized, this.stateSeq);
  }

  /**
   * Write now, synchronously. Used when the window closes: the process may exit
   * before a queued write runs, and losing the frame the user just set is the
   * whole point of this file.
   */
  saveSync(state: DesktopWindowState): void {
    const normalized = normalizeWindowState(state);
    if (!normalized) {
      return;
    }
    this.loaded = true;
    this.state = normalized;
    this.stateSeq += 1;
    try {
      this.writeSync(normalized);
    } catch {
      // A read-only or full userData directory must not break window close.
    }
  }

  /** Await queued writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private serialize(state: DesktopWindowState): string {
    return `${JSON.stringify({ version: WINDOW_STATE_STORE_VERSION, ...state }, null, 2)}\n`;
  }

  private writeSync(state: DesktopWindowState): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Unique temp name + rename: a crash mid-write can never leave a truncated
    // file that the next launch would read as "no saved state".
    const tempPath = this.tempPath();
    fs.writeFileSync(tempPath, this.serialize(state), "utf8");
    fs.renameSync(tempPath, this.filePath);
  }

  private tempPath(): string {
    this.writeSeq += 1;
    return `${this.filePath}.${process.pid}.${this.writeSeq}.tmp`;
  }

  private async enqueueWrite(state: DesktopWindowState, seq: number): Promise<void> {
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        // A newer frame (typically the synchronous close-time write) already won.
        if (seq !== this.stateSeq) {
          return;
        }
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        const tempPath = this.tempPath();
        await fsp.writeFile(tempPath, this.serialize(state), "utf8");
        await fsp.rename(tempPath, this.filePath);
      });
    await this.writeQueue;
  }
}

export function createDesktopWindowStateStore(filePath: string): DesktopWindowStateStore {
  return new DesktopWindowStateStore(filePath);
}
