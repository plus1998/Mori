import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AccountUsageTotals, UsageOverview, UsageOverviewQuery } from "../shared/account-usage";
import "./usage-settings.css";

const PERIODS = ["5h", "day", "week", "month", "all"] as const;

export function UsageSettingsPanel() {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState<UsageOverviewQuery>({ period: "month" });
  const [data, setData] = useState<UsageOverview | null>(null);
  const [dimensions, setDimensions] = useState<UsageOverview["dimensions"]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    setData(null);
    try {
      if (!window.eco?.usageOverview) throw new Error(t("usageOverview.noApi"));
      const result = await window.eco.usageOverview(query);
      if (request !== generation.current) return;
      setData(result);
      setDimensions(result.dimensions);
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, [query, t]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);

  const numbers = new Intl.NumberFormat(i18n.language);
  const money = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const date = new Intl.DateTimeFormat(i18n.language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(query.period === "5h" ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
  });
  const cost = (totals: AccountUsageTotals, showPartial = true) =>
    totals.records > 0 && totals.unpricedRecords === totals.records
      ? t("accountUsage.unknown")
      : `${money.format(totals.estimatedCostUsd)}${showPartial && totals.unpricedRecords > 0 ? ` · ${t("accountUsage.partial")}` : ""}`;
  const providers = [...new Map(dimensions.map((d) => [d.providerKey, d.providerName])).entries()];
  const models = [
    ...new Set(
      dimensions
        .filter((d) => !query.providerKey || d.providerKey === query.providerKey)
        .map((d) => d.modelId),
    ),
  ];
  const move = (direction: -1 | 1) => {
    if (data?.startAt == null || data.endAt == null) return;
    const at = direction === -1 ? Math.max(0, data.startAt - 1) : data.endAt;
    setQuery((q) => ({ ...q, at }));
  };

  return (
    <section className="usage-settings" aria-labelledby="usage-heading" aria-busy={busy}>
      <header className="usage-heading">
        <div>
          <h2 id="usage-heading">{t("usageOverview.title")}</h2>
          <p>{t("usageOverview.description")}</p>
        </div>
        <button
          type="button"
          className="usage-icon-button"
          disabled={busy}
          onClick={() => void load()}
          aria-label={t("accountUsage.refresh")}
          title={t("accountUsage.refresh")}
        >
          <RefreshCw size={16} />
        </button>
      </header>
      <div className="usage-filters">
        <label>
          {t("usageOverview.provider")}
          <select
            value={query.providerKey ?? ""}
            onChange={(e) =>
              setQuery((q) => ({ ...q, providerKey: e.target.value || undefined, modelId: undefined }))
            }
          >
            <option value="">{t("usageOverview.allProviders")}</option>
            {providers.map(([key, name]) => (
              <option key={key} value={key}>
                {name}
                {providers.some(([other, label]) => other !== key && label === name) ? ` · ${key}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("usageOverview.model")}
          <select
            value={query.modelId ?? ""}
            onChange={(e) => setQuery((q) => ({ ...q, modelId: e.target.value || undefined }))}
          >
            <option value="">{t("usageOverview.allModels")}</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="usage-periods" aria-label={t("accountUsage.period")}>
        {PERIODS.map((period) => (
          <button
            type="button"
            key={period}
            aria-pressed={query.period === period}
            onClick={() => setQuery((q) => ({ ...q, period, at: undefined }))}
          >
            {t(period === "all" ? "usageOverview.all" : `accountUsage.${period}`)}
          </button>
        ))}
      </fieldset>
      <div className="usage-window">
        <span>
          {data &&
            (data.startAt == null || data.endAt == null
              ? t("usageOverview.all")
              : `${date.format(data.startAt)} — ${date.format(query.period === "5h" ? data.endAt : data.endAt - 1)}`)}
        </span>
        {query.period !== "all" && (
          <div>
            <button
              type="button"
              className="usage-icon-button"
              disabled={!data || data.startAt == null || data.startAt <= data.trackingStartedAt}
              onClick={() => move(-1)}
              aria-label={t("usageOverview.previous")}
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              className="usage-current"
              disabled={busy || query.at === undefined}
              onClick={() => setQuery((q) => ({ ...q, at: undefined }))}
            >
              {t("usageOverview.current")}
            </button>
            <button
              type="button"
              className="usage-icon-button"
              disabled={!data || data.endAt == null || data.endAt > Date.now()}
              onClick={() => move(1)}
              aria-label={t("usageOverview.next")}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="usage-error" role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load()}>
            {t("accountUsage.retry")}
          </button>
        </p>
      )}
      {busy && (
        <p className="usage-status" role="status">
          {t("accountUsage.loading")}
        </p>
      )}
      {data && (
        <>
          <dl className="usage-totals">
            <div>
              <dt>{t("usageOverview.cost")}</dt>
              <dd>{cost(data.totals, false)}</dd>
            </div>
            <div>
              <dt>{t("usageOverview.tokens")}</dt>
              <dd>{numbers.format(data.totals.totalTokens)}</dd>
            </div>
            <div>
              <dt>{t("usageOverview.records")}</dt>
              <dd>{numbers.format(data.totals.records)}</dd>
            </div>
          </dl>
          {data.totals.unpricedRecords > 0 && (
            <p className="usage-notice">
              {t("accountUsage.unpriced", { count: data.totals.unpricedRecords })}
            </p>
          )}
          {data.recordingFailures > 0 && (
            <p className="usage-error" role="alert">
              {t("usageOverview.failures", { count: data.recordingFailures })}
            </p>
          )}
          <div className="usage-table-scroll">
            <table className="usage-table">
              <caption>{t("usageOverview.breakdown")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("usageOverview.providerModel")}</th>
                  <th scope="col">{t("accountUsage.input")}</th>
                  <th scope="col">{t("accountUsage.output")}</th>
                  <th scope="col">{t("usageOverview.cache")}</th>
                  <th scope="col">{t("accountUsage.tokens")}</th>
                  <th scope="col">{t("accountUsage.estimate")}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={JSON.stringify([row.providerKey, row.modelId])}>
                    <th scope="row">
                      <span className="usage-model">{row.modelId}</span>
                      <span className="usage-provider" title={row.providerKey}>
                        {row.providerName}
                      </span>
                    </th>
                    <td>{numbers.format(row.inputTokens)}</td>
                    <td>{numbers.format(row.outputTokens)}</td>
                    <td>
                      {numbers.format(row.cacheReadTokens)} / {numbers.format(row.cacheCreationTokens)}
                    </td>
                    <td>{numbers.format(row.totalTokens)}</td>
                    <td>{cost(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.rows.length === 0 && <p className="usage-empty">{t("usageOverview.empty")}</p>}
          <footer className="usage-footnotes">
            <p>{t("usageOverview.hint")}</p>
            {query.period === "5h" && <p>{t("usageOverview.fiveHourHint")}</p>}
            <p>
              {t("usageOverview.since", {
                time: new Date(data.trackingStartedAt).toLocaleDateString(i18n.language),
                zone: data.timeZone,
              })}
            </p>
          </footer>
        </>
      )}
    </section>
  );
}
