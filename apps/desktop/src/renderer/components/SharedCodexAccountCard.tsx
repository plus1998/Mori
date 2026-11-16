import { Laptop, Loader2, RefreshCw, Share2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OpenAIAccount } from "../../shared/openai-account";
import { AccountUsageHistoryButton } from "./AccountUsageHistoryDialog";
import "./codex-account-sharing.css";

export function SharedCodexAccountCard({
  account,
  children,
}: {
  account: OpenAIAccount;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"connect" | "quota" | null>(null);
  const [error, setError] = useState("");
  const source = account.sharedSource;
  if (!source) throw new Error("共享账号缺少主设备信息。");
  const unavailable = source.state === "revoked" || source.state === "reauthorization_required";
  const valid = account.isLoggedIn;
  const key =
    source.state === "revoked"
      ? "revoked"
      : source.state === "reauthorization_required"
        ? "reauth"
        : busy === "connect" || source.state === "requesting"
          ? "requesting"
          : !source.online
            ? valid
              ? "offlineCached"
              : "offlineExpired"
            : valid
              ? "connected"
              : "ready";

  async function run(operation: "connect" | "quota") {
    if (busy) return;
    setBusy(operation);
    setError("");
    try {
      const api = window.eco;
      if (!api) throw new Error("桌面服务尚未就绪。");
      if (operation === "connect") await api.openAIAccountsSharingConnect(account.id);
      else await api.openAIAccountsQueryQuota(account.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }
  return (
    <article className="codex-account-card codex-shared-account-card">
      <div className="codex-account-card-main">
        <div className="codex-account-avatar">
          <Share2 size={16} />
        </div>
        <div className="codex-account-identity">
          <div className="codex-account-identity-title">
            <strong>{account.name}</strong>
            <span className="codex-account-plan">{t("codexShare.remote")}</span>
          </div>
          <span>
            <Laptop size={12} /> {t("codexShare.source", { name: source.ownerDeviceName })}
          </span>
        </div>
        <AccountUsageHistoryButton kind="chatgpt_login" accountId={account.id} name={account.name} />
      </div>
      <div className="codex-shared-status">
        <span className={`codex-sharing-presence ${source.online && !unavailable ? "is-online" : ""}`}>
          <i />
          {t(`codexShare.${key}`, { name: source.ownerDeviceName })}
        </span>
        <div>
          <button
            type="button"
            className="mcp-icon-button"
            aria-label={t("settings.openaiAccounts.refreshQuota")}
            disabled={Boolean(busy) || !source.online || unavailable}
            onClick={() => void run("quota")}
          >
            <RefreshCw size={14} className={busy === "quota" ? "mcp-spin" : ""} />
          </button>
          <button
            type="button"
            className="codex-action-secondary"
            disabled={Boolean(busy) || source.state === "revoked" || (!source.online && !valid)}
            onClick={() => void run("connect")}
          >
            {busy === "connect" ? <Loader2 size={13} className="mcp-spin" /> : null}
            {t(valid ? "codexShare.check" : "codexShare.connect")}
          </button>
        </div>
      </div>
      {children}
      {!unavailable ? (
        <p className="codex-shared-hint">
          {t(!source.online && !valid ? "codexShare.offlineHint" : "codexShare.useHint", {
            name: source.ownerDeviceName,
          })}
        </p>
      ) : null}
      {error || source.error ? (
        <p className="codex-sharing-error" role="alert">
          {error || source.error}
        </p>
      ) : null}
    </article>
  );
}
