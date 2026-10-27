import { canUseOpenAIAccountCredentials } from "../shared/openai-account";
import { QuotaRefreshedAt } from "./QuotaRefreshedAt";
import { hasUnrefreshedCodexQuotaReset } from "../shared/codex-quota-refresh";
import { ArrowRight, CircleAlert, LoaderCircle, RefreshCw, Search, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OpenAIAccount, OpenAIAccountQuotaWindow } from "../shared/openai-account";
import { hasAvailableCodexQuota, loadCodexSwitchAccounts } from "./codex-account-switch";
import "./CodexAccountSwitchDialog.css";

function QuotaWindow({ window }: { window: OpenAIAccountQuotaWindow }) {
  const { t } = useTranslation();
  const hours = window.limitWindowSeconds / 3600;
  const label =
    hours >= 24 && hours % 24 === 0
      ? t("codexSwitch.days", { count: hours / 24 })
      : t("codexSwitch.hours", { count: hours });
  const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
  return (
    <span className="codex-switch-quota">
      <span className="codex-switch-quota-label">
        <span>{label}</span>
        <strong>{t("codexSwitch.remaining", { percent: remaining })}</strong>
      </span>
      <span className="codex-switch-quota-track">
        <span style={{ width: `${100 - window.usedPercent}%` }} />
      </span>
    </span>
  );
}

export function CodexAccountSwitchList({
  accounts,
  disabled,
  switchingId,
  onSelect,
  refreshingId,
  onRefresh,
  query = "",
}: {
  accounts: OpenAIAccount[];
  disabled: boolean;
  switchingId: string | undefined;
  onSelect: (accountId: string) => void;
  refreshingId: string | undefined;
  onRefresh: (accountId: string) => void;
  query?: string;
}) {
  const { t } = useTranslation();
  const search = query.trim().toLocaleLowerCase();
  const visibleAccounts = accounts.filter((account) =>
    [account.name, account.email, account.quota?.email].some((value) => value?.toLocaleLowerCase().includes(search)),
  );
  return (
    <div className="codex-switch-list">
      {visibleAccounts.map((account) => (
        <div className="codex-switch-card" key={account.id}>
          <button
            type="button"
            className="codex-switch-account"
            disabled={disabled || !hasAvailableCodexQuota(account)}
            onClick={() => onSelect(account.id)}
          >
            <span className="codex-switch-account-top">
              <span className="codex-switch-avatar">
                <UserRound size={18} strokeWidth={1.7} />
              </span>
              <span className="codex-switch-identity">
                <strong>{account.name}</strong>
                <span>{account.email || account.quota?.email}</span>
              </span>
              {account.quota?.planType ? <span className="codex-switch-plan">{account.quota.planType}</span> : null}
              {switchingId === account.id ? (
                <LoaderCircle size={16} className="mcp-spin" />
              ) : hasAvailableCodexQuota(account) ? (
                <ArrowRight size={16} className="codex-switch-arrow" />
              ) : null}
            </span>
            {!hasAvailableCodexQuota(account) ? (
              <span className="codex-switch-account-status">
                {t(account.quota ? "codexSwitch.noQuota" : "codexSwitch.unknownQuota")}
              </span>
            ) : null}
            <span className="codex-switch-quotas">
              {account.quota?.rateLimit.primaryWindow ? (
                <QuotaWindow window={account.quota.rateLimit.primaryWindow} />
              ) : null}
              {account.quota?.rateLimit.secondaryWindow ? (
                <QuotaWindow window={account.quota.rateLimit.secondaryWindow} />
              ) : null}
            </span>
            {account.quota ? <QuotaRefreshedAt fetchedAt={account.quota.fetchedAt} /> : null}
            {account.quota && hasUnrefreshedCodexQuotaReset(account.quota) ? <span>{t("settings.openaiAccounts.quotaResetDue")}</span> : null}
            {account.quotaRefresh?.error ? <span role="alert">{t("settings.openaiAccounts.quotaError", { message: account.quotaRefresh.error })}</span> : null}
          </button>
          <button
            type="button"
            className="mcp-icon-button codex-switch-card-refresh"
            aria-label={t("codexSwitch.refreshAccount", { name: account.name })}
            title={t("codexSwitch.refreshAccount", { name: account.name })}
            disabled={disabled}
            onClick={() => onRefresh(account.id)}
          >
            <RefreshCw size={14} className={refreshingId === account.id || refreshingId === "all" ? "mcp-spin" : undefined} />
          </button>
        </div>
      ))}
      {visibleAccounts.length === 0 ? (
        <div className="codex-switch-empty">
          <UserRound size={26} strokeWidth={1.5} />
          <strong>{t(search ? "codexSwitch.noResults" : "codexSwitch.empty")}</strong>
          <p>{t(search ? "codexSwitch.noResultsHint" : "codexSwitch.emptyHint")}</p>
        </div>
      ) : null}
    </div>
  );
}

