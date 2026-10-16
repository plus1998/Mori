import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OpenAIAccountAssistantAction, OpenAIAccountAssistantState } from "../../shared/openai-account";
import { readStoredLocalePreference } from "../../shared/locale";
import { getResolvedRendererLocale, i18n } from "../i18n";
import { OpenAIAccountAssistantView } from "./OpenAIAccountAssistantView";

/**
 * The helper is its own window, so it never runs `applyLocalePreference()` when the user switches
 * language in the main window. Both windows share one session's localStorage, so re-resolving the
 * stored preference on every poll keeps this window in step.
 */
function syncLocale(): void {
  const storage = typeof window === "undefined" ? undefined : window.localStorage;
  const locale = getResolvedRendererLocale(readStoredLocalePreference(storage));
  if (locale === i18n.resolvedLanguage) return;
  void i18n.changeLanguage(locale).then(() => {
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  });
}

export function OpenAIAccountAssistantApp() {
  const accountId = new URLSearchParams(window.location.search).get("accountId");
  const eco = window.eco;
  const { t } = useTranslation();
  const [state, setState] = useState<OpenAIAccountAssistantState>();
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const polling = useRef(false);
  const refresh = useCallback(async () => {
    if (!eco || !accountId || polling.current) return;
    syncLocale();
    polling.current = true;
    try { setState(await eco.openAIAccountsAssistantState(accountId)); setLoadError(""); }
    catch (error) { setState(undefined); setPassword(""); setLoadError(error instanceof Error ? error.message : String(error)); }
    finally { polling.current = false; }
  }, [eco, accountId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 1_000);
    const unsubscribe = eco?.onOpenAIAccountsChanged(() => void refresh());
    const unsubscribeLogin = eco?.onCodexOauthLoginResult((result) => {
      if (result.accountId !== accountId) return;
      setNotice(result.success ? result.message : "");
      setError(result.success ? "" : result.message);
      void refresh();
    });
    return () => { clearInterval(timer); unsubscribe?.(); unsubscribeLogin?.(); };
  }, [eco, accountId, refresh]);
  useEffect(() => {
    if (!password) return;
    const hide = () => setPassword("");
    const timer = setTimeout(hide, 20_000);
    window.addEventListener("blur", hide);
    return () => { clearTimeout(timer); window.removeEventListener("blur", hide); };
  }, [password]);
  const run = async (action: OpenAIAccountAssistantAction) => {
    if (!eco || !accountId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await eco.openAIAccountsAssistantAction(accountId, action);
      if (action.type === "revealPassword") {
        if (!result.value) throw new Error(t("assistant.revealPasswordFailed"));
        setPassword(result.value);
      }
      setNotice(result.message);
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const login = async () => {
    if (!eco || !accountId) return;
    setBusy(true); setError("");
    try {
      const result = await eco.openAIAccountsStartLogin(accountId);
      if (!result.success) throw new Error(result.message);
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!eco || !accountId) return <div className="assistant-load-error">{t("assistant.missingAccount")}</div>;
  if (!state) return <div className="assistant-load-error" role={loadError ? "alert" : "status"}>{loadError || t("assistant.loadingProfile")}</div>;
  return <OpenAIAccountAssistantView state={state} busy={busy} password={password} notice={notice} error={error} onAction={(action) => void run(action)} onHidePassword={() => setPassword("")} onLogin={() => void login()} />;
}
