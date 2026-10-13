import { screen } from "electron";
import {
  centerBoundsInWorkArea,
  fitWindowToWorkArea,
  type WindowBounds,
  type WindowSizing,
} from "./desktop-window-bounds";

export {
  centerBoundsInWorkArea,
  fitWindowToWorkArea,
  type WindowBounds,
  type WindowSizing,
} from "./desktop-window-bounds";

export function resolveInitialWindowBounds(width: number, height: number): WindowBounds {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return centerBoundsInWorkArea(display.workArea, width, height);
}

export function resolveInitialWindowSizing(
  width: number,
  height: number,
  minWidth: number,
  minHeight: number,
): WindowSizing {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  return fitWindowToWorkArea(display.workArea, width, height, minWidth, minHeight);
}
