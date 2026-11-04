import { translateCatalog } from "../shared/i18n-catalogs";
import type { AppLocale } from "../shared/locale";

export function formatRelativeTime(iso: string, now = Date.now(), locale: AppLocale = "zh-CN"): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return "";
  }

  const diffMs = Math.max(0, now - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return translateCatalog(locale, "time.justNow");
  }
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (minutes < 60) {
    return formatter.format(-minutes, "minute");
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return formatter.format(-hours, "hour");
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return formatter.format(-days, "day");
  }

  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return formatter.format(-weeks, "week");
  }

  const months = Math.floor(days / 30);
  if (days < 365) {
    return formatter.format(-months, "month");
  }

  return formatter.format(-Math.floor(days / 365), "year");
}
