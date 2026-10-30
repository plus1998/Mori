import { QuotaRefreshedAt } from "./QuotaRefreshedAt";
import { hasUnrefreshedCodexQuotaReset } from "../shared/codex-quota-refresh";
import { LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../shared/ipc";
import type { OpenAIAccountQuotaWindow } from "../shared/openai-account";
import {
  CodexQuotaMonitor,
  type CodexQuotaReminderSnapshot,
  codexQuotaDisplayWindow,
  codexQuotaReminderKey,
  isCodexAuthConversation,
  lowCodexQuotaWindows,
} from "./codex-quota-reminder";
import { ThreadInfoFloatControl } from "./ThreadInfoPanel";
import "./CodexQuotaReminder.css";

type QuotaReminderBridge = Pick<
  NonNullable<Window["eco"]>,
  | "openAIAccountsGetActive"
  | "openAIAccountsList"
  | "openAIAccountsQueryQuota"
  | "openAIAccountsResetQuota"
  | "onOpenAIAccountsChanged"
>;

function quotaWindows(snapshot?: CodexQuotaReminderSnapshot): OpenAIAccountQuotaWindow[] {
  if (!snapshot) return [];
  return [snapshot.quota.rateLimit.primaryWindow, snapshot.quota.rateLimit.secondaryWindow].filter(
    (window): window is OpenAIAccountQuotaWindow =>
      window !== null &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 &&
      window.usedPercent <= 100,
  );
}

function quotaLevel(remaining: number): "normal" | "warning" | "low" {
  return remaining <= 10 ? "low" : remaining <= 25 ? "warning" : "normal";
}

export function CodexQuotaMiniBars({ windows }: { windows: readonly OpenAIAccountQuotaWindow[] }) {
  return (
    <span className="codex-quota-mini-bars">
      {(windows.length ? windows : [null]).map((window, index) => {
        const remaining = window ? Math.round((100 - window.usedPercent) * 10) / 10 : undefined;
        return (
          <span
            className="codex-quota-mini-track"
            key={index}
            data-level={remaining === undefined ? "unknown" : quotaLevel(remaining)}
            data-empty={remaining === 0 || undefined}
          >
            {remaining !== undefined ? <span style={{ width: `${remaining}%` }} /> : null}
          </span>
        );
      })}
    </span>
  );
}

export function CodexQuotaReminderCard({
  snapshot,
  error,
  busy = false,
  refreshing = false,
  onSwitchAccount,
  onReset,
  onDismiss,
  onRefresh,
  variant = "reminder",
}: {
  snapshot: CodexQuotaReminderSnapshot;
  error?: string | undefined;
  busy?: boolean;
  refreshing?: boolean;
  onSwitchAccount: () => void;
  onReset: () => void;
  onDismiss?: () => void;
  onRefresh?: () => void;
  variant?: "reminder" | "billing";
}) {
  const { t, i18n } = useTranslation();
  const windows = variant === "reminder" ? lowCodexQuotaWindows(snapshot.quota) : quotaWindows(snapshot);
  // The reminder variant is driven by `lowCodexQuotaWindows`; when nothing is low it renders
  // nothing at all, which is what keeps the sidebar card hidden above 10% headroom.
  if (windows.length === 0 && variant === "reminder") return null;
  const percent = windows[0] ? Math.round((100 - windows[0].usedPercent) * 10) / 10 : 0;
  const showsAccountQuota = variant === "billing";
  const variantClass = variant === "billing" ? " codex-quota-billing" : "";
  return (
    <section
      className={`codex-quota-reminder${variantClass}`}
      aria-label={t(showsAccountQuota ? "codexQuota.accountQuota" : "codexQuota.label")}
    >
      <div className="codex-quota-reminder-heading">
        <strong>
          {t(showsAccountQuota ? "codexQuota.accountQuota" : "codexQuota.remaining", { percent })}
        </strong>
        {onDismiss ? (
          <button type="button" aria-label={t("common.close")} onClick={onDismiss}>
            <X size={14} />
          </button>
        ) : null}
      </div>
      {windows.length === 0 ? <p>{t("settings.openaiAccounts.quotaIdle")}</p> : null}
      <div className="codex-quota-reminder-account" title={snapshot.accountName}>
        {t("codexQuota.currentAccount", { name: snapshot.accountName })}
      </div>
      {windows.map((window, index) => {
        const remaining = Math.round((100 - window.usedPercent) * 10) / 10;
        const hours = window.limitWindowSeconds / 3600;
        const label =
          hours >= 24 && hours % 24 === 0
            ? t("codexSwitch.days", { count: hours / 24 })
            : t("codexSwitch.hours", { count: hours });
        const resetAt =
          window.resetAt > 0
            ? window.resetAt * 1000
            : window.resetAfterSeconds > 0
              ? snapshot.quota.fetchedAt + window.resetAfterSeconds * 1000
              : undefined;
        return (
          <div className="codex-quota-reminder-window" key={index} data-level={quotaLevel(remaining)}>
            <div className="codex-quota-reminder-window-label">
              <span>{label}</span>
              <span>{t("codexSwitch.remaining", { percent: remaining })}</span>
            </div>
            <div
              className="codex-quota-reminder-track"
              role="progressbar"
              aria-label={label}
              aria-valuenow={remaining}
              aria-valuemin={0}
              aria-valuemax={100}
              data-empty={remaining === 0 || undefined}
            >
              <span style={{ width: `${remaining}%` }} />
            </div>
            {resetAt ? (
              <p>
                {t("codexQuota.resetsAt", {
                  time: new Date(resetAt).toLocaleString(i18n.language, {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                })}
              </p>
            ) : null}
          </div>
        );
      })}
      <QuotaRefreshedAt fetchedAt={snapshot.quota.fetchedAt} />
      {hasUnrefreshedCodexQuotaReset(snapshot.quota) ? <p>{t("settings.openaiAccounts.quotaResetDue")}</p> : null}
      {error ? (
        <p className="codex-quota-reminder-error" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot.switching ? <p>{t("codexQuota.switching")}</p> : null}
      <p className="codex-quota-reset-count">
        {t(snapshot.quota.resetCreditsAvailable > 0 ? "codexQuota.resetCount" : "codexQuota.noCredit", {
          count: snapshot.quota.resetCreditsAvailable,
        })}
      </p>
      <div className="codex-quota-reminder-actions">
        {onRefresh ? (
          <button type="button" onClick={onRefresh} disabled={busy || refreshing} aria-busy={refreshing}>
            {refreshing ? <LoaderCircle size={12} className="mcp-spin" aria-hidden="true" /> : null}
            {t(refreshing ? "settings.openaiAccounts.refreshing" : "settings.openaiAccounts.refreshQuota")}
          </button>
        ) : null}
        <button type="button" onClick={onSwitchAccount} disabled={busy || refreshing}>
          {t("codexQuota.switchAccount")}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={busy || refreshing || snapshot.switching || snapshot.quota.resetCreditsAvailable <= 0}
          aria-busy={busy}
          title={t(
            snapshot.quota.resetCreditsAvailable > 0 ? "codexQuota.resetCount" : "codexQuota.noCredit",
            { count: snapshot.quota.resetCreditsAvailable },
          )}
        >
          {busy ? <LoaderCircle size={12} className="mcp-spin" /> : null}
          {t("codexQuota.useReset")}
        </button>
      </div>
    </section>
  );
}

export function CodexQuotaReminder({
  threads,
  onSwitchAccount,
  eco = window.eco,
  variant = "reminder",
  activeThreadId,
}: {
  threads: readonly ThreadSummary[];
  onSwitchAccount: () => void;
  eco?: QuotaReminderBridge | undefined;
  /** The conversation on screen; the sidebar reminder only shows while it uses the Codex account. */
  activeThreadId?: string | undefined;
  /**
   * reminder: 侧边栏提醒，仅当当前会话使用 Codex 账号且某个窗口剩余不足 10% 时出现。
   * composer: 输入框上的迷你额度入口与独立弹层。
   */
  variant?: "reminder" | "composer";
}) {
  const { t } = useTranslation();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const monitor = useRef<CodexQuotaMonitor | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<CodexQuotaReminderSnapshot>();
  const snapshotRef = useRef<CodexQuotaReminderSnapshot | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(Boolean(eco));
  const [resetting, setResetting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const resetAttempt = useRef<{ accountId: string; key: string } | undefined>(undefined);
  const resettingRef = useRef(false);
  const refreshingRef = useRef(false);
  const recentlyUsed =
    variant === "composer" || isCodexAuthConversation(threads, activeThreadId);
  const acceptSnapshot = useCallback((next: CodexQuotaReminderSnapshot | undefined) => {
    snapshotRef.current = next;
    setSnapshot(next);
    setError(undefined);
    setLoading(false);
  }, []);
  useEffect(() => {
    if (!eco) return;
    const instance = new CodexQuotaMonitor(eco, {
      // Composer visibility is gated by its selected provider, including a fresh draft.
      enabled: () => variant === "composer" ||
        isCodexAuthConversation(threadsRef.current, activeThreadIdRef.current),
      onChange: acceptSnapshot,
      onError: (message) => {
        setError(message);
        setLoading(false);
      },
    });
    monitor.current = instance;
    const unsubscribe = eco.onOpenAIAccountsChanged(() => void instance.accountsChanged());
    const onVisibility = () => { if (!document.hidden) void instance.refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      instance.dispose();
      unsubscribe();
      monitor.current = undefined;
    };
  }, [acceptSnapshot, eco, variant]);
  useEffect(() => {
    void monitor.current?.refresh();
  }, [recentlyUsed, eco, variant]);

  async function reset() {
    if (!snapshot || !eco || resettingRef.current || refreshingRef.current) return;
    const { accountId } = snapshot;
    if (!resetAttempt.current || resetAttempt.current.accountId !== accountId) {
      resetAttempt.current = { accountId, key: crypto.randomUUID() };
    }
    resettingRef.current = true;
    setResetting(true);
    setError(undefined);
    try {
      const result = await eco.openAIAccountsResetQuota(accountId, resetAttempt.current.key);
      resetAttempt.current = undefined;
      await monitor.current?.refresh();
      if (
        snapshotRef.current?.accountId === accountId &&
        (result.outcome === "noCredit" || result.outcome === "nothingToReset")
      ) {
        setError(t(result.outcome === "noCredit" ? "codexQuota.noCredit" : "codexQuota.nothingToReset"));
      }
    } catch (error) {
      // Keep the logical attempt's key after an uncertain network response.
      if (snapshotRef.current?.accountId === accountId)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      resettingRef.current = false;
      setResetting(false);
    }
  }
  async function refreshQuota() {
    if (!monitor.current || refreshingRef.current || resettingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await monitor.current.refresh(true);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }
  const reminderKey = snapshot ? codexQuotaReminderKey(snapshot) : undefined;

  if (variant === "composer") {
    if (!recentlyUsed) return null;
    const windows = quotaWindows(snapshot);
    const displayWindow = codexQuotaDisplayWindow(windows);
    const remaining = displayWindow
      ? Math.round((100 - displayWindow.usedPercent) * 10) / 10
      : undefined;
    const statusText = error
      ? t("codexQuota.refreshFailed")
      : remaining !== undefined
        ? t("codexSwitch.remaining", { percent: remaining })
        : t(loading ? "settings.openaiAccounts.quotaLoading" : "settings.openaiAccounts.quotaIdle");
    return (
      <ThreadInfoFloatControl
        label={
          <span
            className="codex-quota-mini"
            data-level={error ? "error" : remaining === undefined ? "unknown" : quotaLevel(remaining)}
            aria-hidden="true"
          >
            <CodexQuotaMiniBars windows={windows} />
            <span className="codex-quota-mini-value">
              {error ? "!" : remaining === undefined ? "—" : `${remaining}%`}
            </span>
          </span>
        }
        ariaLabel={`${t("codexQuota.accountQuota")} · ${statusText}`}
        hoverTooltip={`Codex · ${statusText}`}
        resetKey={activeThreadId ?? threads[0]?.id}
        width={320}
        minHeight={snapshot ? 280 : 140}
        openOn="click"
        align="end"
      >
        {(closePanel) => (
          <div className="codex-quota-popover">
            {snapshot ? (
              <CodexQuotaReminderCard
                snapshot={snapshot}
                error={error}
                busy={resetting}
                refreshing={refreshing}
                variant="billing"
                onSwitchAccount={() => {
                  closePanel();
                  onSwitchAccount();
                }}
                onReset={() => void reset()}
                onRefresh={() => void refreshQuota()}
                onDismiss={closePanel}
              />
            ) : (
              <section className="codex-quota-reminder codex-quota-billing" aria-busy={loading}>
                <div className="codex-quota-reminder-heading">
                  <strong>{t("codexQuota.accountQuota")}</strong>
                  <button type="button" aria-label={t("common.close")} onClick={closePanel}>
                    <X size={14} />
                  </button>
                </div>
                {error ? (
                  <div className="codex-quota-refresh-error" role="alert">
                    <span>
                      {t("codexQuota.refreshFailed")}：{error}
                    </span>
                    <button type="button" onClick={() => void refreshQuota()} disabled={refreshing} aria-busy={refreshing}>
                      {refreshing ? <LoaderCircle size={12} className="mcp-spin" aria-hidden="true" /> : null}
                      {t(refreshing ? "settings.openaiAccounts.refreshing" : "common.retry")}
                    </button>
                  </div>
                ) : (
                  <>
                    <p>{statusText}</p>
                    <button type="button" onClick={() => void refreshQuota()} disabled={loading || refreshing} aria-busy={loading || refreshing}>
                      {refreshing ? <LoaderCircle size={12} className="mcp-spin" aria-hidden="true" /> : null}
                      {t(refreshing ? "settings.openaiAccounts.refreshing" : "settings.openaiAccounts.refreshQuota")}
                    </button>
                  </>
                )}
              </section>
            )}
          </div>
        )}
      </ThreadInfoFloatControl>
    );
  }
  if (!snapshot || reminderKey === undefined || dismissed === reminderKey) {
    return error && recentlyUsed ? (
      <div className="codex-quota-refresh-error" role="status">
        <span>{t("codexQuota.refreshFailed")}</span>
        <button type="button" title={error} onClick={() => void refreshQuota()} disabled={refreshing} aria-busy={refreshing}>
          {refreshing ? <LoaderCircle size={12} className="mcp-spin" aria-hidden="true" /> : null}
          {t(refreshing ? "settings.openaiAccounts.refreshing" : "common.retry")}
        </button>
      </div>
    ) : null;
  }
  return (
    <CodexQuotaReminderCard
      snapshot={snapshot}
      error={error}
      busy={resetting}
      refreshing={refreshing}
      onSwitchAccount={onSwitchAccount}
      onReset={() => void reset()}
      onRefresh={() => void refreshQuota()}
      onDismiss={() => setDismissed(reminderKey)}
    />
  );
}
