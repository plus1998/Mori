/**
 * Terminal-facing aliases over the shared context-menu layout (no React DOM deps).
 *
 * The geometry itself lives in `context-menu-layout.ts`: the terminal menu and the image
 * viewer menu clamp to the viewport the same way, and keeping one implementation is what
 * stops their edge behaviour from drifting apart.
 */
import {
  CONTEXT_MENU_VIEWPORT_MARGIN,
  CONTEXT_MENU_WIDTH,
  CONTEXT_MENU_Z_INDEX,
  type ContextMenuBox,
  type ContextMenuPoint,
  type ContextMenuSize,
  contextMenuBoxForPoint,
} from "./context-menu-layout";

export const TERMINAL_CONTEXT_MENU_WIDTH = CONTEXT_MENU_WIDTH;
export const TERMINAL_CONTEXT_MENU_VIEWPORT_MARGIN = CONTEXT_MENU_VIEWPORT_MARGIN;
export const TERMINAL_CONTEXT_MENU_Z_INDEX = CONTEXT_MENU_Z_INDEX;

export type {
  ContextMenuBox as TerminalContextMenuBox,
  ContextMenuPoint as TerminalContextMenuPoint,
  ContextMenuSize as TerminalContextMenuSize,
} from "./context-menu-layout";

export function terminalContextMenuBoxForPoint(
  point: ContextMenuPoint,
  size: ContextMenuSize,
  viewport: { width: number; height: number },
): ContextMenuBox {
  return contextMenuBoxForPoint(point, size, viewport, CONTEXT_MENU_WIDTH);
}
