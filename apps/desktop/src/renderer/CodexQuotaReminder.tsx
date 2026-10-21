import { LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadSummary } from "../shared/ipc";
import {
  CODEX_QUOTA_REFRESH_MS,
  CodexQuotaMonitor,
  type CodexQuotaReminderSnapshot,
  hasRecentCodexAuthUsage,
  lowCodexQuotaWindows,
} from "./codex-quota-reminder";
import "./CodexQuotaReminder.css";

type QuotaReminderBridge = Pick<
  NonNullable<Window["eco"]>,
  | "openAIAccountsGetActive"
  | "openAIAccountsList"
  | "openAIAccountsQueryQuota"
  | "openAIAccountsResetQuota"
  | "onOpenAIAccountsChanged"
>;

export function CodexQuotaReminderCard({
  snapshot,
  error,
  busy = false,
  onSwitchAccount,
  onReset,
  onDismiss,
}: {
  snapshot: CodexQuotaReminderSnapshot;
  error?: string | undefined;
  busy?: boolean;
  onSwitchAccount: () => void;
  onReset: () => void;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation();
  const windows = lowCodexQuotaWindows(snapshot.quota);
  if (windows.length === 0) return null;
  const percent = Math.round((100 - windows[0]!.usedPercent) * 10) / 10;
  return (
    <section className="codex-quota-reminder" aria-label={t("codexQuota.label")}>
      <div className="codex-quota-reminder-heading">
        <strong>{t("codexQuota.remaining", { percent })}</strong>
        <button type="button" aria-label={t("common.close")} onClick={onDismiss}>
          <X size={14} />
        </button>
      </div>
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
          <div className="codex-quota-reminder-window" key={index}>
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
        <button type="button" onClick={onSwitchAccount} disabled={busy}>
          {t("codexQuota.switchAccount")}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={busy || snapshot.switching || snapshot.quota.resetCreditsAvailable <= 0}
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
}: {
  threads: readonly ThreadSummary[];
  onSwitchAccount: () => void;
  eco?: QuotaReminderBridge | undefined;
}) {
  const { t } = useTranslation();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const monitor = useRef<CodexQuotaMonitor | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<CodexQuotaReminderSnapshot>();
  const snapshotRef = useRef<CodexQuotaReminderSnapshot | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [resetting, setResetting] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const resetAttempt = useRef<{ accountId: string; key: string } | undefined>(undefined);
  const resettingRef = useRef(false);
  const recentlyUsed = hasRecentCodexAuthUsage(threads);
  const acceptSnapshot = useCallback((next: CodexQuotaReminderSnapshot | undefined) => {
    snapshotRef.current = next;
    setSnapshot(next);
    setError(undefined);
  }, []);
  useEffect(() => {
    if (!eco) return;
    const instance = new CodexQuotaMonitor(eco, {
      enabled: () => hasRecentCodexAuthUsage(threadsRef.current),
      onChange: acceptSnapshot,
      onError: setError,
    });
    monitor.current = instance;
    const timer = window.setInterval(() => void instance.refresh(), CODEX_QUOTA_REFRESH_MS);
    const unsubscribe = eco.onOpenAIAccountsChanged(() => void instance.accountsChanged());
    return () => {
      instance.dispose();
      window.clearInterval(timer);
      unsubscribe();
      monitor.current = undefined;
    };
  }, [acceptSnapshot, eco]);
  useEffect(() => {
    void monitor.current?.refresh();
  }, [recentlyUsed, eco]);

  async function reset() {
    if (!snapshot || !eco || resettingRef.current) return;
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
      await monitor.current?.refresh(true);
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
  const lowWindows = snapshot ? lowCodexQuotaWindows(snapshot.quota) : [];
  const reminderKey =
    snapshot && lowWindows.length > 0
      ? `${snapshot.accountId}:${lowWindows
          .map((window) => `${window.limitWindowSeconds}:${window.resetAt}`)
          .sort()
          .join("/")}`
      : undefined;
  if (!snapshot || lowWindows.length === 0 || dismissed === reminderKey) {
    return error && recentlyUsed ? (
      <div className="codex-quota-refresh-error" role="status">
        <span>{t("codexQuota.refreshFailed")}</span>
        <button type="button" title={error} onClick={() => void monitor.current?.refresh(true)}>
          {t("common.retry")}
        </button>
      </div>
    ) : null;
  }
  return (
    <CodexQuotaReminderCard
      snapshot={snapshot}
      error={error}
      busy={resetting}
      onSwitchAccount={onSwitchAccount}
      onReset={() => void reset()}
      onDismiss={() => setDismissed(reminderKey)}
    />
  );
}