export function CodexAccountSwitchDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<OpenAIAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [failedCount, setFailedCount] = useState(0);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [switchingId, setSwitchingId] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();
  const [refreshingId, setRefreshingId] = useState<string>();
  const refreshingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const switchingRef = useRef(false);

  const refresh = useCallback(async (queryQuota = false, accountId?: string) => {
    if (refreshingRef.current || switchingRef.current) return;
    refreshingRef.current = true;
    const version = ++requestVersion.current;
    if (queryQuota) setRefreshingId(accountId ?? "all");
    else setLoading(true);
    setError("");
    try {
      if (!window.eco) throw new Error("Desktop bridge is unavailable.");
      if (accountId) {
        const quota = await window.eco.openAIAccountsQueryQuota(accountId);
        if (version !== requestVersion.current) return;
        const latest = await window.eco.openAIAccountsList();
        if (version !== requestVersion.current) return;
        setAccounts((previous) => previous.flatMap((account) => {
          if (account.id !== accountId) return [account];
          const updated = latest.find((entry) => entry.id === accountId);
          return updated ? [{ ...updated, quota }] : [];
        }));
        return;
      }
      const result = await loadCodexSwitchAccounts(window.eco, queryQuota);
      if (version !== requestVersion.current) return;
      setAccounts(result.accounts);
      setFailedCount(result.failedCount);
    } catch (error) {
      if (version !== requestVersion.current) return;
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === requestVersion.current) {
        refreshingRef.current = false;
        setLoading(false);
        setRefreshingId(undefined);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      requestVersion.current++;
      refreshingRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!switchingRef.current) onClose();
      }
      if (event.key === "Tab") {
        const items = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? [],
        );
        if (items.length === 0) {
          event.preventDefault();
          dialogRef.current?.focus();
          return;
        }
        const first = items[0];
        const last = items.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last || document.activeElement === dialogRef.current)
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (!pendingId || !window.eco) return;
    let disposed = false;
    const eco = window.eco;
    const check = async () => {
      try {
        const active = await eco.openAIAccountsGetActive();
        if (disposed) return;
        if (active.syncStatus.state !== "ok") {
          setError(active.syncStatus.message || t("codexSwitch.failed"));
        } else if (active.activeAccountId === pendingId && active.pendingAccountId === undefined) onClose();
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : String(error));
      }
    };
    const unsubscribe = eco.onOpenAIAccountsChanged(() => {
      void check();
    });
    void check();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [pendingId, onClose, t]);

  async function selectAccount(accountId: string) {
    if (switchingRef.current || refreshingRef.current || pendingId) return;
    switchingRef.current = true;
    setSwitchingId(accountId);
    setError("");
    try {
      if (!window.eco) throw new Error("Desktop bridge is unavailable.");
      // Recheck the selected account before committing the switch.
      const quota = await window.eco.openAIAccountsQueryQuota(accountId, "switch");
      const list = await window.eco.openAIAccountsList();
      const account = list.find((candidate) => candidate.id === accountId);
      setAccounts((previous) => previous.flatMap((candidate) => {
        if (candidate.id !== accountId) return [candidate];
        return account && canUseOpenAIAccountCredentials(account) ? [{ ...account, quota }] : [];
      }));
      if (!account || !hasAvailableCodexQuota({ ...account, quota })) {
        throw new Error(t("codexSwitch.unavailable"));
      }
      const result = await window.eco.openAIAccountsSetActive(accountId);
      if (!result.success) throw new Error(t("codexSwitch.failed"));
      if (result.pending) setPendingId(accountId);
      else onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      switchingRef.current = false;
      setSwitchingId(undefined);
    }
  }

  return (
    <div className="settings-modal-backdrop codex-switch-backdrop">
      <button
        type="button"
        className="settings-modal-backdrop-close"
        aria-label={t("common.close")}
        disabled={Boolean(switchingId)}
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        className="settings-modal codex-switch-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-switch-title"
        aria-describedby="codex-switch-description"
        tabIndex={-1}
      >
        <header className="settings-modal-header">
          <div className="codex-switch-heading">
            <img src="./provider-icons/openai.svg" alt="" />
            <h2 id="codex-switch-title" className="settings-modal-title">
              {t("codexSwitch.title")}
            </h2>
          </div>
          <button
            type="button"
            className="mcp-icon-button"
            aria-label={t("common.close")}
            onClick={onClose}
            disabled={Boolean(switchingId)}
          >
            <X size={18} />
          </button>
        </header>
        <p id="codex-switch-description" className="codex-switch-description">
          {t("codexSwitch.description")}
        </p>
        <div className="codex-switch-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("codexSwitch.search")}
            placeholder={t("codexSwitch.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="settings-modal-body codex-switch-body" aria-busy={loading}>
          {error ? (
            <div className="codex-switch-notice is-error" role="alert">
              <CircleAlert size={15} />
              <span>{error}</span>
            </div>
          ) : null}
          {failedCount > 0 && !loading ? (
            <p className="codex-switch-warning" role="status">
              {t("codexSwitch.queryFailed", { count: failedCount })}
            </p>
          ) : null}
          {pendingId ? (
            <div className="codex-switch-notice" role="status">
              <LoaderCircle size={16} className="mcp-spin" />
              <span>{t("codexSwitch.pending")}</span>
            </div>
          ) : null}
          {loading ? (
            <div className="codex-switch-loading" role="status">
              <LoaderCircle size={20} className="mcp-spin" />
              {t("codexSwitch.loading")}
            </div>
          ) : (
            <CodexAccountSwitchList
              accounts={accounts}
              query={query}
              disabled={Boolean(switchingId || pendingId || refreshingId)}
              switchingId={switchingId}
              refreshingId={refreshingId}
              onRefresh={(id) => void refresh(true, id)}
              onSelect={(id) => {
                void selectAccount(id);
              }}
            />
          )}
        </div>
        <footer className="settings-modal-footer codex-switch-footer">
          <span>
            <i />
            {t("codexSwitch.fresh")}
          </span>
          <button
            type="button"
            className="mcp-icon-button codex-switch-refresh"
            aria-label={t("codexSwitch.refreshAll")}
            title={t("codexSwitch.refreshAll")}
            onClick={() => {
              void refresh(true);
            }}
            disabled={loading || Boolean(switchingId || pendingId || refreshingId)}
          >
            <RefreshCw size={15} className={refreshingId === "all" ? "mcp-spin" : undefined} />
          </button>
        </footer>
      </div>
    </div>
  );
}
