/** Pure layout helpers for the topbar web-chat list popover (no React DOM deps). */

export const WEB_CHAT_LIST_POPOVER_WIDTH = 300;
export const WEB_CHAT_LIST_VIEWPORT_MARGIN = 8;
export const WEB_CHAT_LIST_ANCHOR_GAP = 6;
/** Keep above macOS window chrome z-index (2147483647 is MAX_SAFE for that layer). */
export const WEB_CHAT_LIST_POPOVER_Z_INDEX = 2_000_000_000;

export interface WebChatListPopoverBox {
  position: "fixed";
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  zIndex: number;
  visibility: "visible";
  opacity: number;
}

export interface WebChatListAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

export function webChatListPopoverBoxForRect(
  rect: WebChatListAnchorRect,
  viewport: { width: number; height: number },
  options: { width?: number; maxHeight?: number } = {},
): WebChatListPopoverBox {
  const width = Math.min(
    options.width ?? WEB_CHAT_LIST_POPOVER_WIDTH,
    Math.max(0, viewport.width - WEB_CHAT_LIST_VIEWPORT_MARGIN * 2),
  );
  const rawLeft = rect.right - width;
  const left = Math.max(
    WEB_CHAT_LIST_VIEWPORT_MARGIN,
    Math.min(rawLeft, viewport.width - WEB_CHAT_LIST_VIEWPORT_MARGIN - width),
  );
  const top = Math.max(WEB_CHAT_LIST_VIEWPORT_MARGIN, rect.bottom + WEB_CHAT_LIST_ANCHOR_GAP);
  const maxHeight = Math.min(
    options.maxHeight ?? Number.POSITIVE_INFINITY,
    Math.max(0, viewport.height - top - WEB_CHAT_LIST_VIEWPORT_MARGIN),
  );
  return {
    position: "fixed",
    top,
    left,
    width,
    maxHeight,
    zIndex: WEB_CHAT_LIST_POPOVER_Z_INDEX,
    visibility: "visible",
    opacity: 1,
  };
}
