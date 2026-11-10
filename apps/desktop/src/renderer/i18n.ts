import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { i18nCatalogs } from "../shared/i18n-catalogs";
import {
  type AppLocale,
  type AppLocalePreference,
  persistLocalePreference,
  readStoredLocalePreference,
  resolveAppLocale,
} from "../shared/locale";

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.filter((language): language is string => typeof language === "string");
}

export function getResolvedRendererLocale(preference: AppLocalePreference): AppLocale {
  return resolveAppLocale(preference, browserLanguages());
}

export const initialLocalePreference = readStoredLocalePreference(
  typeof window === "undefined" ? undefined : window.localStorage,
);

export const i18n: I18nInstance = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: i18nCatalogs,
  lng: getResolvedRendererLocale(initialLocalePreference),
  fallbackLng: "en-US",
  supportedLngs: ["zh-CN", "en-US"],
  interpolation: { escapeValue: false },
  initImmediate: false,
  returnNull: false,
});

let translationRevision = 0;
const advanceTranslationRevision = () => {
  translationRevision += 1;
};
i18n.on("languageChanged", advanceTranslationRevision);
i18n.store.on("added", advanceTranslationRevision);
i18n.store.on("removed", advanceTranslationRevision);

/** Also changes when an existing resource bundle is updated in place (including HMR). */
export function getRendererTranslationRevision(): number {
  return translationRevision;
}

export async function applyLocalePreference(preference: AppLocalePreference): Promise<AppLocale> {
  persistLocalePreference(preference, typeof window === "undefined" ? undefined : window.localStorage);
  const locale = getResolvedRendererLocale(preference);
  await i18n.changeLanguage(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  await window.eco?.setLocalePreference?.(preference);
  return locale;
}

// HMR: i18n-catalogs.ts 热替换后重新注入资源，避免新 key 找不到。
if (typeof window !== "undefined" && "hot" in import.meta) {
  const viteMeta = import.meta as { hot?: { accept: (path: string, cb: (mod: unknown) => void) => void } };
  viteMeta.hot?.accept("../shared/i18n-catalogs", (mod: unknown) => {
    const m = mod as { i18nCatalogs?: Record<string, { translation: Record<string, string> }> } | undefined;
    if (m?.i18nCatalogs) {
      for (const [locale, catalog] of Object.entries(m.i18nCatalogs)) {
        i18n.addResourceBundle(locale, "translation", catalog.translation, true);
      }
    }
  });
}
