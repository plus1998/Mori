import { Copy, ExternalLink, Share2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ConversationShareResult } from "../shared/conversation-share";
import { dispatchBrowserLinkOpen } from "./browser-link";
import "./conversation-share.css";

export function ConversationShareButton({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConversationShareResult>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
      if (event.key === "Tab") {
        const buttons = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input") ?? []),
        ];
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      triggerRef.current?.focus();
    };
  }, [open]);

  async function publish() {
    if (!window.eco || pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    setError("");
    setCopied(false);
    setResult(undefined);
    try {
      setResult(await window.eco.shareConversation(threadId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.publicUrl);
      setCopied(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="conversation-share-trigger"
        title={t("share.title")}
        aria-label={t("share.title")}
        onClick={() => setOpen(true)}
      >
        <Share2 size={14} aria-hidden />
      </button>
      {open
        ? createPortal(
            <div
              className="settings-modal-backdrop conversation-share-backdrop"
              role="presentation"
              onPointerDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <section
                ref={dialogRef}
                className="settings-modal conversation-share-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="conversation-share-title"
              >
                <header className="settings-modal-header">
                  <h2 id="conversation-share-title" className="settings-modal-title">
                    {t("share.title")}
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    className="settings-modal-cancel"
                    aria-label={t("share.close")}
                    onClick={() => setOpen(false)}
                  >
                    <X size={16} />
                  </button>
                </header>
                <div className="settings-modal-body">
                  <p>{t("share.description")}</p>
                  <p className="conversation-share-hint">{t("share.visibility")}</p>
                  {busy ? <p role="status">{t("share.publishing")}</p> : null}
                  {result ? (
                    <div className="conversation-share-result">
                      <label htmlFor="conversation-share-url">{t("share.link")}</label>
                      <input
                        id="conversation-share-url"
                        readOnly
                        value={result.publicUrl}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                      <p className="conversation-share-hint">
                        {t("share.expires", { date: new Date(result.expiresAt).toLocaleString() })}
                      </p>
                    </div>
                  ) : null}
                  {error ? (
                    <p className="conversation-share-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
                <footer className="settings-modal-footer">
                  {result ? (
                    <>
                      <button type="button" className="settings-modal-cancel" onClick={() => void publish()}>
                        {t("share.createNew")}
                      </button>
                      <button
                        type="button"
                        className="settings-modal-cancel"
                        onClick={() => dispatchBrowserLinkOpen(result.publicUrl)}
                      >
                        <ExternalLink size={14} /> {t("share.preview")}
                      </button>
                      <button type="button" className="plan-button primary" onClick={() => void copy()}>
                        <Copy size={14} /> {t(copied ? "share.copied" : "share.copy")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="plan-button primary"
                      disabled={busy}
                      onClick={() => void publish()}
                    >
                      {t(busy ? "share.publishing" : "share.create")}
                    </button>
                  )}
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
