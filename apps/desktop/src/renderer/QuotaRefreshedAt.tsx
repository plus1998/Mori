import { useTranslation } from "react-i18next";
import { type AppLocale, formatAppDateTime } from "../shared/locale";

export function QuotaRefreshedAt({ fetchedAt }: { fetchedAt: number }) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const refreshedAt = new Date(fetchedAt);
  return (
    <time
      className="codex-quota-refreshed-at"
      dateTime={refreshedAt.toISOString()}
      title={formatAppDateTime(locale, refreshedAt)}
    >
      {t("settings.openaiAccounts.lastRefreshed", {
        time: formatAppDateTime(locale, refreshedAt, {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      })}
    </time>
  );
}
