import { useTranslation } from "react-i18next";
import type { OpenAIAccountQuota } from "../shared/openai-account";
import { type AppLocale, formatAppDateTime } from "../shared/locale";
import "./CodexResetCreditExpiry.css";

/** Count-only and capped responses must not imply that every credit shares a known expiry. */
export function CodexResetCreditExpiry({ quota }: { quota: OpenAIAccountQuota }) {
  const { t, i18n } = useTranslation();
  if (quota.resetCreditsAvailable <= 0) return null;
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const groups = new Map<number | null, number>();
  for (const credit of quota.resetCredits ?? []) {
    groups.set(credit.expiresAt, (groups.get(credit.expiresAt) ?? 0) + 1);
  }
  const expiries = [...groups].sort(([a], [b]) => (a ?? Infinity) - (b ?? Infinity));
  const unknownCount = quota.resetCreditsAvailable - (quota.resetCredits?.length ?? 0);
  return <span className="codex-reset-credit-expiry">
    {expiries.map(([expiresAt, count]) => {
      if (expiresAt === null) return <span key="never">{t("codexQuota.resetNeverExpires", { count })}</span>;
      const date = new Date(expiresAt * 1_000);
      return <span key={expiresAt}>
        {t("codexQuota.resetExpiresAt", {
          count,
          time: formatAppDateTime(locale, date, {
            year: "numeric", month: "numeric", day: "numeric",
            hour: "2-digit", minute: "2-digit", timeZoneName: "short",
          }),
        })}
      </span>;
    })}
    {unknownCount > 0 ? <span>{t("codexQuota.resetExpiryUnknown", { count: unknownCount })}</span> : null}
  </span>;
}
