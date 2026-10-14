import type { Rectangle } from "electron";

/** Smallest horizontal slice of a restored window that must stay on a display. */
export const WINDOW_MIN_VISIBLE_WIDTH = 120;
/** Smallest vertical slice (the draggable title bar) that must stay on a display. */
export const WINDOW_MIN_VISIBLE_HEIGHT = 40;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSizing {
  bounds: WindowBounds;
  minWidth: number;
  minHeight: number;
}

export function centerBoundsInWorkArea(workArea: Rectangle, width: number, height: number): WindowBounds {
  const boundedWidth = Math.min(width, workArea.width);
  const boundedHeight = Math.min(height, workArea.height);
  const x = Math.round(workArea.x + (workArea.width - boundedWidth) / 2);
  const y = Math.round(workArea.y + (workArea.height - boundedHeight) / 2);
  return { x, y, width: boundedWidth, height: boundedHeight };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Electron refuses to shrink a window below its minimum size, so clamping the
 * requested size is not enough on its own: when the minimum is taller than the
 * work area the window still hangs off the screen. Size and minimums must both
 * fit the work area.
 */
export function fitWindowToWorkArea(
  workArea: Rectangle,
  width: number,
  height: number,
  minWidth: number,
  minHeight: number,
): WindowSizing {
  const bounds = centerBoundsInWorkArea(workArea, width, height);
  return {
    bounds,
    minWidth: Math.min(minWidth, bounds.width),
    minHeight: Math.min(minHeight, bounds.height),
  };
}

/**
 * Keep a saved frame usable on a work area that may have moved or shrunk: the
 * size is fitted to the work area, and the origin is pulled back until a strip
 * of the window (wide enough to grab, tall enough for the title bar) is inside
 * the work area. A window dragged mostly off the edge of its own display is
 * therefore restored where the user left it, while a frame that now points at
 * no display at all comes back on screen.
 */
export function fitBoundsToWorkArea(
  workArea: Rectangle,
  bounds: WindowBounds,
  minWidth: number,
  minHeight: number,
): WindowSizing {
  const width = clamp(bounds.width, Math.min(minWidth, workArea.width), workArea.width);
  const height = clamp(bounds.height, Math.min(minHeight, workArea.height), workArea.height);
  const visibleWidth = Math.min(WINDOW_MIN_VISIBLE_WIDTH, width);
  const visibleHeight = Math.min(WINDOW_MIN_VISIBLE_HEIGHT, height);
  return {
    bounds: {
      x: Math.round(
        clamp(bounds.x, workArea.x - width + visibleWidth, workArea.x + workArea.width - visibleWidth),
      ),
      y: Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - visibleHeight)),
      width: Math.round(width),
      height: Math.round(height),
    },
    minWidth: Math.min(minWidth, width),
    minHeight: Math.min(minHeight, height),
  };
}
