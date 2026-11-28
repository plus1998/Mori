import { ArrowRight, Check, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { type AppLocale, formatAppDateTime } from "../shared/locale";
import {
  canUseOpenAIAccountCredentials,
  type OpenAIAccount,
  type OpenAIAccountQuota,
} from "../shared/openai-account";
import { codexQuotaPeriod, codexQuotaResetAt } from "./codex-quota-reminder";
import { useOpenAIAccountsData } from "./useOpenAIAccountsData";
import "./codex-quota-pool.css";

const STORAGE_KEY = "eco.codex-quota-pool.v1";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPool(): { ids: string[]; error?: string } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ids: [] };
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.trim())) {
      throw new Error("Invalid Codex quota pool data.");
    }
    return { ids: [...new Set(value)] };
  } catch (error) {
    return { ids: [], error: errorMessage(error) };
  }
}

function canRefreshQuota(account: OpenAIAccount): boolean {
  return canUseOpenAIAccountCredentials(account) && account.sharedSource?.online !== false;
}

function QuotaWindows({ quota, now }: { quota: OpenAIAccountQuota; now: number }) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  return (
    <span className="codex-pool-windows">
      {[quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].map((window, index) => {
        if (!window) return null;
        const period = codexQuotaPeriod(window.limitWindowSeconds);
        const label =
          period === "month"
            ? t("settings.openaiAccounts.monthlyQuota")
            : period === "week"
              ? t("settings.openaiAccounts.weeklyQuota")
              : period === "hours"
                ? t("settings.openaiAccounts.windowHours", { count: window.limitWindowSeconds / 3_600 })
                : t("settings.openaiAccounts.quotaWindow");
        const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
        const resetAt = codexQuotaResetAt(window, quota.fetchedAt);
        const resetDate = resetAt === undefined ? undefined : new Date(resetAt);
        const due = resetAt !== undefined && quota.fetchedAt < resetAt && resetAt <= now;
        return (
          <span className="codex-pool-window" key={index}>
            <span className="codex-pool-window-heading">
              {label}
              <strong>{remaining}%</strong>
            </span>
            <span
              className="codex-pool-meter"
              data-level={remaining <= 10 ? "limited" : remaining <= 20 ? "low" : "ok"}
              role="meter"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remaining}
              aria-valuetext={t("codexSwitch.remaining", { percent: remaining })}
            >
              <span style={{ width: `${remaining}%` }} />
            </span>
            {!resetDate || !Number.isFinite(resetDate.getTime()) ? (
              <span>{t("settings.openaiAccounts.quotaResetUnknown")}</span>
            ) : (
              <time dateTime={resetDate.toISOString()}>
                {t("settings.openaiAccounts.quotaResetAtShort", {
                  time: formatAppDateTime(locale, resetDate, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
                {due ? ` · ${t("settings.openaiAccounts.quotaResetDueShort")}` : null}
              </time>
            )}
          </span>
        );
      })}
    </span>
  );
}

type QuotaRequest = { status: "loading" } | { status: "error"; message: string; failedAt: number };

function nextQuotaResetAt(account: OpenAIAccount, now: number): number | undefined {
  const quota = account.quota;
  if (!quota) return undefined;
  const resetTimes = [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow]
    .filter((window): window is NonNullable<typeof window> => window !== null)
    .map((window) => codexQuotaResetAt(window, quota.fetchedAt))
    .filter((resetAt): resetAt is number => resetAt !== undefined && resetAt > now);
  return resetTimes.length ? Math.min(...resetTimes) : undefined;
}

function quotaResetIsDue(account: OpenAIAccount, now: number): boolean {
  const quota = account.quota;
  if (!quota) return false;
  return [quota.rateLimit.primaryWindow, quota.rateLimit.secondaryWindow].some((window) => {
    if (!window) return false;
    const resetAt = codexQuotaResetAt(window, quota.fetchedAt);
    return resetAt !== undefined && resetAt <= now && quota.fetchedAt < resetAt;
  });
}

export function CodexQuotaPoolDialog({
  currentAccountId,
  switchBlocked,
  onSwitch,
  onClose,
}: {
  currentAccountId: string | undefined;
  switchBlocked: string | undefined;
  onSwitch: (accountId: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const radioName = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { accounts, error: accountsError, refresh: reloadAccounts } = useOpenAIAccountsData();
  const [pool, setPool] = useState(readPool);
  const [editing, setEditing] = useState(false);
  const [storageError, setStorageError] = useState<string>();
  const [selectedId, setSelectedId] = useState(currentAccountId);
  const [switchError, setSwitchError] = useState<string>();
  const [switching, setSwitching] = useState(false);
  const [requests, setRequests] = useState<Record<string, QuotaRequest>>({});
  const [now, setNow] = useState(Date.now);
  const inFlight = useRef(new Set<string>());

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(timer);
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const refreshQuota = useCallback(
    async (id: string, reason: "manual" | "reset") => {
      const eco = window.eco;
      if (!eco || inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setRequests((previous) => ({ ...previous, [id]: { status: "loading" } }));
      try {
        await eco.openAIAccountsQueryQuota(id, reason);
        // The main process normally broadcasts this change. Reloading here also
        // keeps the timer moving when a bridge implementation only resolves the query.
        await reloadAccounts();
        setRequests((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      } catch (error) {
        setRequests((previous) => ({
          ...previous,
          [id]: { status: "error", message: errorMessage(error), failedAt: Date.now() },
        }));
      } finally {
        inFlight.current.delete(id);
      }
    },
    [reloadAccounts],
  );

  useEffect(() => {
    if (!accounts || !pool.ids.length) return;
    let disposed = false;
    let timer: number | undefined;

    const schedule = () => {
      if (disposed) return;
      const now = Date.now();
      const watchedAccounts = accounts.filter(
        (account) => pool.ids.includes(account.id) && canRefreshQuota(account),
      );
      const dueAccounts = watchedAccounts.filter((account) => quotaResetIsDue(account, now));
      const retryAt = dueAccounts
        .map((account) => account.quotaRefresh?.retryAt)
        .filter((at): at is number => at !== undefined && at > now);
      const due = dueAccounts.filter((account) => {
        const accountRetryAt = account.quotaRefresh?.retryAt;
        return accountRetryAt === undefined || accountRetryAt <= now;
      });
      if (due.length) {
        for (const account of due) void refreshQuota(account.id, "reset");
        return;
      }
      const nextAt = [...watchedAccounts.map((account) => nextQuotaResetAt(account, now)), ...retryAt].filter(
        (at): at is number => at !== undefined,
      );
      if (!nextAt.length) return;
      timer = window.setTimeout(schedule, Math.min(2_147_483_647, Math.max(1, Math.min(...nextAt) - now)));
    };

    schedule();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [accounts, pool.ids, refreshQuota]);

  const byId = new Map(accounts?.map((account) => [account.id, account]));
  const watched = pool.ids.flatMap((id) => {
    const account = byId.get(id);
    return account ? [account] : [];
  });
  const refreshable = watched.filter(canRefreshQuota);
  const refreshing = refreshable.some((account) => requests[account.id]?.status === "loading");
  const selected = watched.find((account) => account.id === selectedId);
  const canSwitch = (account: OpenAIAccount) =>
    !switchBlocked &&
    !accountsError &&
    account.id !== currentAccountId &&
    !account.quotaRefresh?.authRequired &&
    canUseOpenAIAccountCredentials(account);

  function setWatched(id: string, enabled: boolean) {
    const ids = enabled ? [...pool.ids, id] : pool.ids.filter((entry) => entry !== id);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
      setPool({ ids });
      setStorageError(undefined);
    } catch (error) {
      setStorageError(errorMessage(error));
    }
  }

  async function switchAccount(account: OpenAIAccount) {
    if (switching || !canSwitch(account)) return;
    setSelectedId(account.id);
    setSwitchError(undefined);
    setSwitching(true);
    try {
      await onSwitch(account.id);
      onClose();
    } catch (error) {
      setSwitchError(errorMessage(error));
      setSwitching(false);
    }
  }

  const preferenceError = pool.error ?? storageError;
  return createPortal(
    <dialog
      ref={dialogRef}
      className="codex-pool-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!switching) onClose();
      }}
      onKeyDown={(event) => {
        if (
          editing ||
          switching ||
          event.target instanceof HTMLInputElement ||
          (event.key !== "ArrowDown" && event.key !== "ArrowUp")
        )
          return;
        const radio =
          event.currentTarget.querySelector<HTMLInputElement>("input[type=radio]:checked") ??
          event.currentTarget.querySelector<HTMLInputElement>("input[type=radio]");
        if (radio) {
          event.preventDefault();
          radio.focus();
        }
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !switching) onClose();
      }}
    >
      <div className="codex-pool-surface">
        <header className="codex-pool-header">
          <h2 id={titleId}>{t("codexQuotaPool.title")}</h2>
          <div className="codex-pool-actions">
            {!editing && refreshable.length > 0 ? (
              <button
                type="button"
                className="mcp-icon-button"
                disabled={refreshing}
                aria-label={t("settings.openaiAccounts.refreshQuota")}
                title={t("settings.openaiAccounts.refreshQuota")}
                onClick={() => {
                  for (const account of refreshable) void refreshQuota(account.id, "manual");
                }}
              >
                <RefreshCw size={15} className={refreshing ? "mcp-spin" : undefined} aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              className="codex-action-secondary"
              disabled={!accounts || Boolean(pool.error) || switching}
              onClick={() => {
                setSwitchError(undefined);
                setEditing(!editing);
              }}
            >
              {editing ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
              {t(editing ? "common.done" : "codexQuotaPool.manage")}
            </button>
            <button
              type="button"
              className="mcp-icon-button"
              disabled={switching}
              aria-label={t("common.close")}
              title={t("common.close")}
              onClick={onClose}
            >
              <X size={16} aria-hidden />
            </button>
          </div>
        </header>
        <div className="codex-pool-body">
          {preferenceError ? (
            <p className="codex-pool-error" role="alert">
              {t("codexQuotaPool.storageError", { message: preferenceError })}
            </p>
          ) : null}
          {accountsError ? (
            <div className="codex-pool-load-error">
              <p className="codex-pool-error" role="alert">
                {t("codexQuotaPool.loadFailed", { message: accountsError })}
              </p>
              <button className="codex-action-secondary" type="button" onClick={() => void reloadAccounts()}>
                {t("common.retry")}
              </button>
            </div>
          ) : null}
          {!accounts && !accountsError ? <p role="status">{t("codexSwitch.loading")}</p> : null}
          {accounts &&
            (editing ? (
              <div className="codex-pool-choices">
                {accounts.map((account) => (
                  <label className="codex-pool-choice" key={account.id}>
                    <input
                      type="checkbox"
                      checked={pool.ids.includes(account.id)}
                      onChange={(event) => setWatched(account.id, event.target.checked)}
                    />
                    <span className="codex-pool-identity">
                      <strong>{account.name}</strong>
                      {account.email && account.email !== account.name ? <span>{account.email}</span> : null}
                    </span>
                  </label>
                ))}
                {pool.ids
                  .filter((id) => !byId.has(id))
                  .map((id) => (
                    <label className="codex-pool-choice" key={id} title={id}>
                      <input type="checkbox" checked onChange={() => setWatched(id, false)} />
                      {t("codexQuotaPool.unavailableAccount")}
                    </label>
                  ))}
                {accounts.length === 0 && pool.ids.length === 0 ? (
                  <p>{t("codexQuotaPool.noAccounts")}</p>
                ) : null}
              </div>
            ) : watched.length ? (
              <div className="codex-pool-rows" role="radiogroup" aria-label={t("codexQuotaPool.title")}>
                {watched.map((account) => {
                  const request = requests[account.id];
                  const loading = request?.status === "loading";
                  const quota = account.quota;
                  const quotaError =
                    account.quotaRefresh?.error ??
                    (request?.status === "error" && (!quota || quota.fetchedAt < request.failedAt)
                      ? request.message
                      : undefined);
                  const accountStatus =
                    account.sharedSource?.online === false
                      ? t("codexShare.offline")
                      : account.quotaRefresh?.authRequired || !canUseOpenAIAccountCredentials(account)
                        ? t(
                            account.authState === "missing"
                              ? "settings.openaiAccounts.codexNotLoggedIn"
                              : "settings.openaiAccounts.reloginCodex",
                          )
                        : undefined;
                  const nameId = `${radioName}-${account.id}`;
                  return (
                    <label className="codex-pool-row" key={account.id}>
                      <input
                        type="radio"
                        name={radioName}
                        checked={account.id === selectedId}
                        disabled={switching}
                        aria-labelledby={nameId}
                        onChange={() => {
                          setSelectedId(account.id);
                          setSwitchError(undefined);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                          event.preventDefault();
                          void switchAccount(account);
                        }}
                      />
                      <span className="codex-pool-account">
                        <span className="codex-pool-identity">
                          <strong id={nameId}>{account.name}</strong>
                          {account.email && account.email !== account.name ? (
                            <span>{account.email}</span>
                          ) : null}
                        </span>
                        {account.id === currentAccountId ? (
                          <span className="codex-pool-current">{t("codexQuotaPool.current")}</span>
                        ) : null}
                      </span>
                      {quota && (quota.rateLimit.primaryWindow || quota.rateLimit.secondaryWindow) ? (
                        <QuotaWindows quota={quota} now={now} />
                      ) : (
                        <span className="codex-pool-note">
                          {t(
                            loading
                              ? "settings.openaiAccounts.quotaLoading"
                              : quota
                                ? "codexQuotaPool.noWindows"
                                : "settings.openaiAccounts.quotaIdle",
                          )}
                        </span>
                      )}
                      {accountStatus ? <span className="codex-pool-note">{accountStatus}</span> : null}
                      {quotaError ? (
                        <span className="codex-pool-error" title={quotaError}>
                          {t("settings.openaiAccounts.quotaError", { message: quotaError })}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            ) : (
              <p>{t("codexQuotaPool.empty")}</p>
            ))}
        </div>
        {!editing && watched.length > 0 ? (
          <footer className="codex-pool-footer">
            {switchError ? (
              <p className="codex-pool-error" role="alert">
                {switchError}
              </p>
            ) : null}
            {switchBlocked ? (
              <p>{switchBlocked}</p>
            ) : (
              <button
                type="button"
                className="settings-primary-button"
                disabled={switching || !selected || !canSwitch(selected)}
                onClick={() => {
                  if (selected) void switchAccount(selected);
                }}
              >
                {switching ? (
                  <LoaderCircle size={14} className="mcp-spin" aria-hidden />
                ) : (
                  <ArrowRight size={14} aria-hidden />
                )}
                {t("codexQuotaPool.useAccount")}
              </button>
            )}
          </footer>
        ) : null}
      </div>
    </dialog>,
    document.body,
  );
}
