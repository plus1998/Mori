import { AlertCircle, ChevronRight, ExternalLink, Plus, RefreshCw, Table2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  CodexCatalogModelView,
  CodexModelCatalogSnapshot,
  CodexModelCatalogStatusView,
} from "../../shared/ipc";
import { type AppLocale, formatAppDateTime } from "../../shared/locale";

function catalogError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i,
    "",
  );
}

function formatFetchedAt(fetchedAt: number | undefined, locale: AppLocale, notFetched: string): string {
  if (!fetchedAt) {
    return notFetched;
  }
  return formatAppDateTime(locale, new Date(fetchedAt), {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatContextWindow(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens)) {
    return "";
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function formatApiRate(rate: number | undefined, unknown: string): string {
  return rate === undefined ? unknown : `$${rate}`;
}

type CatalogKind = "codex" | "chatgpt";

function getCatalogApi(kind: CatalogKind) {
  const eco = window.eco;
  if (!eco) return undefined;
  return kind === "chatgpt"
    ? {
        get: eco.getChatGptModelCatalog,
        refresh: eco.refreshChatGptModelCatalog,
        add: eco.addChatGptModelCatalogModel,
        remove: eco.removeChatGptModelCatalogModel,
      }
    : {
        get: eco.getCodexModelCatalog,
        refresh: eco.refreshCodexModelCatalog,
        add: eco.addCodexModelCatalogModel,
        remove: eco.removeCodexModelCatalogModel,
      };
}

/** Shared offline catalog and API-price management for account providers. */
export function AccountModelCatalogSection({
  kind = "codex",
  onSnapshot,
}: {
  kind?: CatalogKind;
  onSnapshot?: (snapshot: CodexModelCatalogSnapshot) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = (i18n.resolvedLanguage ?? i18n.language) as AppLocale;
  const [models, setModels] = useState<CodexCatalogModelView[]>([]);
  const [status, setStatus] = useState<CodexModelCatalogStatusView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogId = useId();
  const titleId = useId();
  const [modelIdDraft, setModelIdDraft] = useState("");
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [priceContext, setPriceContext] = useState<"short" | "long">("short");
  const [removingId, setRemovingId] = useState<string | null>(null);

  const applySnapshot = useCallback(
    (snapshot: { models: CodexCatalogModelView[]; status: CodexModelCatalogStatusView }) => {
      setModels(snapshot.models);
      setStatus(snapshot.status);
      onSnapshot?.(snapshot);
    },
    [onSnapshot],
  );

  const load = useCallback(async () => {
    const api = getCatalogApi(kind);
    if (!api?.get) {
      return;
    }
    setLoading(true);
    try {
      applySnapshot(await api.get());
      setError("");
    } catch (caught) {
      setError(catalogError(caught));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => {
      dialog.close();
      entryRef.current?.focus();
    };
  }, [open]);

  const handleRefresh = useCallback(async () => {
    const api = getCatalogApi(kind);
    if (!api?.refresh) {
      return;
    }
    setRefreshing(true);
    try {
      applySnapshot(await api.refresh());
      setError("");
    } catch (caught) {
      // Failed refreshes retain the previous model/price snapshot and its timestamp.
      try {
        applySnapshot(await api.get());
      } catch {
        // Keep the refresh failure below as the primary error.
      }
      setError(
        t("codexModels.refreshFailed", {
          message: catalogError(caught),
        }),
      );
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot, kind, t]);

  const handleAdd = useCallback(async () => {
    const api = getCatalogApi(kind);
    const modelId = modelIdDraft.trim();
    if (!api?.add || !modelId) {
      return;
    }
    try {
      const displayName = displayNameDraft.trim();
      applySnapshot(
        await api.add({
          modelId,
          ...(displayName ? { displayName } : {}),
        }),
      );
      setModelIdDraft("");
      setDisplayNameDraft("");
      setError("");
    } catch (caught) {
      setError(catalogError(caught));
    }
  }, [modelIdDraft, displayNameDraft, applySnapshot, kind]);

  const handleRemove = useCallback(
    async (modelId: string) => {
      const api = getCatalogApi(kind);
      if (!api?.remove) {
        return;
      }
      setRemovingId(modelId);
      try {
        applySnapshot(await api.remove(modelId));
        setError("");
      } catch (caught) {
        setError(catalogError(caught));
      } finally {
        setRemovingId(null);
      }
    },
    [applySnapshot, kind],
  );

  const title = t(kind === "chatgpt" ? "chatgptModels.title" : "codexModels.title");

  const thresholds = [
    ...new Set(
      models.flatMap((model) =>
        model.apiPricing?.shortContextMaxInputTokens ? [model.apiPricing.shortContextMaxInputTokens] : [],
      ),
    ),
  ];
  const commonThreshold = thresholds.length === 1 ? formatContextWindow(thresholds[0]) : undefined;
  const refreshedAt = formatFetchedAt(status?.fetchedAt, locale, t("codexModels.notFetched"));
  const pricingRefreshedAt = formatFetchedAt(status?.pricingFetchedAt, locale, t("codexModels.notFetched"));

  return (
    <>
      <button
        ref={entryRef}
        type="button"
        className="codex-action-secondary codex-catalog-entry"
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => {
          void load();
          setOpen(true);
        }}
      >
        <Table2 size={14} />
        {t("codexModels.open")}
        {status?.lastError || error ? (
          <span className="codex-catalog-warning" title={error || status?.lastError}>
            <AlertCircle size={12} aria-label={t("codexModels.fetchFailed")} />
          </span>
        ) : null}
      </button>
      {open
        ? createPortal(
            <dialog
              ref={dialogRef}
              id={dialogId}
              className="codex-catalog-dialog"
              aria-labelledby={titleId}
              onCancel={(event) => {
                event.preventDefault();
                setOpen(false);
              }}
              onClose={() => setOpen(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") event.stopPropagation();
              }}
              onClick={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <header className="codex-catalog-bar">
                <div className="codex-catalog-heading">
                  <h2 id={titleId}>
                    {title}
                    <span className="codex-catalog-count">{models.length}</span>
                  </h2>
                  <span className="codex-catalog-summary-meta">
                    {loading ? t("codexModels.loading") : t("codexModels.updatedAt", { time: refreshedAt })}
                  </span>
                </div>
                <div className="codex-catalog-actions">
                  <button
                    type="button"
                    className="codex-action-secondary"
                    onClick={() => void handleRefresh()}
                    disabled={refreshing || loading}
                  >
                    <RefreshCw size={13} className={refreshing ? "mcp-spin" : undefined} />
                    {refreshing ? t("codexModels.refreshing") : t("common.refresh")}
                  </button>
                  <button
                    type="button"
                    className="codex-catalog-close"
                    aria-label={t("common.close")}
                    onClick={() => setOpen(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
              </header>
              <div className="codex-catalog-body">
                {error || status?.lastError ? (
                  <div className="codex-account-sync-error" role="alert">
                    {error || t("codexModels.lastFetchFailed", { message: status?.lastError })}
                  </div>
                ) : null}
                <div className="codex-catalog-toolbar">
                  <fieldset className="codex-catalog-segments" aria-label={t("codexModels.priceContext")}>
                    <button
                      type="button"
                      aria-pressed={priceContext === "short"}
                      onClick={() => setPriceContext("short")}
                    >
                      {t("codexModels.shortContext")}
                    </button>
                    <button
                      type="button"
                      aria-pressed={priceContext === "long"}
                      onClick={() => setPriceContext("long")}
                    >
                      {t("codexModels.longContext")}
                    </button>
                  </fieldset>
                  <span className="codex-catalog-unit">{t("codexModels.priceUnit")}</span>
                </div>
                {models.length === 0 ? (
                  <p className="codex-catalog-empty">{t("codexModels.empty")}</p>
                ) : (
                  <section
                    className="codex-catalog-table-scroll"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need focus to scroll the price table.
                    tabIndex={0}
                    aria-label={title}
                  >
                    <table className="codex-catalog-table">
                      <caption className="sr-only">{t("codexModels.tableCaption")}</caption>
                      <colgroup>
                        <col className="codex-catalog-model-col" />
                        <col />
                        <col />
                        <col />
                      </colgroup>
                      <thead>
                        <tr>
                          <th scope="col">{t("codexModels.modelColumn")}</th>
                          <th scope="col">{t("codexModels.inputColumn")}</th>
                          <th scope="col">{t("codexModels.outputColumn")}</th>
                          <th scope="col">{t("codexModels.cacheColumn")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {models.map((model) => {
                          const pricing = model.apiPricing;
                          const rates =
                            priceContext === "long" && pricing?.shortContextMaxInputTokens
                              ? pricing.longContext
                              : pricing?.shortContext;
                          const contextLabel = pricing?.shortContextMaxInputTokens
                            ? t(
                                priceContext === "short"
                                  ? "codexModels.shortInputRange"
                                  : "codexModels.longInputRange",
                                {
                                  size: formatContextWindow(pricing.shortContextMaxInputTokens),
                                },
                              )
                            : t("codexModels.allInputRanges");
                          return (
                            <tr key={`${model.origin}:${model.modelId}`}>
                              <th scope="row">
                                <div className="codex-catalog-model-name">
                                  <strong title={model.modelId}>{model.displayName}</strong>
                                  {model.origin === "manual" ? (
                                    <span className="codex-catalog-manual-tag">
                                      {t("codexModels.tagManual")}
                                    </span>
                                  ) : null}
                                </div>
                                <div className="codex-catalog-model-details">
                                  {model.contextWindow ? (
                                    <span>
                                      {t("codexModels.contextWindow", {
                                        size: formatContextWindow(model.contextWindow),
                                      })}
                                    </span>
                                  ) : null}
                                  {model.reasoningEfforts.length > 0 ? (
                                    <span title={model.reasoningEfforts.join(" / ")}>
                                      {t("codexModels.reasoningLevels", {
                                        count: model.reasoningEfforts.length,
                                      })}
                                    </span>
                                  ) : null}
                                  {model.origin === "manual" ? (
                                    <button
                                      type="button"
                                      className="codex-catalog-remove"
                                      aria-label={t("codexModels.removeNamed", { modelId: model.modelId })}
                                      title={t("codexModels.removeNamed", { modelId: model.modelId })}
                                      onClick={() => void handleRemove(model.modelId)}
                                      disabled={removingId !== null}
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  ) : null}
                                </div>
                              </th>
                              {rates ? (
                                (["input", "output", "cacheRead"] as const).map((key) => (
                                  <td
                                    key={key}
                                    className={rates[key] === undefined ? "is-unknown" : undefined}
                                    title={contextLabel}
                                  >
                                    {formatApiRate(rates[key], t("codexModels.unknownRate"))}
                                  </td>
                                ))
                              ) : (
                                <td colSpan={3} className="is-unknown codex-catalog-unknown-price">
                                  {t("codexModels.unpriced")}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </section>
                )}
                <div className="codex-catalog-pricing-caption">
                  <span className="codex-catalog-standard">Standard</span>
                  <span>
                    {commonThreshold
                      ? t(
                          priceContext === "short"
                            ? "codexModels.shortInputRange"
                            : "codexModels.longInputRange",
                          {
                            size: commonThreshold,
                          },
                        )
                      : t("codexModels.rangePerModel")}
                  </span>
                  <span>{t("codexModels.apiEstimate")}</span>
                </div>

                <details className="codex-catalog-manual">
                  <summary>
                    <Plus size={13} />
                    {t("codexModels.addManual")}
                    <ChevronRight size={12} />
                  </summary>
                  <form
                    className="codex-catalog-add"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void handleAdd();
                    }}
                  >
                    <label className="codex-catalog-add-field">
                      <span>{t("codexModels.modelId")}</span>
                      <input
                        className="mcp-field-input"
                        type="text"
                        value={modelIdDraft}
                        placeholder={t("codexModels.modelIdPlaceholder")}
                        onChange={(event) => setModelIdDraft(event.target.value)}
                      />
                    </label>
                    <label className="codex-catalog-add-field">
                      <span>{t("codexModels.displayNameOptional")}</span>
                      <input
                        className="mcp-field-input"
                        type="text"
                        value={displayNameDraft}
                        placeholder={t("codexModels.displayNameHint")}
                        onChange={(event) => setDisplayNameDraft(event.target.value)}
                      />
                    </label>
                    <button
                      type="submit"
                      className="settings-primary-button"
                      disabled={!modelIdDraft.trim() || refreshing}
                    >
                      <Plus size={13} />
                      {t("codexModels.addManual")}
                    </button>
                  </form>
                </details>
                <footer className="codex-catalog-footer">
                  <span
                    title={t("codexModels.footerCounts", {
                      remote: status?.remoteCount ?? 0,
                      manual: status?.manualCount ?? 0,
                    })}
                  >
                    {t("codexModels.manualRefreshOnly")}
                  </span>
                  <div className="codex-catalog-sources">
                    {status?.sourceUrl ? (
                      <a href={status.sourceUrl} target="_blank" rel="noreferrer" title={status.sourceUrl}>
                        {t("codexModels.modelSource")}
                        <ExternalLink size={10} />
                      </a>
                    ) : null}
                    {status?.pricingSourceUrl ? (
                      <a
                        href={status.pricingSourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={t("codexModels.pricingSourceDetail", {
                          time: pricingRefreshedAt,
                          url: status.pricingSourceUrl,
                        })}
                      >
                        {t("codexModels.pricingSource")}
                        <ExternalLink size={10} />
                      </a>
                    ) : null}
                  </div>
                </footer>
              </div>
            </dialog>,
            document.body,
          )
        : null}
    </>
  );
}
