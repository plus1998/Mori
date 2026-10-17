import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FolderOpen,
  Globe,
  KeyRound,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  Terminal,
  MousePointer2,
  TextSelect,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type BrowserViewState, normalizeBrowserNavigateUrl } from "../shared/browser";
import { BrowserViewportControls } from "./BrowserViewportControls";
import { BrowserWebviewViewportMarker } from "./BrowserWebviewViewportMarker";
import { useBrowserInstanceIds } from "./browser-state-store";
import type { TaskPanelHomeTool } from "./task-panel-tabs";
import { insertBrowserSelection } from "./browser-selection-events";
import { formatIpcInvokeError } from "./AppMessage";

const ICON_SIZE = 15;

export interface BrowserPanelProps {
  /** True when this browser task-panel tab is the active pane. */
  active: boolean;
  /** Eco browser instance id for this task tab. */
  browserId: string;
  onOpenTool: (browserId: string, tool: TaskPanelHomeTool) => void;
}

/**
 * Right task-panel browser chrome. Guest WebContents are owned by
 * {@link browserWebviewPool} in {@link BrowserWebviewLayer}; this panel only
 * publishes viewport bounds via {@link BrowserWebviewViewportMarker}.
 */
export function BrowserPanel({ active, browserId, onOpenTool }: BrowserPanelProps) {
  const { t } = useTranslation();
  const toolHomeTitleId = `browser-tool-home-title-${browserId}`;
  const [state, setState] = useState<BrowserViewState | undefined>();
  const [address, setAddress] = useState("");
  const [showViewportControls, setShowViewportControls] = useState<boolean | null>(null);
  const [selecting, setSelecting] = useState<"element" | "text">();
  const [selectionError, setSelectionError] = useState<string>();
  const selectionRequest = useRef(0);
  const addressInputId = useId();
  /** Main drops a closed browser from its guest list — never focus a page that is gone. */
  const liveBrowserIds = useBrowserInstanceIds();

  const instance = state?.instances.find((item) => item.id === browserId);
  const viewportControlsVisible = showViewportControls ?? Boolean(instance?.viewport);
  const displayUrl = instance?.url ?? "about:blank";
  const canGoBack = instance?.canGoBack ?? false;
  const canGoForward = instance?.canGoForward ?? false;
  const isLoading = instance?.isLoading ?? false;
  const showToolHome = instance !== undefined && !isLoading && displayUrl === "about:blank";

  useEffect(() => {
    void window.eco?.getBrowserState?.().then((next) => {
      setState(next);
      const url = next.instances.find((i) => i.id === browserId)?.url;
      if (url === undefined) return;
      setAddress(url === "about:blank" ? "" : url);
    });
  }, [browserId]);

  useEffect(() => {
    if (!active || !liveBrowserIds.includes(browserId)) {
      return;
    }
    void window.eco?.browserFocus?.({ browserId, reveal: true });
    void window.eco?.browserSetVisible?.({ visible: true, browserId }).then((next) => {
      if (next) {
        setState(next);
        const url = next.instances.find((i) => i.id === browserId)?.url;
        if (url === undefined) return;
        setAddress(url === "about:blank" ? "" : url);
      }
    });
  }, [active, browserId, liveBrowserIds]);

  useEffect(() => {
    const unsubscribe = window.eco?.onBrowserStateChanged?.((next) => {
      setState(next);
      if (!active) {
        return;
      }
      if (!document.activeElement || document.activeElement.id !== addressInputId) {
        const url = next.instances.find((i) => i.id === browserId)?.url;
        if (url === undefined) return;
        setAddress(url === "about:blank" ? "" : url);
      }
    });
    return () => unsubscribe?.();
  }, [active, addressInputId, browserId]);

  async function submitAddress(event: FormEvent) {
    event.preventDefault();
    const url = normalizeBrowserNavigateUrl(address);
    if (!url || !window.eco?.browserNavigate) {
      return;
    }
    const next = await window.eco.browserNavigate({ url, reveal: true, browserId });
    setState(next);
    const shown = next.instances.find((i) => i.id === browserId)?.url;
    if (shown === undefined) return;
    setAddress(shown === "about:blank" ? "" : shown);
  }

  useEffect(() => {
    if (!active) {
      selectionRequest.current += 1;
      setSelecting(undefined);
      void window.eco?.browserCancelSelection(browserId);
    }
    return () => {
      selectionRequest.current += 1;
      void window.eco?.browserCancelSelection(browserId);
    };
  }, [active, browserId]);

  async function captureSelection(kind: "element" | "text") {
    if (selecting) { await window.eco?.browserCancelSelection(browserId); return; }
    const request = ++selectionRequest.current;
    setSelecting(kind);
    setSelectionError(undefined);
    try {
      if (!window.eco) throw new Error(t("browser.selection.unavailable"));
      const selection = await window.eco.browserCaptureSelection({ browserId, kind });
      if (request === selectionRequest.current && selection) insertBrowserSelection(selection);
    } catch (error) {
      if (request === selectionRequest.current) setSelectionError(formatIpcInvokeError(error));
    } finally {
      if (request === selectionRequest.current) setSelecting(undefined);
    }
  }

  return (
    <div className="browser-panel" aria-label={t("browser.title")}>
      <div className="browser-panel-chrome">
        <div className="browser-panel-nav">
          <button
            type="button"
            className="browser-panel-icon-btn"
            disabled={!canGoBack}
            onClick={() => void window.eco?.browserGoBack?.(browserId)}
            aria-label={t("browser.back")}
            title={t("browser.back")}
          >
            <ArrowLeft size={ICON_SIZE} />
          </button>
          <button
            type="button"
            className="browser-panel-icon-btn"
            disabled={!canGoForward}
            onClick={() => void window.eco?.browserGoForward?.(browserId)}
            aria-label={t("browser.forward")}
            title={t("browser.forward")}
          >
            <ArrowRight size={ICON_SIZE} />
          </button>
          <button
            type="button"
            className="browser-panel-icon-btn"
            onClick={() => void window.eco?.browserReload?.(browserId)}
            aria-label={t("browser.reload")}
            title={t("browser.reload")}
          >
            {isLoading ? (
              <LoaderCircle size={ICON_SIZE} className="browser-panel-spin" />
            ) : (
              <RefreshCw size={ICON_SIZE} />
            )}
          </button>
        </div>
        <form className="browser-panel-address-form" onSubmit={(event) => void submitAddress(event)}>
          <label className="sr-only" htmlFor={addressInputId}>
            {t("browser.address")}
          </label>
          <Globe size={14} aria-hidden className="browser-panel-address-icon" />
          <input
            id={addressInputId}
            className="browser-panel-address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder={t("browser.addressPlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
        </form>
        <button type="button" className={`browser-panel-icon-btn${selecting === "element" ? " is-active" : ""}`}
          aria-label={t(selecting === "element" ? "browser.selection.cancel" : "browser.selection.element")}
          title={t(selecting === "element" ? "browser.selection.cancel" : "browser.selection.element")}
          aria-pressed={selecting === "element"} disabled={showToolHome || isLoading || selecting === "text"}
          onClick={() => void captureSelection("element")}><MousePointer2 size={ICON_SIZE} /></button>
        <button type="button" className="browser-panel-icon-btn" aria-label={t("browser.selection.text")} title={t("browser.selection.text")}
          disabled={showToolHome || isLoading || Boolean(selecting)} onMouseDown={event => event.preventDefault()}
          onClick={() => void captureSelection("text")}><TextSelect size={ICON_SIZE} /></button>
        <button
          type="button"
          className={`browser-panel-icon-btn${instance?.viewport ? " is-active" : ""}`}
          aria-label={t("browser.viewportDevice")}
          title={t("browser.viewportDevice")}
          aria-expanded={viewportControlsVisible}
          onClick={() => setShowViewportControls(!viewportControlsVisible)}
        >
          <Smartphone size={ICON_SIZE} />
        </button>
        <button
          type="button"
          className="browser-panel-icon-btn"
          disabled={!displayUrl || displayUrl === "about:blank"}
          onClick={() => void window.eco?.browserOpenExternal?.(browserId)}
          aria-label={t("browser.openExternal")}
          title={t("browser.openExternal")}
        >
          <ExternalLink size={ICON_SIZE} />
        </button>
      </div>
      {viewportControlsVisible ? (
        <BrowserViewportControls browserId={browserId} viewport={instance?.viewport} onChange={setState} />
      ) : null}
      {selecting === "element" ? <div className="browser-selection-hint" role="status">{t("browser.selection.hint")}</div> : null}
      {selectionError ? <div className="browser-viewport-error" role="alert">{selectionError}</div> : null}
      {instance?.viewportError ? (
        <div className="browser-viewport-error" role="alert">
          {instance.viewportError}
        </div>
      ) : null}
      <div className="browser-panel-content">
        {showToolHome ? (
          <section
            className="task-panel-home-actions browser-panel-tool-home"
            aria-labelledby={toolHomeTitleId}
          >
            <h2 id={toolHomeTitleId}>{t("browser.toolsTitle")}</h2>
            <button type="button" onClick={() => onOpenTool(browserId, "review")}>
              <ListChecks size={17} aria-hidden />
              <span>{t("task.review")}</span>
            </button>
            <button type="button" onClick={() => onOpenTool(browserId, "terminal")}>
              <Terminal size={17} aria-hidden />
              <span>{t("task.terminal")}</span>
            </button>
            <button type="button" onClick={() => onOpenTool(browserId, "files")}>
              <FolderOpen size={17} aria-hidden />
              <span>{t("task.files")}</span>
            </button>
            <button type="button" onClick={() => onOpenTool(browserId, "sshBookmarks")}>
              <KeyRound size={17} aria-hidden />
              <span>{t("app.sshBookmarks.title")}</span>
            </button>
          </section>
        ) : null}
        <BrowserWebviewViewportMarker browserId={browserId} active={active} />
      </div>
    </div>
  );
}
