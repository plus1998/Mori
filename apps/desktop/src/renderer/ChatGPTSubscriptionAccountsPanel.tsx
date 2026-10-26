import type { CodexModelCatalogSnapshot } from "../shared/models";
import { AccountUsageHistoryButton } from "./components/AccountUsageHistoryDialog";
import { AccountModelCatalogSection } from "./components/AccountModelCatalogSection";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink, Globe2, KeyRound, MoreHorizontal, Plus, RefreshCw, ShieldCheck, Trash2, UserRound, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { type AppLocale, formatAppDateTime } from "../shared/locale";

type Account = {
  accountId: string;
  displayName: string;
  email?: string;
  proxyUrl?: string;
  status: string;
  enabled: boolean;
  hasCredentials: boolean;
  lastErrorCode?: string;
  lastSuccessAt?: number;
};

type ModelOption = { id: string; displayName?: string };

// Exported for the i18n regression test: both build account-row copy outside JSX, which is where
// locale-blind formatting and untranslated labels hide.
export function statusLabel(account: Account, t: TFunction<"translation", undefined>): string {
  if (!account.enabled || account.status === "disabled") return t("settings.chatgptAccounts.statusDisabled");
  if (account.status === "ready") return t("settings.chatgptAccounts.statusReady");
  if (account.status === "refreshing") return t("settings.chatgptAccounts.statusRefreshing");
  if (account.status === "subscription_usage_paused") return t("settings.chatgptAccounts.statusUsagePaused");
  if (account.status === "rate_limited") return t("settings.chatgptAccounts.statusRateLimited");
  if (account.status === "temporarily_unavailable") return t("settings.chatgptAccounts.statusTemporarilyUnavailable");
  if (account.status === "not_eligible") return t("settings.chatgptAccounts.statusNotEligible");
  if (account.status === "reauthorization_required") return t("settings.chatgptAccounts.statusReauthorizationRequired");
  return t("settings.openaiAccounts.filterMissing");
}

function statusTone(account: Account): "ready" | "warning" | "muted" | "danger" {
  if (!account.enabled || account.status === "disabled") return "muted";
  if (account.status === "ready") return "ready";
  if (account.status === "rate_limited" || account.status === "subscription_usage_paused" || account.status === "not_eligible" || account.status === "reauthorization_required") return "danger";
  if (account.status === "temporarily_unavailable" || account.status === "refreshing") return "warning";
  return "muted";
}

