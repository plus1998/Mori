import { History, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  AccountUsageHistory,
  AccountUsageKind,
  AccountUsagePeriod,
  AccountUsageTotals,
} from "../../shared/account-usage";
import "./account-usage-history.css";

export function AccountUsageHistoryButton({
  kind,
  accountId,
  name,
}: {
  kind: AccountUsageKind;
  accountId: string;
  name: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="mcp-icon-button"
        title={t("accountUsage.title")}
        aria-label={t("accountUsage.open", { name })}
        onClick={() => setOpen(true)}
      >
        <History size={15} />
      </button>
      {open ? (
        <AccountUsageHistoryDialog
          kind={kind}
          accountId={accountId}
          name={name}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function AccountUsageHistoryDialog({
  kind,
  accountId,
  name,
  onClose,
}: {
  kind: AccountUsageKind;
  accountId: string;
  name: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const [period, setPeriod] = useState<AccountUsagePeriod>("5h");
  const [history, setHistory] = useState<AccountUsageHistory>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(
    async (before?: number) => {
      const request = ++generation.current;
      setLoading(true);
      setError(undefined);
      try {
        if (!window.eco?.accountUsageHistory) throw new Error(t("accountUsage.noApi"));
        const next = await window.eco.accountUsageHistory({
          kind,
          accountId,
          period,
          ...(before === undefined ? {} : { before }),
        });
        if (generation.current !== request) return;
        setHistory((previous) =>
          before !== undefined && previous
            ? { ...next, buckets: [...previous.buckets, ...next.buckets] }
            : next,
        );
      } catch (error) {
        if (generation.current === request) setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (generation.current === request) setLoading(false);
      }
    },
    [kind, accountId, period, t],
  );
  useEffect(() => {
    setHistory(undefined);
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);
  const numberFormatter = new Intl.NumberFormat(locale);
  const moneyFormatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const number = (value: number) => numberFormatter.format(value);
  const money = (totals: AccountUsageTotals) =>
    totals.records > 0 && totals.unpricedRecords === totals.records
      ? t("accountUsage.unknown")
      : `${moneyFormatter.format(totals.estimatedCostUsd)}${totals.unpricedRecords ? ` · ${t("accountUsage.partial")}` : ""}`;
  const date = (at: number, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: history?.timeZone }).format(at);
  const label = (start: number, end: number) => {
    if (period === "month") return date(start, { year: "numeric", month: "long" });
    if (period === "day") return date(start, { year: "numeric", month: "short", day: "numeric" });
    const options: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      year: "numeric",
      ...(period === "5h" ? { hour: "2-digit", minute: "2-digit" } : {}),
    };
    return `${date(start, options)} – ${date(period === "5h" ? end : end - 1, options)}`;
  };
  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Native dialog Escape/onCancel provides the keyboard equivalent to backdrop dismissal.
    <dialog
      ref={dialogRef}
      className="account-usage-dialog"
      aria-labelledby="account-usage-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="account-usage-shell">
        <header>
          <div>
            <h2 id="account-usage-title">{t("accountUsage.title")}</h2>
            <p>
              {name} · {kind === "chatgpt_login" ? "ChatGPT Login" : "ChatGPT OAuth"}
            </p>
          </div>
          <button
            type="button"
            className="mcp-icon-button"
            aria-label={t("accountUsage.close")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="account-usage-body">
          {history ? (
            <>
              {history.recordingFailure ? (
                <p className="account-usage-warning" role="alert">
                  {t("accountUsage.recordingFailure", {
                    count: history.recordingFailure.count,
                    error: history.recordingFailure.lastError,
                  })}
                </p>
              ) : null}
              <div className="account-usage-totals">
                <div>
                  <span>{t("accountUsage.totalTokens")}</span>
                  <strong>{number(history.totals.totalTokens)}</strong>
                </div>
                <div>
                  <span>{t("accountUsage.cost")}</span>
                  <strong>{money(history.totals)}</strong>
                </div>
              </div>
              <p className="account-usage-hint">{t("accountUsage.costHint")}</p>
              {history.totals.unpricedRecords > 0 ? (
                <p className="account-usage-warning" role="status">
                  {t("accountUsage.unpriced", { count: history.totals.unpricedRecords })}
                </p>
              ) : null}
            </>
          ) : null}
          <div className="account-usage-toolbar">
            <fieldset className="account-usage-periods" aria-label={t("accountUsage.period")}>
              {(["5h", "day", "week", "month"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={period === value}
                  onClick={() => setPeriod(value)}
                >
                  {t(`accountUsage.${value}`)}
                </button>
              ))}
            </fieldset>
            <button
              type="button"
              className="mcp-icon-button"
              aria-label={t("accountUsage.refresh")}
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={15} className={loading ? "mcp-spin" : undefined} />
            </button>
          </div>
          {error ? (
            <div className="account-usage-warning" role="alert">
              {error}{" "}
              <button type="button" disabled={loading} onClick={() => void load()}>
                {t("accountUsage.retry")}
              </button>
            </div>
          ) : null}
          {loading && !history ? <p role="status">{t("accountUsage.loading")}</p> : null}
          {history?.buckets.length === 0 ? (
            <p className="account-usage-empty">{t("accountUsage.empty")}</p>
          ) : null}
          {history && history.buckets.length > 0 ? (
            <div className="account-usage-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t("accountUsage.period")}</th>
                    <th>{t("accountUsage.tokens")}</th>
                    <th>{t("accountUsage.estimate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.buckets.map((bucket) => (
                    <tr key={bucket.startAt}>
                      <td>
                        <details>
                          <summary>{label(bucket.startAt, bucket.endAt)}</summary>
                          <dl>
                            {(
                              [
                                ["input", bucket.inputTokens],
                                ["output", bucket.outputTokens],
                                ["cacheRead", bucket.cacheReadTokens],
                                ["cacheWrite", bucket.cacheCreationTokens],
                                ["reasoning", bucket.reasoningTokens],
                              ] as const
                            ).map(([key, value]) => (
                              <div key={key}>
                                <dt>{t(`accountUsage.${key}`)}</dt>
                                <dd>{number(value)}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      </td>
                      <td>{number(bucket.totalTokens)}</td>
                      <td>{money(bucket)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {history?.nextBefore !== undefined ? (
            <button
              type="button"
              className="account-usage-more"
              disabled={loading}
              onClick={() => void load(history.nextBefore)}
            >
              {loading ? t("accountUsage.loading") : t("accountUsage.more")}
            </button>
          ) : null}
          <footer>
            <p>{t("accountUsage.cycleHint")}</p>
            {history ? (
              <>
                <p>{t("accountUsage.calendarHint", { zone: history.timeZone })}</p>
                <p>
                  {t("accountUsage.since", {
                    time: date(history.trackingStartedAt, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })}
                </p>
              </>
            ) : null}
          </footer>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
