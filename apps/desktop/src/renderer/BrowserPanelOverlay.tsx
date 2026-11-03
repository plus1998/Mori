import { type ReactNode, useCallback, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  BROWSER_WEBVIEW_VISIBLE_Z_INDEX,
  resolveBrowserWebviewViewportRect,
  subscribeBrowserWebviewViewportRect,
} from "./browser-webview-layout";

/** Portal above the persistent guest, without changing its viewport bounds. */
export function BrowserPanelOverlay({ browserId, children }: { browserId: string; children: ReactNode }) {
  const subscribe = useCallback(
    (listener: () => void) => subscribeBrowserWebviewViewportRect(browserId, listener),
    [browserId],
  );
  const getRect = useCallback(() => resolveBrowserWebviewViewportRect(browserId), [browserId]);
  const rect = useSyncExternalStore(subscribe, getRect, getRect);
  if (!rect) return null;

  return createPortal(
    <div className="browser-panel-floating-layer" style={{
      position: "fixed", left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      zIndex: BROWSER_WEBVIEW_VISIBLE_Z_INDEX + 1,
    }}>
      {children}
    </div>,
    document.body,
  );
}
