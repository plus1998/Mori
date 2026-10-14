import { screen } from "electron";
import {
  centerBoundsInWorkArea,
  fitWindowToWorkArea,
  type WindowBounds,
  type WindowSizing,
} from "./desktop-window-bounds";
import {
  type DesktopWindowState,
  type DisplayGeometry,
  type RestoredWindowSizing,
  resolveRestoredWindowSizing,
} from "./desktop-window-state";

export {
  centerBoundsInWorkArea,
  fitWindowToWorkArea,
  type WindowBounds,
  type WindowSizing,
} from "./desktop-window-bounds";

function toDisplayGeometry(display: Electron.Display): DisplayGeometry {
  return { id: display.id, bounds: display.bounds, workArea: display.workArea };
}

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

/**
 * Startup placement for a real window: restore the saved size, position and
 * display, and only fall back to centering on the display under the cursor when
 * there is no saved frame or its display is gone.
 */
export function resolveStartupWindowSizing(
  saved: DesktopWindowState | undefined,
  preferredWidth: number,
  preferredHeight: number,
  minWidth: number,
  minHeight: number,
): RestoredWindowSizing {
  const cursor = screen.getCursorScreenPoint();
  return resolveRestoredWindowSizing({
    saved,
    displays: screen.getAllDisplays().map(toDisplayGeometry),
    fallbackDisplay: toDisplayGeometry(screen.getDisplayNearestPoint(cursor)),
    preferredWidth,
    preferredHeight,
    minWidth,
    minHeight,
  });
}
