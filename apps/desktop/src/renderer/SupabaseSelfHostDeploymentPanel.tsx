import { ArrowRight, Bot, Loader2, Server, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { SshBookmarkView } from "../shared/ssh-bookmarks";
import { SshBookmarksPanel } from "./SshBookmarksPanel";
import "./supabase-self-host-deployment.css";

function SelfHostBookmarkPicker({
  onClose,
  onPrepare,
  onBookmarksChange,
}: {
  onClose: () => void;
  onPrepare: (bookmark: SshBookmarkView) => Promise<void>;
  onBookmarksChange: (bookmarks: SshBookmarkView[]) => void;
}) {
  const { t } = useTranslation();
  const [bookmarks, setBookmarks] = useState<SshBookmarkView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const loadRequest = useRef(0);
  const picker = useRef<HTMLDivElement>(null);
  const selected = bookmarks.find((bookmark) => bookmark.id === selectedId);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoading(true);
    setError("");
    try {
      if (!window.eco?.getSshBookmarks) throw new Error(t("settings.center.selfHost.unavailable"));
      const next = await window.eco.getSshBookmarks();
      if (loadRequest.current === request) setBookmarks(next);
    } catch (cause) {
      if (loadRequest.current === request) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (loadRequest.current === request) setLoading(false);
    }
  }, [t]);
  useEffect(() => {
    void load();
    return () => {
      ++loadRequest.current;
    };
  }, [load]);

  useEffect(() => {
    const previous = document.activeElement;
    picker.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  async function prepare() {
    if (!selected || preparing) return;
    setPreparing(true);
    setError("");
    try {
      await onPrepare(selected);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPreparing(false);
    }
  }

  return createPortal(
    <div className="settings-modal-backdrop cs-selfhost-backdrop">
      <button
        className="cs-selfhost-scrim"
        type="button"
        tabIndex={-1}
        aria-label={t("common.close")}
        disabled={preparing}
        onClick={onClose}
      />
      <div
        ref={picker}
        className="settings-modal cs-selfhost-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cs-selfhost-picker-title"
        aria-describedby="cs-selfhost-picker-hint"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.target instanceof Element && event.target.closest(".ssh-bookmarks-dialog")) return;
          if (event.key === "Escape" && !preparing) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const controls = picker.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
            );
            const first = controls?.[0];
            const last = controls?.[controls.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === picker.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === picker.current)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="settings-modal-header">
          <h2 id="cs-selfhost-picker-title" className="settings-modal-title">
            {t("settings.center.selfHost.pickTitle")}
          </h2>
          <button
            type="button"
            className="mcp-icon-button"
            onClick={onClose}
            disabled={preparing}
            aria-label={t("common.close")}
          >
            <X size={18} aria-hidden />
          </button>
        </header>
        <div className="settings-modal-body cs-selfhost-picker-body">
          {loading ? (
            <p className="cs-selfhost-loading" role="status">
              <Loader2 size={16} className="spin" aria-hidden />
              {t("common.loading")}
            </p>
          ) : (
            <SshBookmarksPanel
              bookmarks={bookmarks}
              busy={preparing}
              onBookmarksChange={(next) => {
                setBookmarks(next);
                onBookmarksChange(next);
              }}
              selection={{
                selectedId,
                onSelect: (bookmark) => setSelectedId(bookmark.id),
                description: t("settings.center.selfHost.pickDescription"),
              }}
            />
          )}
          {error ? (
            <div className="cs-selfhost-error" role="alert">
              <p>{error}</p>
              {!bookmarks.length && !preparing ? (
                <button className="cs-text-action" type="button" onClick={() => void load()}>
                  {t("settings.center.selfHost.retry")}
                </button>
              ) : null}
            </div>
          ) : null}
          <p id="cs-selfhost-picker-hint" className="cs-selfhost-picker-hint">
            <Bot size={16} aria-hidden />
            <span>{t("settings.center.selfHost.draftHint")}</span>
          </p>
        </div>
        <footer className="settings-modal-footer">
          <button className="settings-modal-cancel" type="button" disabled={preparing} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            className="cs-btn cs-selfhost-primary"
            type="button"
            disabled={!selected || preparing || loading}
            onClick={() => void prepare()}
          >
            {preparing ? <Loader2 size={15} className="spin" aria-hidden /> : null}
            {t(preparing ? "settings.center.selfHost.preparing" : "settings.center.selfHost.continue")}
            {!preparing ? <ArrowRight size={15} aria-hidden /> : null}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

export function SupabaseSelfHostDeploymentPanel({
  disabled,
  onPrepare,
  onBookmarksChange,
}: {
  disabled?: boolean | undefined;
  onPrepare: (bookmark: SshBookmarkView) => Promise<void>;
  onBookmarksChange: (bookmarks: SshBookmarkView[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <section className="cs-selfhost cs-card" aria-labelledby="cs-selfhost-title">
      <div className="cs-selfhost-content">
        <span className="cs-selfhost-icon">
          <Server size={21} strokeWidth={1.6} aria-hidden />
        </span>
        <div className="cs-selfhost-heading">
          <h2 id="cs-selfhost-title">{t("settings.center.selfHost.title")}</h2>
          <p>{t("settings.center.selfHost.description")}</p>
        </div>
        <button
          className="cs-btn cs-selfhost-open"
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {t("settings.center.selfHost.open")}
          <ArrowRight size={14} aria-hidden />
        </button>
      </div>
      <p className="cs-selfhost-flow">
        <Bot size={14} aria-hidden />
        {t("settings.center.selfHost.flow")}
      </p>
      {open ? (
        <SelfHostBookmarkPicker
          onClose={() => setOpen(false)}
          onPrepare={onPrepare}
          onBookmarksChange={onBookmarksChange}
        />
      ) : null}
    </section>
  );
}
