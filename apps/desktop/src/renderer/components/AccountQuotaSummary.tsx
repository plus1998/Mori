import { Loader2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { QuotaRefreshedAt } from "../QuotaRefreshedAt";

function formatQuotaResetTime(resetAt: number, t: TFunction): string {
  const seconds = Math.ceil((resetAt - Date.now()) / 1_000);
  if (seconds <= 0) return t("settings.openaiAccounts.quotaResetDue");
  if (seconds < 3600) {
    return t("settings.openaiAccounts.quotaResetsIn", { duration: `${Math.ceil(seconds / 60)}m` });
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.ceil((seconds % 3600) / 60);
    return t("settings.openaiAccounts.quotaResetsIn", { duration: m > 0 ? `${h}h ${m}m` : `${h}h` });
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.ceil((seconds % 86400) / 3600);
  return t("settings.openaiAccounts.quotaResetsIn", { duration: h > 0 ? `${d}d ${h}h` : `${d}d` });
}

export function AccountQuotaSummary({ windows, fetchedAt, loading, error, showIdle }: {
  windows: Array<{ id: string; label: string; usedPercent: number; resetAt: number | undefined }> | undefined;
  fetchedAt: number | undefined;
  loading: boolean;
  error: string | undefined;
  showIdle: boolean;
}) {
  const { t } = useTranslation();
  if (!windows && !showIdle && !loading && !error) return null;
  return <span className="codex-quota-summary codex-text-quota-summary" aria-busy={loading}>
    {loading ? <Loader2 size={13} className="mcp-spin" aria-label={t("settings.openaiAccounts.refreshingQuotaAria")} /> : null}
    {error ? <span className="codex-quota-error is-error" role="alert">{t("settings.openaiAccounts.quotaError", { message: error })}</span> : null}
    {windows ? <>
      {windows.map(({ id, label, usedPercent, resetAt }) => {
        const remaining = Math.min(100, Math.max(0, 100 - usedPercent));
        const tone = remaining <= 10 ? "is-limited" : remaining <= 20 ? "is-low" : "is-ok";
        const remainingText = t("codexSwitch.remaining", { percent: Math.round(remaining) });
        return (
          <span className="codex-quota-window" key={id}>
            <span className="codex-quota-window-heading">
              <span>{label}</span>
              <em className={tone}>{remainingText}</em>
            </span>
            <span
              className={`codex-quota-energy ${tone}`}
              role="meter"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remaining}
              aria-valuetext={remainingText}
            >
              <span style={{ width: `${remaining}%` }} />
            </span>
            {resetAt !== undefined ? <span className="codex-quota-window-reset">{formatQuotaResetTime(resetAt, t)}</span> : null}
          </span>
        );
      })}
      {fetchedAt !== undefined ? <QuotaRefreshedAt fetchedAt={fetchedAt} /> : null}
    </> : !error || showIdle || loading ? <span>{loading ? t("settings.openaiAccounts.quotaLoading") : t("settings.openaiAccounts.quotaIdle")}</span> : null}
  </span>;
}
