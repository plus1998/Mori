import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CircleCheck, Copy, Globe2, Link2, Loader2, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./CodexExternalLoginDialog.css";

type LoginSession = { authUrl: string; loginId: string; expiresAt: number };

export function CodexExternalLoginDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const eco = window.eco;
  const [session, setSession] = useState<LoginSession>();
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [success, setSuccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [now, setNow] = useState(Date.now());
  const current = useRef<LoginSession | undefined>(undefined);
  const mounted = useRef(false);
  const completed = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    const unsubscribe = eco?.onCodexOauthLoginResult((result) => {
      if (result.accountId !== accountId || result.loginId !== current.current?.loginId) return;
      completed.current = true;
      setEnded(true);
      setSuccess(result.success);
      setCallbackUrl("");
      setNotice(result.success ? result.message : "");
      setError(result.success ? "" : result.message);
    });
    return () => {
      mounted.current = false;
      clearInterval(timer);
      unsubscribe?.();
      const login = current.current;
      if (login) void eco?.openAIAccountsCancelLogin(accountId, login.loginId).catch((error: unknown) => console.error("[codex-login] Failed to cancel external login", error));
    };
  }, [eco, accountId]);
  const remaining = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 1_000)) : 0;
  const active = Boolean(session && remaining > 0 && !ended);
  const generate = async () => {
    if (!eco || busy) return;
    setBusy(true); setError(""); setNotice(""); setCallbackUrl(""); setSuccess(false); setCopied(false);
    try {
      const previous = current.current;
      if (previous) await eco.openAIAccountsCancelLogin(accountId, previous.loginId);
      current.current = undefined;
      completed.current = false;
      setSubmitted(false);
      setSession(undefined);
      const result = await eco.openAIAccountsStartLogin(accountId, "external");
      if (!result.success || !result.authUrl || !result.loginId || !result.expiresAt) throw new Error(result.message);
      if (!mounted.current) {
        await eco.openAIAccountsCancelLogin(accountId, result.loginId);
        return;
      }
      const login = { authUrl: result.authUrl, loginId: result.loginId, expiresAt: result.expiresAt };
      current.current = login;
      setSession(login); setEnded(false); setNow(Date.now());
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const copy = async () => {
    if (!session) return;
    try { await navigator.clipboard.writeText(session.authUrl); setCopied(true); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const submit = async () => {
    if (!eco || !session || !active || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await eco.openAIAccountsSubmitLoginCallback(accountId, session.loginId, callbackUrl);
      // Completion comes from Codex after credentials have been saved.
      if (mounted.current && !completed.current) {
        setSubmitted(true);
        setNotice(t("settings.openaiAccounts.externalWaiting"));
      }
    } catch (error) { if (mounted.current && !completed.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const redirectUri = session ? new URL(session.authUrl).searchParams.get("redirect_uri") : "";
  return <div className="settings-modal-backdrop">
    <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} onClick={onClose} tabIndex={-1} />
    <div className="settings-modal codex-external-login" role="dialog" aria-modal="true" aria-labelledby="codex-external-login-title" aria-describedby="codex-external-login-description" onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'));
      const next = event.shiftKey && document.activeElement === controls[0] ? controls.at(-1) : !event.shiftKey && document.activeElement === controls.at(-1) ? controls[0] : undefined;
      if (next) { event.preventDefault(); next.focus(); }
    }}>
      <header className="codex-external-header">
        <div className="codex-external-mark" aria-hidden="true"><Globe2 size={20} strokeWidth={1.7} /></div>
        <div className="codex-external-heading">
          <h2 id="codex-external-login-title">{t("settings.openaiAccounts.externalTitle")}</h2>
          <p id="codex-external-login-description">{t("settings.openaiAccounts.externalInstructions")}</p>
        </div>
        <button type="button" className="codex-external-icon-button codex-external-close" aria-label={t("common.close")} onClick={onClose}><X size={17} /></button>
      </header>
      <div className="codex-external-body">
        <section className="codex-external-step" aria-labelledby="codex-external-link-title">
          <div className="codex-external-step-heading">
            <span className="codex-external-step-number" aria-hidden="true">1</span>
            <h3 id="codex-external-link-title">{t("settings.openaiAccounts.externalBrowserStep")}</h3>
            {active ? <span className="codex-external-expiry" role="status">{t("settings.openaiAccounts.externalExpires", { minutes: Math.floor(remaining / 60), seconds: String(remaining % 60).padStart(2, "0") })}</span> : null}
          </div>
          <div className="codex-external-link-row">
            <Link2 size={16} className="codex-external-link-icon" aria-hidden="true" />
            <input aria-label={t("settings.openaiAccounts.externalAuthUrl")} readOnly value={session?.authUrl ?? ""} placeholder={t("settings.openaiAccounts.externalLinkPlaceholder")} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" className="codex-external-button is-primary" disabled={busy || Boolean(session) && !active} onClick={() => void (session ? copy() : generate())}>
              {busy && !session ? <Loader2 size={14} className="mcp-spin" /> : copied ? <Check size={14} /> : session ? <Copy size={14} /> : <Link2 size={14} />}
              {t(copied ? "settings.openaiAccounts.externalCopyDone" : session ? "settings.openaiAccounts.externalCopy" : "settings.openaiAccounts.externalGenerate")}
            </button>
          </div>
          <div className="codex-external-link-meta">
            <span>{redirectUri ? <><span>{t("settings.openaiAccounts.externalRedirect")}</span><code>{redirectUri}</code></> : t("settings.openaiAccounts.externalLinkHint")}</span>
            {session ? <button type="button" className="codex-external-text-button" onClick={() => void generate()} disabled={busy}><RefreshCw size={12} />{t("settings.openaiAccounts.externalRegenerate")}</button> : null}
          </div>
        </section>
        <section className="codex-external-step codex-external-callback-step" aria-labelledby="codex-external-callback-title">
          <div className="codex-external-step-heading">
            <span className="codex-external-step-number" aria-hidden="true">2</span>
            <h3 id="codex-external-callback-title">{t("settings.openaiAccounts.externalManualStep")}</h3>
            <span className="codex-external-optional">{t("settings.openaiAccounts.externalOtherDevice")}</span>
          </div>
          <p className="codex-external-step-hint">{t("settings.openaiAccounts.externalCallbackHint")}</p>
          <textarea className="codex-external-callback" aria-label={t("settings.openaiAccounts.externalCallback")} value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=…&state=…" rows={3} disabled={!active || busy || submitted} autoComplete="off" spellCheck={false} />
        </section>
        {session && !ended && !remaining ? <p role="status" className="codex-external-feedback is-error">{t("settings.openaiAccounts.externalExpired")}</p> : null}
        {notice ? <p role="status" className={`codex-external-feedback${success ? " is-success" : ""}`}>{success ? <CircleCheck size={16} /> : <Loader2 size={14} className="mcp-spin" />}{notice}</p> : null}
        {error ? <p role="alert" className="codex-external-feedback is-error">{error}</p> : null}
        {copied ? <span className="sr-only" role="status">{t("settings.openaiAccounts.externalCopied")}</span> : null}
      </div>
      <footer className="codex-external-footer">
        <span className={`codex-external-status${active ? " is-active" : ""}`}><span aria-hidden="true" />{t(success ? "settings.openaiAccounts.externalSignedIn" : active ? "settings.openaiAccounts.externalAwaiting" : "settings.openaiAccounts.externalLocalHint")}</span>
        <button type="button" className="codex-external-button is-primary" disabled={!success && (!active || !callbackUrl.trim() || busy || submitted)} onClick={() => success ? onClose() : void submit()}>
          {busy || submitted && !ended ? <Loader2 size={14} className="mcp-spin" /> : null}
          {t(success ? "common.done" : "settings.openaiAccounts.externalComplete")}
          {!success && !busy && !submitted ? <ArrowRight size={14} /> : null}
        </button>
      </footer>
    </div>
  </div>;
}
