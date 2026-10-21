import { type CSSProperties, useCallback, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { fitBrowserViewport, responsiveBrowserViewport } from "../shared/browser-viewport";
import { BrowserViewportResizeFrame } from "./BrowserViewportResizeFrame";
import { useBrowserStateSelector } from "./browser-state-store";
import {
  BROWSER_WEBVIEW_OFFSCREEN_HEIGHT,
  BROWSER_WEBVIEW_OFFSCREEN_WIDTH,
  BROWSER_WEBVIEW_VISIBLE_Z_INDEX,
  getBrowserWebviewDisplayScale,
  isBrowserWebviewDeviceMode,
  registerBrowserWebviewHostSlot,
  resolveBrowserWebviewViewportRect,
  setBrowserWebviewDisplayScale,
  subscribeBrowserWebviewViewportRect,
} from "./browser-webview-layout";
import { browserWebviewPool } from "./browser-webview-pool";

export interface BrowserWebviewPersistentHostProps {
  browserId: string;
}

function resolveBrowserErrorHost(url?: string): string {
  const value = url?.trim();
  if (!value || value === "about:blank") {
    return "此站点";
  }
  try {
    return new URL(value).hostname || value;
  } catch {
    return value;
  }
}

function BrowserStatusMark() {
  return (
    <svg className="browser-page-status-mark" viewBox="0 0 48 48" aria-hidden>
      <path d="M35 11c-6-7-18-6-24 1-7 8-3 21 7 24 10 3 20-5 18-15-2-9-13-13-20-7-6 5-4 14 3 16 7 2 13-5 10-11-2-5-9-7-13-3-3 3-2 8 2 9 3 1 6-2 5-5" />
    </svg>
  );
}

/**
 * Fixed-position DOM slot for one browser guest.
 * Lives in {@link BrowserWebviewLayer} (never unmounts with the task panel).
 * The pool attaches the `<webview>` here; visibility follows viewport rects only.
 */
export function BrowserWebviewPersistentHost({ browserId }: BrowserWebviewPersistentHostProps) {
  const { t } = useTranslation();
  const subscribeRect = useCallback(
    (listener: () => void) => subscribeBrowserWebviewViewportRect(browserId, listener),
    [browserId],
  );
  const getRect = useCallback(() => resolveBrowserWebviewViewportRect(browserId), [browserId]);
  const rect = useSyncExternalStore(subscribeRect, getRect, getRect);
  const getDeviceMode = useCallback(() => isBrowserWebviewDeviceMode(browserId), [browserId]);
  const deviceMode = useSyncExternalStore(subscribeRect, getDeviceMode, getDeviceMode);
  const getDisplayScale = useCallback(() => getBrowserWebviewDisplayScale(browserId), [browserId]);
  const displayScale = useSyncExternalStore(subscribeRect, getDisplayScale, getDisplayScale);
  const viewport = useBrowserStateSelector(
    (state) => state?.allInstances.find((instance) => instance.id === browserId)?.viewport,
  );
  const loadError = useBrowserStateSelector(
    (state) => state?.instances.find((instance) => instance.id === browserId)?.loadError,
  );
  const browserUrl = useBrowserStateSelector(
    (state) => state?.instances.find((instance) => instance.id === browserId)?.url,
  );
  const browserIsLoading = useBrowserStateSelector(
    (state) => state?.instances.find((instance) => instance.id === browserId)?.isLoading ?? false,
  );
  const showEmptyState = !loadError && !browserIsLoading && (!browserUrl || browserUrl === "about:blank");
  const errorHost = resolveBrowserErrorHost(loadError?.url ?? browserUrl);
  const showStatus = Boolean(loadError || showEmptyState);

  const hostRef = useCallback(
    (node: HTMLDivElement | null) => {
      registerBrowserWebviewHostSlot(browserId, node);
      if (node) {
        browserWebviewPool.attach(browserId);
      }
    },
    [browserId],
  );

  useEffect(() => {
    return () => {
      registerBrowserWebviewHostSlot(browserId, null);
      setBrowserWebviewDisplayScale(browserId, undefined);
    };
  }, [browserId]);

  const hidden = !rect || rect.width < 8 || rect.height < 8;
  const viewSize = viewport ?? (rect && deviceMode ? responsiveBrowserViewport(rect) : undefined);
  const fit = rect && viewSize ? fitBrowserViewport(rect, viewSize, displayScale) : undefined;
  const wrapperStyle: CSSProperties = hidden
    ? { position: "fixed", left: -10000, top: 0, visibility: "hidden", pointerEvents: "none" }
    : {
        position: "fixed",
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        overflow: "auto",
        zIndex: BROWSER_WEBVIEW_VISIBLE_Z_INDEX,
      };
  const style: CSSProperties = hidden
    ? {
        position: "fixed",
        left: -10000,
        top: 0,
        width: viewSize?.width ?? BROWSER_WEBVIEW_OFFSCREEN_WIDTH,
        height: viewSize?.height ?? BROWSER_WEBVIEW_OFFSCREEN_HEIGHT,
        visibility: "hidden",
        pointerEvents: "none",
        overflow: "hidden",
      }
    : {
        position: "absolute",
        left: fit?.left ?? 0,
        top: fit?.top ?? 0,
        width: viewSize?.width ?? rect.width,
        height: viewSize?.height ?? rect.height,
        transform: fit ? `scale(${fit.scale})` : undefined,
        transformOrigin: "top left",
        zIndex: BROWSER_WEBVIEW_VISIBLE_Z_INDEX,
        overflow: "hidden",
        pointerEvents: "auto",
      };

  return (
    <div className="browser-viewport-scroll" style={wrapperStyle}>
      <div
        style={{
          position: "relative",
          width: fit && rect ? Math.max(rect.width, fit.width + 24) : rect?.width,
          height: fit && rect ? Math.max(rect.height, fit.height + 24) : rect?.height,
          overflow: "hidden",
        }}
      >
        <div
          ref={hostRef}
          className="browser-webview-host-slot"
          data-browser-host
          data-browser-id={browserId}
          data-browser-device={viewport?.preset ?? "auto"}
          data-browser-host-hidden={hidden ? "true" : "false"}
          data-browser-status={showStatus ? "true" : "false"}
          data-browser-empty={showEmptyState ? "true" : "false"}
          style={style}
        >
          {loadError ? (
            <div className="browser-page-status" role="status">
              <div className="browser-page-status-inner">
                <BrowserStatusMark />
                <h1>{t("browser.loadErrorTitle")}</h1>
                <p className="browser-page-status-subtitle">
                  {t("browser.loadErrorSubtitle", { host: errorHost })}
                </p>
                <div className="browser-page-status-try">
                  <div>{t("browser.loadErrorTry")}</div>
                  <ul>
                    <li>{t("browser.loadErrorNetwork")}</li>
                    <li>{t("browser.loadErrorProxy")}</li>
                  </ul>
                </div>
                <div className="browser-page-status-code">{loadError.description}</div>
                <button
                  type="button"
                  className="browser-page-status-retry"
                  onClick={() => void window.eco?.browserReload?.(browserId)}
                >
                  {t("browser.reload")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        {!hidden && deviceMode && fit && rect && viewSize ? (
          <BrowserViewportResizeFrame
            browserId={browserId}
            viewport={{
              ...viewSize,
              deviceScaleFactor: viewport?.deviceScaleFactor ?? 1,
              mobile: viewport?.mobile ?? false,
              touch: viewport?.touch ?? false,
            }}
            scale={fit.scale}
            centered={{ x: fit.width + 24 <= rect.width, y: fit.height + 24 <= rect.height }}
            style={{
              position: "absolute",
              left: fit.left,
              top: fit.top,
              width: fit.width,
              height: fit.height,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
