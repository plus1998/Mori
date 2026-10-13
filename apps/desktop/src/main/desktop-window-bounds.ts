import type { Rectangle } from "electron";

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
