import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Eye, EyeOff, KeyRound, LogIn, Mail, Pin, PinOff, ShieldCheck, ArrowUpRight, Inbox, Check, Timer } from "lucide-react";
import type { OpenAIAccountAssistantAction, OpenAIAccountAssistantState } from "../../shared/openai-account";

function formatLoginRemaining(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function OpenAIAccountAssistantView({ state, busy, password, notice, error, onAction, onHidePassword, onLogin }: {
  state: OpenAIAccountAssistantState;
  busy: boolean;
  password: string;
  notice: string;
  error: string;
  onAction: (action: OpenAIAccountAssistantAction) => void;
  onHidePassword: () => void;
  onLogin: () => void;
}) {
  const { t } = useTranslation();
  const fillTitle = state.canFill ? t("assistant.fillConnectedHint") : t("assistant.fillDisconnectedHint");
  const fieldLabels = {
    email: t("settings.openaiAccounts.emailField"),
    password: t("settings.openaiAccounts.passwordField"),
    code: t("assistant.field.code"),
  } as const;
  const fieldActions = (field: "email" | "password" | "code", available: boolean) => (
    <div className="assistant-field-actions">
      <button type="button" disabled={busy || !available} onClick={() => onAction({ type: "copy", field })} aria-label={t("common.copyNamed", { name: fieldLabels[field] })}>
        <Copy size={13} />{t("common.copy")}
      </button>
      <button type="button" disabled={busy || !available || !state.canFill} title={fillTitle} onClick={() => onAction({ type: "fill", field })}>
        <ArrowUpRight size={13} />{t("assistant.fill")}
      </button>
    </div>
  );
  return (
    <div className="account-assistant">
      <header className="assistant-titlebar">
        <span>{t("assistant.title")}</span>
        <button className={state.pinned ? "is-pinned" : ""} type="button" aria-label={state.pinned ? t("assistant.unpinWindow") : t("assistant.pinWindow")} disabled={busy} onClick={() => onAction({ type: "togglePin" })}>
          {state.pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
      </header>
      <main className="assistant-body">
        {state.loginRemainingSeconds !== undefined ? (
          <section className={`assistant-login-timeout ${state.loginRemainingSeconds <= 60 ? "is-expiring" : ""}`} aria-label={t("assistant.loginCountdown")}>
            <span><Timer size={14} />{t("assistant.loginCountdown")}</span>
            <strong>{formatLoginRemaining(state.loginRemainingSeconds)}</strong>
          </section>
        ) : null}
        <div className="assistant-identity">
          <div className="assistant-monogram">{(state.email || state.name).slice(0, 1).toUpperCase()}</div>
          <div><span className="assistant-eyebrow">{t("settings.models.tab.openaiAccounts")}</span><h1 title={state.name}>{state.name}</h1></div>
          <span className={`assistant-connection ${state.hasLoginWindow ? "is-connected" : ""}`} title={state.hasLoginWindow ? t("assistant.connectionConnected") : t("assistant.connectionDetached")}><i /></span>
        </div>
        <div className="assistant-credentials">
          <section className="assistant-field">
            <div className="assistant-field-label"><Mail size={13} />{t("settings.openaiAccounts.emailField")}</div>
            <div className="assistant-field-value" title={state.email}>{state.email || t("assistant.emailMissing")}</div>
            {fieldActions("email", Boolean(state.email))}
          </section>
          <section className="assistant-field">
            <div className="assistant-field-label"><KeyRound size={13} />{t("settings.openaiAccounts.passwordField")}
              <button className="assistant-reveal" type="button" disabled={busy || !state.hasPassword} aria-label={password ? t("assistant.hidePassword") : t("assistant.showPassword")} onClick={() => password ? onHidePassword() : onAction({ type: "revealPassword" })}>
                {password ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <div className={`assistant-field-value ${state.hasPassword && !password ? "is-masked" : ""}`}>{password || (state.hasPassword ? "••••••••••••" : t("assistant.passwordMissing"))}</div>
            {fieldActions("password", state.hasPassword)}
          </section>
        </div>
        <section className={`assistant-otp ${state.remainingSeconds !== undefined && state.remainingSeconds <= 5 ? "is-expiring" : ""}`}>
          <div className="assistant-otp-heading"><span><ShieldCheck size={14} />{t("assistant.twoFactorCode")}</span>
            {state.code ? <span className="assistant-countdown" style={{ "--remaining": `${((state.remainingSeconds ?? 0) / 30) * 100}%` } as CSSProperties}>{state.remainingSeconds}s</span> : null}
          </div>
          {state.code ? <div className="assistant-code" aria-label={t("assistant.currentCodeAria", { code: state.code })}><span>{state.code.slice(0, 3)}</span><span>{state.code.slice(3)}</span></div>
            : <div className="assistant-code-empty">{state.codeError || t("assistant.twoFactorEmpty")}</div>}
          <div className="assistant-otp-footer"><span>{state.code ? t("assistant.twoFactorRefresh") : t("assistant.twoFactorAddSecret")}</span>{fieldActions("code", Boolean(state.code))}</div>
        </section>
        <button className="assistant-inbox" type="button" disabled={busy || !state.hasPickupUrl} onClick={() => onAction({ type: "openPickup" })}>
          <span className="assistant-inbox-icon"><Inbox size={19} /></span>
          <span><strong>{t("assistant.openInbox")}</strong><small>{state.pickupHost || t("assistant.inboxMissing")}</small></span>
          <ArrowUpRight size={16} />
        </button>
        <div className={error ? "assistant-feedback is-error" : "assistant-feedback"} role={error ? "alert" : "status"}>
          {error || (notice ? <><Check size={12} />{notice}</> : t("assistant.footerHint"))}
        </div>
        {!state.hasLoginWindow ? <button className="assistant-login" type="button" disabled={busy} onClick={onLogin}><LogIn size={14} />{t("assistant.openLoginPage")}</button> : null}
      </main>
    </div>
  );
}