export function formatLastUsed(timestamp: number | undefined, t: TFunction<"translation", undefined>, locale: AppLocale): string {
  if (!timestamp) return t("settings.chatgptAccounts.neverUsed");
  return t("settings.chatgptAccounts.lastSuccess", {
    time: formatAppDateTime(locale, new Date(timestamp), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
  });
}

export function ChatGPTSubscriptionAccountsPanel({
  initialAccountId,
  onInitialAccountHandled,
}: {
  initialAccountId?: string;
  onInitialAccountHandled?: () => void;
} = {}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string>();
  const [dialog, setDialog] = useState<"add" | Account>();
  const [displayName, setDisplayName] = useState("");
  const [proxyDraft, setProxyDraft] = useState("");
  const [proxyAccount, setProxyAccount] = useState<Account>();
  const [testDialog, setTestDialog] = useState<Account>();
  const [testResult, setTestResult] = useState<{ success: boolean; message: string }>();
  const [menu, setMenu] = useState<{ account: Account; top: number; left: number }>();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const handledInitialAccountIdRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!window.eco?.chatGptSubscriptionAccountsList) return;
    try {
      const next = (await window.eco.chatGptSubscriptionAccountsList()) as Account[];
      setAccounts(next);
      return next;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const applyCatalogSnapshot = useCallback((snapshot: CodexModelCatalogSnapshot) => {
    const next = snapshot.models.map((model) => ({ id: model.modelId, displayName: model.displayName }));
    setModels(next);
    setSelectedModel((current) => next.some((model) => model.id === current) ? current : next[0]?.id ?? "");
  }, []);

  const loadModels = useCallback(async () => {
    if (!window.eco?.getChatGptModelCatalog) return;
    try {
      applyCatalogSnapshot(await window.eco.getChatGptModelCatalog());
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error));
    }
  }, [applyCatalogSnapshot]);

  const refreshModels = useCallback(async (accountId?: string) => {
    if (!window.eco?.refreshChatGptModelCatalog) return;
    setModelsLoading(true);
    setModelsError(undefined);
    try {
      applyCatalogSnapshot(await window.eco.refreshChatGptModelCatalog(accountId));
    } catch (error) {
      setModelsError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelsLoading(false);
    }
  }, [applyCatalogSnapshot]);

  useEffect(() => {
    void refresh();
    void loadModels();
    return window.eco?.onChatGptSubscriptionLoginResult((result) => {
      setMessage(result.success ? undefined : result.message || t("settings.chatgptAccounts.authFailed"));
      void refresh();
    });
  }, [refresh, loadModels, t]);

  useEffect(() => {
    const targetAccountId = initialAccountId?.trim();
    if (
      !targetAccountId ||
      handledInitialAccountIdRef.current === targetAccountId ||
      accounts.length === 0
    ) {
      return;
    }
    const account = accounts.find((candidate) => candidate.accountId === targetAccountId);
    if (!account) {
      handledInitialAccountIdRef.current = targetAccountId;
      setMessage(t("settings.chatgptAccounts.accountNotFound"));
      onInitialAccountHandled?.();
      return;
    }
    handledInitialAccountIdRef.current = targetAccountId;
    setTestResult(undefined);
    setTestDialog(account);
    void loadModels();
    onInitialAccountHandled?.();
  }, [accounts, initialAccountId, onInitialAccountHandled, loadModels, t]);

  useEffect(() => {
    if (!dialog && !proxyAccount && !testDialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) { setDialog(undefined); setProxyAccount(undefined); setTestDialog(undefined); }
      } else if (event.key === "Tab") {
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]");
        const first = elements?.[0];
        const last = elements?.[elements.length - 1];
        if (event.shiftKey && document.activeElement === first && last) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last && first) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => { document.removeEventListener("keydown", handleKeyDown, true); previouslyFocused?.focus(); };
  }, [dialog, proxyAccount, testDialog, busy]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTriggerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); menuTriggerRef.current?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
      if (event.key === "Tab") close();
    };
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  async function addAccount(copyAuthorization = false) {
    if (!window.eco) return;
    setBusy(true); setMessage(undefined);
    try {
      const name = displayName.trim();
      if (!name) return;
      const account = (await window.eco.chatGptSubscriptionAccountCreate(name, proxyDraft.trim() || undefined)) as Account;
      setDialog(undefined);
      await refresh();
      if (copyAuthorization) {
        const result = await window.eco.chatGptSubscriptionAccountAuthorizationUrl(account.accountId);
        if (!result.success || !result.authorizationUrl) throw new Error(result.message);
        if (!navigator.clipboard?.writeText) throw new Error(t("settings.chatgptAccounts.clipboardUnsupported"));
        await navigator.clipboard.writeText(result.authorizationUrl);
        setMessage(t("settings.chatgptAccounts.linkCopied"));
      } else {
        const result = await window.eco.chatGptSubscriptionAccountLogin(account.accountId);
        if (!result.success) throw new Error(result.message);
        await loadModels();
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function saveProxy() {
    if (!window.eco || !proxyAccount) return;
    setBusy(true); setMessage(undefined);
    try {
      await window.eco.chatGptSubscriptionAccountSetProxy(proxyAccount.accountId, proxyDraft.trim() || undefined);
      setProxyAccount(undefined); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function login(accountId: string) {
    setBusy(true); setMessage(undefined);
    try {
      const result = await window.eco?.chatGptSubscriptionAccountLogin(accountId);
      if (result && !result.success) throw new Error(result.message);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function copyAuthorizationUrl(account: Account) {
    setBusy(true); setMessage(undefined);
    try {
      const result = await window.eco?.chatGptSubscriptionAccountAuthorizationUrl(account.accountId);
      if (!result?.success || !result.authorizationUrl) throw new Error(result?.message || t("settings.chatgptAccounts.authUrlGenerateFailed"));
      if (!navigator.clipboard?.writeText) throw new Error(t("settings.chatgptAccounts.clipboardUnsupported"));
      await navigator.clipboard.writeText(result.authorizationUrl);
      setMessage(t("settings.chatgptAccounts.linkCopied"));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function testAccount(account: Account) {
    setBusy(true); setTestResult(undefined);
    try {
      const result = await window.eco?.chatGptSubscriptionAccountTest(account.accountId, selectedModel);
      if (!result) throw new Error(t("settings.chatgptAccounts.testServiceUnavailable"));
      setTestResult(result);
      await refresh();
    } catch (error) { setTestResult({ success: false, message: error instanceof Error ? error.message : String(error) }); }
    finally { setBusy(false); }
  }

  async function setEnabled(account: Account) {
    setBusy(true); setMessage(undefined);
    try { await window.eco?.chatGptSubscriptionAccountSetEnabled(account.accountId, !account.enabled); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function resetAvailability(account: Account) {
    setBusy(true); setMessage(undefined);
    try {
      await window.eco?.chatGptSubscriptionAccountResetAvailability(account.accountId);
      await refresh();
      setMessage(t("settings.chatgptAccounts.clearedUnavailable"));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function deleteAccount(account: Account) {
    setBusy(true); setMessage(undefined);
    try { await window.eco?.chatGptSubscriptionAccountDelete(account.accountId); setDialog(undefined); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const availableCount = accounts.filter((account) => account.enabled && account.status === "ready").length;
  const openAddDialog = () => { setMessage(undefined); setDisplayName(t("settings.chatgptAccounts.defaultAccountName", { index: accounts.length + 1 })); setProxyDraft(""); setDialog("add"); };

  return (
    <section className="chatgpt-subscription-panel providers-list-section">
      <div className="chatgpt-subscription-hero">
        <div className="chatgpt-subscription-heading">
          <h2>{t("settings.models.tab.chatgptAccounts")}</h2>
        </div>
        <div className="chatgpt-header-actions">
          <AccountModelCatalogSection kind="chatgpt" onSnapshot={applyCatalogSnapshot} />
          <button type="button" className="settings-primary-button" disabled={busy} onClick={openAddDialog}><Plus size={15} /> {t("settings.chatgptAccounts.addAccount")}</button>
        </div>
        <p className="chatgpt-subscription-description"><ShieldCheck size={14} />{t("settings.chatgptAccounts.description")}</p>
      </div>

      <div className="chatgpt-list-toolbar">
        <span>
          {t("settings.openaiAccounts.accountCount", { count: accounts.length })}
          <span className="chatgpt-toolbar-divider">·</span>
          {t("settings.chatgptAccounts.availableCount", { total: availableCount })}
        </span>
        <div className="chatgpt-toolbar-links">
          <a className="chatgpt-inline-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">{t("settings.chatgptAccounts.plansAndWorkspace")} <ExternalLink size={12} /></a>
        </div>
      </div>

      {message ? <p className="chatgpt-notice" role="status">{message}</p> : null}
      {modelsError ? <p className="chatgpt-notice is-error" role="alert">{t("settings.chatgptAccounts.modelsSyncFailed", { message: modelsError })}</p> : null}
      {accounts.length === 0 ? (
        <div className="chatgpt-empty-state">
          <UserRound size={24} />
          <strong>{t("settings.chatgptAccounts.emptyTitle")}</strong>
          <p>{t("settings.chatgptAccounts.emptyHint")}</p>
          <button type="button" className="settings-primary-button" disabled={busy} onClick={openAddDialog}><Plus size={15} /> {t("settings.chatgptAccounts.addAccount")}</button>
        </div>
      ) : (
        <div className="chatgpt-account-list">
          {accounts.map((account) => {
            const tone = statusTone(account);
            return <article key={account.accountId} className="chatgpt-account-row">
              <div className="chatgpt-account-row-main">
                <div className="chatgpt-account-avatar"><img src="./provider-icons/openai.svg" alt="ChatGPT" /></div>
                <div className="chatgpt-account-identity"><strong title={account.displayName}>{account.displayName}</strong><span title={account.email}>{account.email || t("settings.chatgptAccounts.emailUnbound")}</span></div>
                <span className={`chatgpt-status-badge is-${tone}`}><i />{statusLabel(account, t)}</span>
                <div className="chatgpt-account-actions">
                  {account.hasCredentials && account.status !== "reauthorization_required" ? <button type="button" className="chatgpt-action-secondary" disabled={busy} onClick={() => { setTestResult(undefined); setTestDialog(account);  }}>{t("settings.chatgptAccounts.testConnection")}</button> : <button type="button" className="chatgpt-action-primary" disabled={busy} onClick={() => void login(account.accountId)}><KeyRound size={14} />{account.hasCredentials ? t("settings.chatgptAccounts.reauthorize") : t("settings.chatgptAccounts.startAuthorization")}</button>}
                  <AccountUsageHistoryButton kind="chatgpt_oauth" accountId={account.accountId} name={account.displayName} />
                  <button type="button" className="mcp-icon-button" aria-label={t("settings.openaiAccounts.moreActionsAria", { name: account.displayName })} aria-haspopup="menu" aria-expanded={menu?.account.accountId === account.accountId} disabled={busy} onClick={(event) => {
                    if (menu?.account.accountId === account.accountId) { setMenu(undefined); return; }
                    menuTriggerRef.current = event.currentTarget;
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ account, top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 246)), left: Math.max(8, Math.min(rect.right - 180, window.innerWidth - 188)) });
                  }}><MoreHorizontal size={16} /></button>
                </div>
              </div>
              <div className="chatgpt-account-meta">
                <button type="button" className="chatgpt-proxy-link" disabled={busy} onClick={() => { setMessage(undefined); setProxyDraft(account.proxyUrl ?? ""); setProxyAccount(account); }}><Globe2 size={13} />{account.proxyUrl ? t("settings.openaiAccounts.proxyOwn") : t("settings.chatgptAccounts.proxyGlobal")}<span>{t("settings.models.providerConfigure")}</span></button>
                <span>{formatLastUsed(account.lastSuccessAt, t, locale)}</span>
              </div>
              {account.status === "not_eligible" ? <p className="chatgpt-account-warning">{t("settings.chatgptAccounts.notEligibleWarning")}</p> : null}
              {account.status === "subscription_usage_paused" ? <p className="chatgpt-account-warning">{t("settings.chatgptAccounts.usagePausedWarning")} <a className="chatgpt-inline-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">{t("settings.chatgptAccounts.usageLink")} <ExternalLink size={12} /></a></p> : null}
            </article>;
          })}
        </div>
      )}

      {menu ? createPortal(
        <div ref={menuRef} className="account-action-menu chatgpt-action-menu" role="menu" aria-label={t("settings.openaiAccounts.accountActionsAria")} style={{ position: "fixed", top: menu.top, left: menu.left }}>
          <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void login(menu.account.accountId); }}><KeyRound size={14} />{menu.account.hasCredentials ? t("settings.chatgptAccounts.reauthorize") : t("settings.chatgptAccounts.startAuthorization")}</button>
          <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void copyAuthorizationUrl(menu.account); }}><Copy size={14} />{t("settings.chatgptAccounts.copyAuthorizationUrl")}</button>
          {menu.account.hasCredentials && !["ready", "needs_login", "disabled", "subscription_usage_paused"].includes(menu.account.status) ? <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void resetAvailability(menu.account); }}><RefreshCw size={14} />{t("settings.chatgptAccounts.recheck")}</button> : null}
          <button type="button" role="menuitem" className="account-action-item" onClick={() => { setMenu(undefined); void setEnabled(menu.account); }}>{menu.account.enabled ? t("settings.chatgptAccounts.disableAccount") : t("settings.chatgptAccounts.enableAccount")}</button>
          <button type="button" role="menuitem" className="account-action-item danger" onClick={() => { setMenu(undefined); setMessage(undefined); setDialog(menu.account); }}><Trash2 size={14} />{t("settings.chatgptAccounts.deleteAccount")}</button>
        </div>, document.body,
      ) : null}

      {testDialog ? createPortal(
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} disabled={busy} onClick={() => setTestDialog(undefined)} tabIndex={-1} />
          <form ref={dialogRef} className="settings-modal settings-modal-provider-editor chatgpt-test-modal" role="dialog" aria-modal="true" aria-labelledby="chatgpt-test-title" onSubmit={(event) => { event.preventDefault(); if (!busy && selectedModel) void testAccount(testDialog); }}>
            <header className="settings-modal-header"><h2 className="settings-modal-title" id="chatgpt-test-title">{t("settings.chatgptAccounts.testConnection")}</h2><button type="button" className="mcp-icon-button" aria-label={t("common.close")} disabled={busy} onClick={() => setTestDialog(undefined)}><X size={17} /></button></header>
            <div className="settings-modal-body openai-account-modal-body">
              <p className="chatgpt-test-description">{t("settings.chatgptAccounts.testDescription", { name: testDialog.displayName })}</p>
              <div className="chatgpt-test-model-section">
                <label className="mcp-field"><span className="mcp-field-label">{t("settings.chatgptAccounts.testModel")}</span><select className="mcp-field-input" value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)} disabled={busy || modelsLoading || !models.length} autoFocus><option value="">{modelsLoading ? t("settings.chatgptAccounts.fetchingModels") : t("settings.chatgptAccounts.chooseModel")}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}</select></label>
                <button type="button" className="chatgpt-inline-link chatgpt-test-refresh-link" disabled={busy || modelsLoading} onClick={() => void refreshModels(testDialog.accountId)}><RefreshCw size={13} />{t("settings.chatgptAccounts.refetchModels")}</button>
              </div>
              {modelsError ? <p className="chatgpt-notice is-error" role="alert">{modelsError}</p> : null}
              {testDialog.status === "not_eligible" ? <p className="chatgpt-notice">{t("settings.chatgptAccounts.notEligibleTestNotice")}</p> : null}
              {testResult ? <p className={`chatgpt-notice ${testResult.success ? "is-success" : "is-error"}`} role="status">{testResult.message}</p> : null}
            </div>
            <footer className="settings-modal-footer"><button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setTestDialog(undefined)}>{t("common.close")}</button><button type="submit" className="settings-primary-button" disabled={busy || modelsLoading || !selectedModel}>{busy ? t("settings.chatgptAccounts.testing") : t("settings.chatgptAccounts.sendHi")}</button></footer>
          </form>
        </div>, document.body,
      ) : null}

      {dialog ? createPortal(
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} disabled={busy} onClick={() => setDialog(undefined)} tabIndex={-1} />
          <form ref={dialogRef} className="settings-modal settings-modal-provider-editor" role="dialog" aria-modal="true" aria-labelledby="chatgpt-account-dialog-title" onSubmit={(event) => { event.preventDefault(); if (!busy) void (dialog === "add" ? addAccount() : deleteAccount(dialog)); }}>
            <header className="settings-modal-header"><h2 className="settings-modal-title" id="chatgpt-account-dialog-title">{dialog === "add" ? t("settings.chatgptAccounts.addDialogTitle") : t("settings.chatgptAccounts.deleteDialogTitle")}</h2><button type="button" className="mcp-icon-button" aria-label={t("common.close")} disabled={busy} onClick={() => setDialog(undefined)}><X size={17} /></button></header>
            <div className="settings-modal-body openai-account-modal-body">
              {dialog === "add" ? <><label className="mcp-field"><span className="mcp-field-label">{t("settings.chatgptAccounts.displayNameField")}</span><input className="mcp-field-input" value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={busy} required autoFocus /><span className="mcp-field-hint">{t("settings.chatgptAccounts.addDialogHint")}</span></label><label className="mcp-field"><span className="mcp-field-label">{t("settings.chatgptAccounts.proxyFieldLabel")} <em>{t("settings.chatgptAccounts.optionalSuffix")}</em></span><input className="mcp-field-input" value={proxyDraft} onChange={(event) => setProxyDraft(event.target.value)} placeholder={t("settings.chatgptAccounts.proxyPlaceholder")} disabled={busy} /><span className="mcp-field-hint">{t("settings.chatgptAccounts.proxyFormatHint")}</span></label></> : <div className="chatgpt-delete-copy"><div className="chatgpt-delete-icon"><Trash2 size={18} /></div><p>{t("settings.chatgptAccounts.deleteConfirm", { name: dialog.displayName })}</p><small>{t("settings.chatgptAccounts.deleteConfirmHint")}</small></div>}
              {message ? <p className="settings-form-error" role="alert">{message}</p> : null}
            </div>
            <footer className="settings-modal-footer"><button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setDialog(undefined)} autoFocus={dialog !== "add"}>{t("common.cancel")}</button><div className="settings-modal-footer-actions">{dialog === "add" ? <button type="button" className="settings-modal-cancel" disabled={busy || !displayName.trim()} onClick={() => void addAccount(true)}>{t("settings.chatgptAccounts.addAndCopyLink")}</button> : null}<button type="submit" className={dialog === "add" ? "settings-primary-button" : "settings-danger-button"} disabled={busy || (dialog === "add" && !displayName.trim())}>{busy ? t("settings.chatgptAccounts.processing") : dialog === "add" ? t("settings.chatgptAccounts.addAndLogin") : t("settings.chatgptAccounts.deleteAccount")}</button></div></footer>
          </form>
        </div>, document.body,
      ) : null}

      {proxyAccount ? createPortal(
        <div className="settings-modal-backdrop">
          <button type="button" className="settings-modal-backdrop-close" aria-label={t("common.close")} disabled={busy} onClick={() => setProxyAccount(undefined)} tabIndex={-1} />
          <form ref={dialogRef} className="settings-modal settings-modal-provider-editor" role="dialog" aria-modal="true" aria-labelledby="chatgpt-account-proxy-title" onSubmit={(event) => { event.preventDefault(); void saveProxy(); }}>
            <header className="settings-modal-header"><h2 className="settings-modal-title" id="chatgpt-account-proxy-title">{t("settings.chatgptAccounts.proxyFieldLabel")}</h2><button type="button" className="mcp-icon-button" aria-label={t("common.close")} disabled={busy} onClick={() => setProxyAccount(undefined)}><X size={17} /></button></header>
            <div className="settings-modal-body openai-account-modal-body"><p className="chatgpt-proxy-account-name">{proxyAccount.displayName}</p><label className="mcp-field"><span className="mcp-field-label">{t("settings.chatgptAccounts.proxyUrlField")}</span><input className="mcp-field-input" value={proxyDraft} onChange={(event) => setProxyDraft(event.target.value)} placeholder={t("settings.chatgptAccounts.proxyPlaceholder")} disabled={busy} autoFocus /><span className="mcp-field-hint">{t("settings.chatgptAccounts.proxyModalHint")}</span></label>{message ? <p className="settings-form-error" role="alert">{message}</p> : null}</div>
            <footer className="settings-modal-footer"><button type="button" className="settings-modal-cancel" disabled={busy} onClick={() => setProxyAccount(undefined)}>{t("common.cancel")}</button><div className="settings-modal-footer-actions"><button type="submit" className="settings-primary-button" disabled={busy}>{busy ? t("settings.openaiAccounts.saving") : t("settings.chatgptAccounts.saveProxy")}</button></div></footer>
          </form>
        </div>, document.body,
      ) : null}
    </section>
  );
}
