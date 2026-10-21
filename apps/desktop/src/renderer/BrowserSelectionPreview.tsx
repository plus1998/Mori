import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Crosshair, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BrowserSelectionPreview as Preview } from "../shared/browser-selection";
import { BROWSER_SELECTION_PREVIEW_EVENT, BROWSER_SELECTION_REVEAL_EVENT } from "./browser-selection-events";
import { formatIpcInvokeError } from "./AppMessage";

/** Only loads a saved snapshot when a reference chip is opened. */
export function BrowserSelectionPreview() {
  const { t } = useTranslation();
  const titleId = useId();
  const [id, setId] = useState<string>();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [revealing, setRevealing] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (typeof next !== "string") return;
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      setPreview(undefined);
      setError(undefined);
      setId(next);
    };
    window.addEventListener(BROWSER_SELECTION_PREVIEW_EVENT, open);
    return () => window.removeEventListener(BROWSER_SELECTION_PREVIEW_EVENT, open);
  }, []);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    closeRef.current?.focus();
    const read = async () => {
      if (!window.eco) throw new Error(t("browser.selection.unavailable"));
      return window.eco.browserReadSelection(id);
    };
    void read().then(value => { if (!cancelled) setPreview(value); })
      .catch(caught => { if (!cancelled) setError(formatIpcInvokeError(caught)); });
    return () => { cancelled = true; previouslyFocused.current?.focus(); };
  }, [id, t]);
  if (!id) return null;
  const reveal = async () => {
    setRevealing(true);
    setError(undefined);
    try {
      if (!window.eco) throw new Error(t("browser.selection.unavailable"));
      const state = await window.eco.browserRevealSelection(id);
      window.dispatchEvent(new CustomEvent(BROWSER_SELECTION_REVEAL_EVENT, { detail: state }));
      setId(undefined);
    } catch (caught) { setError(formatIpcInvokeError(caught)); }
    finally { setRevealing(false); }
  };
  return createPortal(
    <div className="browser-selection-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setId(undefined); }}>
      <section className="browser-selection-preview" role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); setId(undefined); }
          if (event.key === "Tab") {
            const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header>
          <strong id={titleId}>{t("browser.selection.preview")}</strong>
          <button ref={closeRef} type="button" onClick={() => setId(undefined)} aria-label={t("browser.selection.close")}><X size={18} /></button>
        </header>
        {error ? <p className="browser-selection-error" role="alert">{error}</p> : null}
        {preview ? <>
          <div className="browser-selection-details">
            <strong>{preview.selection.title}</strong>
            <span className="browser-selection-url">{preview.selection.url}</span>
            <time dateTime={preview.selection.capturedAt}>{new Date(preview.selection.capturedAt).toLocaleString()}</time>
            <blockquote>{preview.selection.text || preview.selection.name || preview.selection.tag}</blockquote>
            {preview.selection.textTruncated ? <p>{t("browser.selection.truncated")}</p> : null}
          </div>
          <img src={preview.screenshotDataUrl} alt={t("browser.selection.snapshot")} />
          <footer><button type="button" disabled={revealing} onClick={() => void reveal()}><Crosshair size={15} />{t("browser.selection.reveal")}</button></footer>
        </> : !error ? <p role="status">{t("browser.selection.loading")}</p> : null}
      </section>
    </div>, document.body,
  );
}
