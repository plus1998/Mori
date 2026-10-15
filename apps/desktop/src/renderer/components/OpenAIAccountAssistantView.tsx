import type { CSSProperties } from "react";
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
  const fillTitle = state.canFill ? "填写到 Eco 登录页，不会提交" : "打开 Eco 登录页后可填入";
  const fieldActions = (field: "email" | "password" | "code", available: boolean) => (
    <div className="assistant-field-actions">
      <button type="button" disabled={busy || !available} onClick={() => onAction({ type: "copy", field })} aria-label={`复制${field === "email" ? "邮箱" : field === "password" ? "密码" : "验证码"}`}>
        <Copy size={13} />复制
      </button>
      <button type="button" disabled={busy || !available || !state.canFill} title={fillTitle} onClick={() => onAction({ type: "fill", field })}>
        <ArrowUpRight size={13} />填入
      </button>
    </div>
  );
  return (
    <div className="account-assistant">
      <header className="assistant-titlebar">
        <span>登录助手</span>
        <button className={state.pinned ? "is-pinned" : ""} type="button" aria-label={state.pinned ? "取消置顶" : "置顶窗口"} disabled={busy} onClick={() => onAction({ type: "togglePin" })}>
          {state.pinned ? <Pin size={14} /> : <PinOff size={14} />}
        </button>
      </header>
      <main className="assistant-body">
        {state.loginRemainingSeconds !== undefined ? (
          <section className={`assistant-login-timeout ${state.loginRemainingSeconds <= 60 ? "is-expiring" : ""}`} aria-label="登录超时倒计时">
            <span><Timer size={14} />登录超时倒计时</span>
            <strong>{formatLoginRemaining(state.loginRemainingSeconds)}</strong>
          </section>
        ) : null}
        <div className="assistant-identity">
          <div className="assistant-monogram">{(state.email || state.name).slice(0, 1).toUpperCase()}</div>
          <div><span className="assistant-eyebrow">CODEX ACCOUNT</span><h1 title={state.name}>{state.name}</h1></div>
          <span className={`assistant-connection ${state.hasLoginWindow ? "is-connected" : ""}`} title={state.hasLoginWindow ? "登录窗口已连接" : "可复制到任意登录页"}><i /></span>
        </div>
        <div className="assistant-credentials">
          <section className="assistant-field">
            <div className="assistant-field-label"><Mail size={13} />邮箱</div>
            <div className="assistant-field-value" title={state.email}>{state.email || "未保存邮箱"}</div>
            {fieldActions("email", Boolean(state.email))}
          </section>
          <section className="assistant-field">
            <div className="assistant-field-label"><KeyRound size={13} />密码
              <button className="assistant-reveal" type="button" disabled={busy || !state.hasPassword} aria-label={password ? "隐藏密码" : "显示密码"} onClick={() => password ? onHidePassword() : onAction({ type: "revealPassword" })}>
                {password ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
            <div className={`assistant-field-value ${state.hasPassword && !password ? "is-masked" : ""}`}>{password || (state.hasPassword ? "••••••••••••" : "未保存密码")}</div>
            {fieldActions("password", state.hasPassword)}
          </section>
        </div>
        <section className={`assistant-otp ${state.remainingSeconds !== undefined && state.remainingSeconds <= 5 ? "is-expiring" : ""}`}>
          <div className="assistant-otp-heading"><span><ShieldCheck size={14} />2FA 验证码</span>
            {state.code ? <span className="assistant-countdown" style={{ "--remaining": `${((state.remainingSeconds ?? 0) / 30) * 100}%` } as CSSProperties}>{state.remainingSeconds}s</span> : null}
          </div>
          {state.code ? <div className="assistant-code" aria-label={`当前验证码 ${state.code}`}><span>{state.code.slice(0, 3)}</span><span>{state.code.slice(3)}</span></div>
            : <div className="assistant-code-empty">{state.codeError || "保存 2FA 密钥后，验证码会自动生成"}</div>}
          <div className="assistant-otp-footer"><span>{state.code ? "每 30 秒自动更新" : "在账号资料中添加密钥"}</span>{fieldActions("code", Boolean(state.code))}</div>
        </section>
        <button className="assistant-inbox" type="button" disabled={busy || !state.hasPickupUrl} onClick={() => onAction({ type: "openPickup" })}>
          <span className="assistant-inbox-icon"><Inbox size={19} /></span>
          <span><strong>打开收件箱</strong><small>{state.pickupHost || "尚未保存取件地址"}</small></span>
          <ArrowUpRight size={16} />
        </button>
        <div className={error ? "assistant-feedback is-error" : "assistant-feedback"} role={error ? "alert" : "status"}>
          {error || (notice ? <><Check size={12} />{notice}</> : "复制后粘贴，或直接填入 Eco 登录页")}
        </div>
        {!state.hasLoginWindow ? <button className="assistant-login" type="button" disabled={busy} onClick={onLogin}><LogIn size={14} />打开登录页</button> : null}
      </main>
    </div>
  );
}
