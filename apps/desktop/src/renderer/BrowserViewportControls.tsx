import { useCallback, useEffect, useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserViewState } from "../shared/browser";
import {
  BROWSER_VIEWPORT_DISPLAY_SCALES,
  BROWSER_VIEWPORT_PICKER_PRESETS,
  type BrowserViewport,
  type BrowserViewportInput,
  fitBrowserViewport,
  responsiveBrowserViewport,
} from "../shared/browser-viewport";
import {
  getBrowserWebviewDisplayScale,
  resolveBrowserWebviewViewportRect,
  setBrowserWebviewDeviceMode,
  setBrowserWebviewDisplayScale,
  subscribeBrowserWebviewViewportRect,
} from "./browser-webview-layout";

function ViewportOrientationIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v5" />
      <rect x="9" y="12" width="12" height="8" rx="1" />
      <path d="M16 3h1a3 3 0 0 1 3 3v3m-2-2 2 2 2-2" />
    </svg>
  );
}

export function BrowserViewportControls({
  browserId,
  viewport,
  onChange,
}: {
  browserId: string;
  viewport: BrowserViewport | undefined;
  onChange: (state: BrowserViewState) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const subscribe = useCallback(
    (listener: () => void) => subscribeBrowserWebviewViewportRect(browserId, listener),
    [browserId],
  );
  const snapshot = useCallback(() => resolveBrowserWebviewViewportRect(browserId), [browserId]);
  const rect = useSyncExternalStore(subscribe, snapshot, snapshot);
  const getDisplayScale = useCallback(() => getBrowserWebviewDisplayScale(browserId), [browserId]);
  const displayScale = useSyncExternalStore(subscribe, getDisplayScale, getDisplayScale);
  const size = viewport ?? (rect ? responsiveBrowserViewport(rect) : undefined);
  const fitScale = rect && size ? fitBrowserViewport(rect, size).scale : 1;
  const selectedDevice = BROWSER_VIEWPORT_PICKER_PRESETS.find((device) => device.preset === viewport?.preset);
  const selectedPreset = selectedDevice?.preset ?? "auto";

  useEffect(() => {
    setBrowserWebviewDeviceMode(browserId, true);
    return () => setBrowserWebviewDeviceMode(browserId, false);
  }, [browserId]);

  async function apply(input: BrowserViewportInput) {
    setPending(true);
    setError(undefined);
    try {
      if (!window.eco?.browserSetViewport) throw new Error(t("browser.viewportUnavailable"));
      onChange(await window.eco.browserSetViewport({ browserId, ...input }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="browser-viewport-controls">
      <fieldset disabled={pending}>
        <label className="sr-only" htmlFor={`${id}-preset`}>
          {t("browser.viewportDevice")}
        </label>
        <span className="browser-viewport-picker">
          <span aria-hidden="true">{selectedDevice?.name ?? t("browser.viewportAuto")}</span>
          <select
            id={`${id}-preset`}
            value={selectedPreset}
            onChange={(event) => {
              void apply({ preset: event.target.value as NonNullable<BrowserViewportInput["preset"]> });
            }}
          >
            <option value="auto">{t("browser.viewportAuto")}</option>
            {(["mobile", "foldable", "tablet", "display"] as const).map((group) => (
              <optgroup key={group} label={t(`browser.viewportGroup.${group}`)}>
                {BROWSER_VIEWPORT_PICKER_PRESETS.filter((device) => device.group === group).map((device) => (
                  <option key={device.preset} value={device.preset}>
                    {device.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </span>
        <span className="browser-viewport-dimensions" title={t("browser.viewportResizeHint")}>
          {size ? `${size.width} × ${size.height}` : "—"}
        </span>
        <span
          className="browser-viewport-picker browser-viewport-scale-picker"
          title={t("browser.viewportScaleHint")}
        >
          <span aria-hidden="true">{Math.round((displayScale ?? fitScale) * 100)}%</span>
          <select
            className="browser-viewport-scale"
            aria-label={t("browser.viewportScale")}
            title={t("browser.viewportScaleHint")}
            value={displayScale ?? "fit"}
            onChange={(event) =>
              setBrowserWebviewDisplayScale(
                browserId,
                event.target.value === "fit" ? undefined : Number(event.target.value),
              )
            }
          >
            <option value="fit">
              {t("browser.viewportFit")} ({Math.round(fitScale * 100)}%)
            </option>
            {BROWSER_VIEWPORT_DISPLAY_SCALES.map((value) => (
              <option key={value} value={value}>
                {value * 100}%
              </option>
            ))}
          </select>
        </span>
        <button
          type="button"
          className="browser-panel-icon-btn browser-viewport-rotate"
          disabled={!size}
          title={t("browser.viewportRotate")}
          aria-label={t("browser.viewportRotate")}
          onClick={() => {
            if (!size) return;
            void apply(
              viewport && viewport.preset !== "custom"
                ? { preset: viewport.preset, landscape: viewport.width <= viewport.height }
                : {
                    width: size.height,
                    height: size.width,
                    deviceScaleFactor: viewport?.deviceScaleFactor ?? 1,
                    mobile: viewport?.mobile ?? false,
                    touch: viewport?.touch ?? false,
                  },
            );
          }}
        >
          <ViewportOrientationIcon />
        </button>
      </fieldset>
      {error ? (
        <div role="alert" className="browser-viewport-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
