/** Shared layout helpers for body-portaled right-click menus (no React DOM deps). */

export const CONTEXT_MENU_WIDTH = 188;
export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
/**
 * CSS z-index tops out at int32 max, and the app's modals (`.run-log-image-view-lightbox`,
 * dialogs) already sit at `--eco-modal-z-index: 2147483647`. A context menu opened over one of
 * those must use the same ceiling: equal z-index resolves by DOM order, and a portal mounts at
 * the end of `<body>`, i.e. after the modal it covers. Anything lower renders *behind* the
 * modal — the menu is in the DOM but invisible.
 */
export const CONTEXT_MENU_Z_INDEX = 2_147_483_647;

export interface ContextMenuBox {
  position: "fixed";
  top: number;
  left: number;
  width: number;
  zIndex: number;
}

export interface ContextMenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuSize {
  height: number;
}

/**
 * Context menus open at the pointer with their top-left corner under the cursor, then
 * clamp inside the viewport so a right-click near an edge stays fully readable.
 */
export function contextMenuBoxForPoint(
  point: ContextMenuPoint,
  size: ContextMenuSize,
  viewport: { width: number; height: number },
  width: number = CONTEXT_MENU_WIDTH,
): ContextMenuBox {
  const maxLeft = viewport.width - CONTEXT_MENU_VIEWPORT_MARGIN - width;
  const maxTop = viewport.height - CONTEXT_MENU_VIEWPORT_MARGIN - size.height;
  return {
    position: "fixed",
    left: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(point.x, maxLeft)),
    top: Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, Math.min(point.y, maxTop)),
    width,
    zIndex: CONTEXT_MENU_Z_INDEX,
  };
}
