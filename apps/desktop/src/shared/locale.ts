export const APP_LOCALE_PREFERENCES = ["system", "zh-CN", "en-US"] as const;

export type AppLocalePreference = (typeof APP_LOCALE_PREFERENCES)[number];
export type AppLocale = Exclude<AppLocalePreference, "system">;

export const DEFAULT_APP_LOCALE: AppLocale = "zh-CN";
export const APP_LOCALE_STORAGE_KEY = "eco.locale";

interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function normalizeLocalePreference(value: unknown): AppLocalePreference {
  return value === "zh-CN" || value === "en-US" || value === "system" ? value : "system";
}

export function resolveAppLocale(
  preference: AppLocalePreference,
  systemLanguages: readonly string[] = [],
): AppLocale {
  if (preference !== "system") {
    return preference;
  }
  for (const language of systemLanguages) {
    if (language.trim().toLowerCase().startsWith("zh")) {
      return "zh-CN";
    }
    if (language.trim()) {
      return "en-US";
    }
  }
  return DEFAULT_APP_LOCALE;
}

export function readStoredLocalePreference(storage?: LocaleStorage): AppLocalePreference {
  if (!storage) {
    return "system";
  }
  try {
    return normalizeLocalePreference(storage.getItem(APP_LOCALE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function persistLocalePreference(preference: AppLocalePreference, storage?: LocaleStorage): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(APP_LOCALE_STORAGE_KEY, preference);
  } catch {
    // Storage can be unavailable in hardened or private renderer contexts.
  }
}

/**
 * Formats an instant with the **app** locale rather than the OS locale.
 *
 * `toLocaleString()` without a tag follows the operating system, so a Chinese UI running on an
 * English macOS mixes `上次刷新` with `Oct 16, 2026` inside one row. Pass the resolved app locale
 * instead (same reasoning as `formatInstallCount` in `renderer/SkillsSettingsPanel.tsx`).
 */
export function formatAppDateTime(
  locale: AppLocale,
  instant: number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Intl.DateTimeFormat(locale, options).format(instant);
}
