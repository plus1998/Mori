import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { EcoDesktopApi } from "../preload";
import { BrowserPanel } from "./BrowserPanel";
import { BrowserWebviewLayer } from "./BrowserWebviewLayer";
import { browserStateStore, useBrowserStateSelector } from "./browser-state-store";
import { BROWSER_SELECTION_INSERT_EVENT } from "./browser-selection-events";
import { BROWSER_SCREENSHOT_CAPTURED_EVENT, type BrowserScreenshotCaptured } from "./browser-screenshot-events";
import type { BrowserSelection } from "../shared/browser-selection";
import { readStoredLocalePreference } from "../shared/locale";
import { getResolvedRendererLocale, i18n } from "./i18n";
import { readStoredAppTheme, resolveAppTheme, subscribeToSystemTheme } from "./theme";
import "./themes.css";
import "./styles.css";
import "./browser-window.css";

function requireBrowserApi(): EcoDesktopApi {
  if (!window.eco) throw new Error("浏览器窗口未连接桌面服务。");
  return window.eco;
}
const eco = requireBrowserApi();

const browserId = new URLSearchParams(window.location.search).get("browserId") ?? "";

function BrowserWindowApp() {
  const [error, setError] = useState<string>();
  const instance = useBrowserStateSelector(state => state?.allInstances.find(item => item.id === browserId));

  useEffect(() => {
    void browserStateStore.hydrate().catch(error => setError(String(error)));
    const syncPreferences = () => {
      document.documentElement.dataset.theme = resolveAppTheme(readStoredAppTheme());
      void i18n.changeLanguage(getResolvedRendererLocale(readStoredLocalePreference(localStorage)));
      document.documentElement.lang = i18n.resolvedLanguage ?? "zh-CN";
    };
    syncPreferences();
    window.addEventListener("storage", syncPreferences);
    const offTheme = subscribeToSystemTheme(syncPreferences);
    const selection = (event: Event) => {
      const detail = (event as CustomEvent<BrowserSelection>).detail;
      void eco.browserWindowAction({ kind: "selection", selection: detail }).catch(error => setError(String(error)));
    };
    const screenshot = (event: Event) => {
      const detail = (event as CustomEvent<BrowserScreenshotCaptured>).detail;
      void eco.browserWindowAction({ kind: "screenshot", ...detail }).catch(error => setError(String(error)));
    };
    window.addEventListener(BROWSER_SELECTION_INSERT_EVENT, selection);
    window.addEventListener(BROWSER_SCREENSHOT_CAPTURED_EVENT, screenshot);
    return () => {
      offTheme();
      window.removeEventListener("storage", syncPreferences);
      window.removeEventListener(BROWSER_SELECTION_INSERT_EVENT, selection);
      window.removeEventListener(BROWSER_SCREENSHOT_CAPTURED_EVENT, screenshot);
    };
  }, []);

  useEffect(() => { document.title = instance?.title ? `${instance.title} · Mori` : "Mori"; }, [instance?.title]);

  return <div className="browser-window-root">
    {error ? <div className="browser-viewport-error" role="alert">{error}</div> : null}
    <BrowserPanel standalone browserId={browserId} active visible onOpenTool={(id, tool) => {
      void eco.browserWindowAction({ kind: "tool", browserId: id, tool }).catch(error => setError(String(error)));
    }} />
    <BrowserWebviewLayer windowBrowserId={browserId} />
  </div>;
}

createRoot(document.getElementById("root")!).render(<I18nextProvider i18n={i18n}><BrowserWindowApp /></I18nextProvider>);
