import {
  AudioLines,
  Palette,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Download,
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
  Columns2,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type BrowserViewState, normalizeBrowserNavigateUrl } from "../shared/browser";
import { BrowserViewportControls } from "./BrowserViewportControls";
import { BrowserDownloadsPanel } from "./BrowserDownloadsPanel";
import { BrowserWebviewViewportMarker } from "./BrowserWebviewViewportMarker";
import { useBrowserInstanceIds } from "./browser-state-store";
import type { TaskPanelHomeTool } from "./task-panel-tabs";
import { insertBrowserSelection } from "./browser-selection-events";
import { formatIpcInvokeError } from "./AppMessage";
import { BrowserAddressInput } from "./BrowserAddressInput";

const ICON_SIZE = 15;

export interface BrowserPanelProps {
  /** True when this browser task-panel tab is the active pane. */
  active: boolean;
  /** A split's secondary pane stays visible without taking the focused browser. */
  visible?: boolean;
  /** Eco browser instance id for this task tab. */
  browserId: string;
  onOpenTool: (browserId: string, tool: TaskPanelHomeTool) => void;
  onToggleSplit?: () => void;
  split?: boolean;
  splitBusy?: boolean;
}

/**
 * Right task-panel browser chrome. Guest WebContents are owned by
 * {@link browserWebviewPool} in {@link BrowserWebviewLayer}; this panel only
 * publishes viewport bounds via {@link BrowserWebviewViewportMarker}.
 */
export function BrowserPanel({ active, visible = active, browserId, onOpenTool, onToggleSplit, split, splitBusy }: BrowserPanelProps) {
  const { t } = useTranslation();
  const toolHomeTitleId = `browser-tool-home-title-${browserId}`;
  const [state, setState] = useState<BrowserViewState | undefined>();
  const [address, setAddress] = useState("");
  const [showViewportControls, setShowViewportControls] = useState<boolean | null>(null);
  const [selecting, setSelecting] = useState<"element" | "text">();
  const [selectionError, setSelectionError] = useState<string>();
  const [showDownloads, setShowDownloads] = useState(false);
  const [openingExternal, setOpeningExternal] = useState(false);
  const [externalOpenError, setExternalOpenError] = useState<{
    browserId: string;
    url: string;
    message: string;
  }>();
  const selectionRequest = useRef(0);
  const addressInputId = useId();
  const [addressMenuOpen, setAddressMenuOpen] = useState(false);
  /** Main drops a closed browser from its guest list — never focus a page that is gone. */
  const liveBrowserIds = useBrowserInstanceIds();
  const browserLive = liveBrowserIds.includes(browserId);

  const instance = state?.instances.find((item) => item.id === browserId);
  const downloads = instance?.downloads;
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
    if (!active || !browserLive) {
      return;
    }
    void window.eco?.browserFocus?.({ browserId, reveal: true });
    void window.eco?.browserSetVisible?.({ visible: true, browserId }).then((next) => {
      if (next) {
        setState(next);
      }
    });
  }, [active, browserId, browserLive]);

  useEffect(() => {
    const unsubscribe = window.eco?.onBrowserStateChanged?.((next) => {
      setState(next);
      if (!visible) {
        return;
      }
      if (!addressMenuOpen && document.activeElement?.id !== addressInputId) {
        const url = next.instances.find((i) => i.id === browserId)?.url;
        if (url === undefined) return;
        setAddress(url === "about:blank" ? "" : url);
      }
    });
    return () => unsubscribe?.();
  }, [visible, addressInputId, addressMenuOpen, browserId]);

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

  async function openExternal() {
    if (openingExternal) return;
    setOpeningExternal(true);
    setExternalOpenError(undefined);
    try {
      if (!window.eco?.browserOpenExternal) throw new Error(t("browser.openExternalUnavailable"));
      await window.eco.browserOpenExternal(browserId);
    } catch (error) {
      setExternalOpenError({ browserId, url: displayUrl, message: formatIpcInvokeError(error) });
    } finally {
      setOpeningExternal(false);
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
          <BrowserAddressInput
            id={addressInputId}
            value={address}
            onValueChange={setAddress}
            onMenuOpenChange={setAddressMenuOpen}
            active={active}
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
          className="browser-panel-icon-btn browser-downloads-toggle"
          aria-label={t("browser.downloads.title")}
          title={t("browser.downloads.title")}
          aria-expanded={showDownloads}
          onClick={() => setShowDownloads(value => !value)}
        >
          <Download size={ICON_SIZE} />
          {downloads?.length ? <span>{downloads.length}</span> : null}
        </button>
        <button
          type="button"
          className="browser-panel-icon-btn"
          disabled={!displayUrl || displayUrl === "about:blank" || openingExternal}
          onClick={() => void openExternal()}
          aria-busy={openingExternal}
          aria-label={t("browser.openExternal")}
          title={t("browser.openExternal")}
        >
          <ExternalLink size={ICON_SIZE} />
        </button>
        {onToggleSplit ? (
          <button type="button" className={`browser-panel-icon-btn${split ? " is-active" : ""}`}
            title={t(split ? "browser.split.exit" : "browser.split.start")}
            aria-label={t(split ? "browser.split.exit" : "browser.split.start")}
            aria-pressed={Boolean(split)} disabled={splitBusy} onClick={onToggleSplit}>
            <Columns2 size={ICON_SIZE} />
          </button>
        ) : null}
      </div>
      {externalOpenError?.browserId === browserId && externalOpenError.url === displayUrl ? (
        <div className="browser-viewport-error" role="alert">
          {t("browser.openExternalFailed", { error: externalOpenError.message })}
        </div>
      ) : null}
      {showDownloads ? <BrowserDownloadsPanel browserId={browserId} files={downloads ?? []} /> : null}
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
            <button type="button" onClick={() => onOpenTool(browserId, "imageGeneration")}>
              <Palette size={17} aria-hidden />
              <span>{t("settings.imageGeneration.title")}</span>
            </button>
            <button type="button" onClick={() => onOpenTool(browserId, "speechGeneration")}>
              <AudioLines size={17} aria-hidden />
              <span>{t("settings.tts.title")}</span>
            </button>
          </section>
        ) : null}
        <BrowserWebviewViewportMarker browserId={browserId} active={visible} />
      </div>
    </div>
  );
}
