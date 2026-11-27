import { Check, Copy, Globe2, Link2, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CursorApiKeyView, CursorExternalLoginStatus } from "../../shared/ipc";
import "./CodexExternalLoginDialog.css";

export function CursorExternalLoginDialog({ account, onClose, onConnected }: {
  account: CursorApiKeyView;
  onClose: () => void;
  onConnected: (account: CursorApiKeyView) => void;
}) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language === "zh-CN";
  const [attempt, setAttempt] = useState<number>();
  const [status, setStatus] = useState<CursorExternalLoginStatus>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (attempt === undefined || !window.eco) return;
    const api = window.eco;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attemptId: string | undefined;
    function report(failure: unknown) {
      if (!stopped) setStatus({ state: "failed", message: failure instanceof Error ? failure.message : String(failure) });
    }
    async function poll(id: string) {
      try {
        const result = await api.getCursorExternalLoginStatus(account.id, id);
        if (stopped) return;
        setStatus(result);
        if (result.state === "connected") onConnected(result.account);
        if (result.state === "pending") timer = setTimeout(() => void poll(id), 500);
      } catch (failure) {
        report(failure);
      }
    }
    void api.startCursorExternalLogin(account.id).then(id => {
      if (stopped) return api.cancelCursorExternalLogin(account.id, id);
      attemptId = id;
      return poll(id);
    }).catch(report);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (attemptId) void api.cancelCursorExternalLogin(account.id, attemptId).catch(() => {});
    };
  }, [account.id, attempt, onConnected]);

  const url = status?.state === "pending" ? status.url : undefined;
  const connected = status?.state === "connected";
  const pending = status?.state === "pending";
  const feedback = status?.state === "failed" ? status.message
    : status?.state === "cancelled" ? (zh ? "授权已取消，请重新生成链接。" : "Authorization was cancelled. Generate a new link.")
    : error;

  function generate() {
    setError("");
    setCopied(false);
    setStatus({ state: "pending" });
    setAttempt(previous => (previous ?? 0) + 1);
  }

  return (
    <div className="settings-modal-backdrop">
      <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} onClick={onClose} tabIndex={-1} />
      <div className="settings-modal codex-external-login" role="dialog" aria-modal="true" aria-labelledby="cursor-external-login-title"
        onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); onClose(); }
          if (event.key !== "Tab") return;
          const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"));
          const next = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1)
            : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined;
          if (next) { event.preventDefault(); next.focus(); }
        }}>
        <header className="codex-external-header">
          <div className="codex-external-mark" aria-hidden="true"><Globe2 size={20} /></div>
          <div className="codex-external-heading">
            <h2 id="cursor-external-login-title">{zh ? "Cursor 外部授权" : "Cursor external authorization"} · {account.name}</h2>
            <p>{zh ? "复制链接，在你选择的浏览器中完成授权。Mori 会等待 Cursor CLI 确认登录。" : "Copy the link and authorize in your browser of choice. Mori waits for Cursor CLI to confirm sign-in."}</p>
          </div>
          <button type="button" className="codex-external-icon-button codex-external-close" aria-label={t("common.close")} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="codex-external-body">
          <div className="codex-external-link-row">
            <Link2 size={16} className="codex-external-link-icon" aria-hidden="true" />
            <input aria-label={t("settings.openaiAccounts.externalAuthUrl")} readOnly value={url ?? ""}
              placeholder={t("settings.openaiAccounts.externalLinkPlaceholder")} onFocus={event => event.currentTarget.select()} />
            <button type="button" className="codex-external-button is-primary" disabled={connected || pending && !url} autoFocus
              onClick={() => {
                if (!url) { generate(); return; }
                void navigator.clipboard.writeText(url).then(() => { setCopied(true); setError(""); })
                  .catch(failure => setError(failure instanceof Error ? failure.message : String(failure)));
              }}>
              {pending && !url ? <Loader2 size={14} className="mcp-spin" /> : copied ? <Check size={14} /> : url ? <Copy size={14} /> : <Link2 size={14} />}
              {t(url ? copied ? "settings.openaiAccounts.externalCopyDone" : "settings.openaiAccounts.externalCopy" : "settings.openaiAccounts.externalGenerate")}
            </button>
          </div>
          {url && <p role="status" className="codex-external-feedback">{zh ? "等待 Cursor CLI 完成授权…" : "Waiting for Cursor CLI authorization…"}</p>}
          {connected && <p role="status" className="codex-external-feedback is-success">{t("settings.openaiAccounts.externalSignedIn")}</p>}
          {feedback && <p role="alert" className="codex-external-feedback is-error">{feedback}</p>}
        </div>
        <footer className="codex-external-footer">
          <button type="button" className="codex-external-button is-primary" onClick={onClose}>{t(connected ? "common.done" : "common.close")}</button>
        </footer>
      </div>
    </div>
  );
}
