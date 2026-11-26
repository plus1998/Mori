import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CursorApiKeyView } from "../shared/ipc";
import {
  ACP_MODEL_VENDOR_ICONS,
  ACP_MODEL_VENDORS,
  type AcpModelOption,
  type AcpModelVendor,
  filterAcpModels,
  groupAcpModelsByVendor,
  resolveAcpModelVendor,
} from "../shared/acp-model-vendor";
import type { I18nKey } from "../shared/i18n-catalogs";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import { ComposerModelPickerHeading } from "./ComposerModelPickerHeading";

export interface ComposerAcpModelTriggerProps {
  anchorRef: RefObject<HTMLElement | null>;
  models: readonly AcpModelOption[];
  selectedModelId?: string;
  disabled?: boolean;
  readOnly?: boolean;
  loading?: boolean;
  error?: string;
  onOpen?: () => void;
  onRefreshModels?: () => void;
  openRequest?: number;
  accounts?: readonly CursorApiKeyView[];
  selectedAccountId?: string | undefined;
  accountReadOnly?: boolean;
  onAccountChange?: (accountId: string | undefined) => void;
  onChange: (modelId: string | undefined) => void;
  panelZIndex?: number | undefined;
  /** Compact toolbar hides the account in the label; hover shows it instead. */
  showTooltip?: boolean;
}

const VENDOR_LABEL_KEYS: Record<AcpModelVendor, I18nKey> = {
  anthropic: "settings.acpModel.vendor.anthropic",
  gpt: "settings.acpModel.vendor.gpt",
  grok: "settings.acpModel.vendor.grok",
  google: "settings.acpModel.vendor.google",
  other: "settings.acpModel.vendor.other",
};

const PANEL_FIXED_HEIGHT = 420;

/**
 * Cursor Harness (ACP) model selection in the composer.
 * Mirrors ComposerMainModelPicker: AbovePanel, search, vendor column,
 * account list, and model grid — same interaction as Codex Login.
 */
export function ComposerAcpModelTrigger({
  anchorRef,
  models,
  selectedModelId,
  disabled,
  readOnly,
  loading,
  error,
  onOpen,
  onRefreshModels,
  openRequest = 0,
  accounts,
  selectedAccountId,
  accountReadOnly,
  onAccountChange,
  onChange,
  panelZIndex,
  showTooltip = true,
}: ComposerAcpModelTriggerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const vendorListRef = useRef<HTMLDivElement>(null);
  const accountListRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeVendor, setActiveVendor] = useState<AcpModelVendor>(() =>
    resolveAcpModelVendor(selectedModelId, models),
  );
  const previousOpenRequest = useRef(openRequest);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const openPanel = () => {
    if (disabled) return;
    setOpen(true);
    onOpenRef.current?.();
  };

  useEffect(() => {
    if (openRequest === previousOpenRequest.current) return;
    previousOpenRequest.current = openRequest;
    if (!disabled) {
      setOpen(true);
      onOpenRef.current?.();
    }
  }, [openRequest, disabled]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveVendor(resolveAcpModelVendor(selectedModelId, models));
  }, [open, selectedModelId, models]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      vendorListRef.current?.querySelector("button.is-selected")
        ?.scrollIntoView({ block: "nearest" });
      accountListRef.current?.querySelector("button.is-selected")
        ?.scrollIntoView({ block: "nearest" });
      modelListRef.current?.querySelector("button.is-selected")
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, activeVendor, selectedModelId, selectedAccountId, models.length]);

  const grouped = useMemo(() => groupAcpModelsByVendor(models), [models]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const showAccounts = Boolean(onAccountChange && (accounts?.length || selectedAccountId));
  const accountEntries = useMemo(() => {
    const list = [...(accounts ?? [])];
    if (selectedAccountId && !list.some((account) => account.id === selectedAccountId)) {
      list.push({
        id: selectedAccountId,
        name: t("settings.cursorApiKeys.unavailableAccount"),
        enabled: false,
        apiKeyPreview: "",
        oauthExpiresAt: 0,
        createdAt: "",
        updatedAt: "",
      });
    }
    return list;
  }, [accounts, selectedAccountId, t]);

  const accountQueryMatches = Boolean(
    normalizedQuery &&
      (t("settings.cursorApiKeys.autoAccount").toLocaleLowerCase().includes(normalizedQuery) ||
        accountEntries.some((account) => account.name.toLocaleLowerCase().includes(normalizedQuery))),
  );

  const searching = normalizedQuery.length > 0;
  // Mirror Codex Login search: account hits keep the active vendor's models;
  // otherwise filter models (cross-vendor when searching by model name).
  const visibleModels = useMemo(() => {
    if (!searching || accountQueryMatches) return grouped[activeVendor];
    const vendorName = t(VENDOR_LABEL_KEYS[activeVendor]).toLocaleLowerCase();
    if (vendorName.includes(normalizedQuery)) return grouped[activeVendor];
    return filterAcpModels(models, normalizedQuery);
  }, [searching, accountQueryMatches, grouped, activeVendor, models, normalizedQuery, t]);

  const vendorCounts = useMemo(() => {
    if (!searching || accountQueryMatches) return grouped;
    return groupAcpModelsByVendor(filterAcpModels(models, normalizedQuery));
  }, [searching, accountQueryMatches, grouped, models, normalizedQuery]);

  const visibleVendors = ACP_MODEL_VENDORS.filter((vendor) =>
    !searching ||
    vendor === activeVendor ||
    vendorCounts[vendor].length > 0 ||
    t(VENDOR_LABEL_KEYS[vendor]).toLocaleLowerCase().includes(normalizedQuery),
  );

  const visibleAccounts = accountEntries.filter((account) =>
    !accountQueryMatches || account.name.toLocaleLowerCase().includes(normalizedQuery),
  );
  const showAutoAccount =
    showAccounts &&
    (!accountQueryMatches ||
      t("settings.cursorApiKeys.autoAccount").toLocaleLowerCase().includes(normalizedQuery));

  const selectedModel = models.find((model) => model.id === selectedModelId);
  const triggerLabel = selectedModel?.displayName ?? t("settings.acpModel.default");
  const selectedAccount = selectedAccountId
    ? accountEntries.find((account) => account.id === selectedAccountId)
    : undefined;
  const selectedAccountName = selectedAccountId
    ? selectedAccount?.name ?? t("settings.cursorApiKeys.unavailableAccount")
    : t("settings.cursorApiKeys.autoAccount");
  const hoverDetails = [
    t("settings.cursorApiKeys.title"),
    selectedAccountName,
  ].join(" · ");

  const chooseModel = (modelId: string | undefined) => {
    if (readOnly) return;
    onChange(modelId);
    setOpen(false);
  };

  const chooseAccount = (accountId: string | undefined) => {
    if (accountReadOnly || !onAccountChange) return;
    if (accountId === selectedAccountId || (!accountId && !selectedAccountId)) return;
    onAccountChange(accountId);
  };

  const accountUnavailable = (account: CursorApiKeyView) =>
    !account.enabled || account.oauthExpiresAt === 0;

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      className={`composer-model-trigger composer-acp-model-trigger${open ? " is-active" : ""}`}
      aria-label={`${t("composer.model.triggerAria", { label: triggerLabel })} · ${selectedAccountName}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-busy={loading || undefined}
      disabled={disabled}
      onClick={() => {
        if (open) setOpen(false);
        else openPanel();
      }}
    >
      <span className="composer-model-picker-selection">
        <span className="composer-model-label is-medium">
          <span className="composer-model-label-name">{triggerLabel}</span>
        </span>
      </span>
      <ChevronDown size={13} className="composer-model-picker-chevron" aria-hidden />
    </button>
  );

  return (
    <span className="composer-model-selector is-compact-label">
      <ComposerHoverTooltip content={hoverDetails} disabled={!showTooltip || open}>
        {trigger}
      </ComposerHoverTooltip>
      {open ? (
        <ComposerAbovePanel
          anchorRef={anchorRef}
          triggerRef={triggerRef}
          className="composer-main-model-picker"
          label={t("settings.acpModel.title")}
          width={Math.max(476, anchorRef.current?.getBoundingClientRect().width ?? 476)}
          zIndex={panelZIndex}
          fixedHeight={PANEL_FIXED_HEIGHT}
          minHeight={PANEL_FIXED_HEIGHT}
          onClose={() => setOpen(false)}
        >
          <div className="composer-main-model-picker-search">
            <Search size={15} aria-hidden />
            <input
              data-panel-autofocus
              value={query}
              disabled={disabled || loading}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings.acpModel.searchPlaceholder")}
              aria-label={t("settings.acpModel.searchPlaceholder")}
            />
          </div>
          <button
            type="button"
            className={`model-cascade-clear${!selectedModelId ? " is-active" : ""}`}
            disabled={readOnly || loading}
            onClick={() => chooseModel(undefined)}
          >
            <span className="model-cascade-clear-label">{t("settings.acpModel.default")}</span>
            {!selectedModelId ? <Check size={14} aria-hidden /> : null}
          </button>
          <div className="composer-main-model-picker-body">
            <div className="composer-main-model-picker-provider-column">
              <div className="composer-main-model-picker-section-label">
                {t("settings.acpModel.vendors")}
              </div>
              <div
                ref={vendorListRef}
                className="composer-main-model-picker-providers"
                aria-label={t("settings.acpModel.vendors")}
              >
                {visibleVendors.map((vendor) => (
                  <button
                    key={vendor}
                    type="button"
                    className={vendor === activeVendor ? "is-selected" : ""}
                    aria-pressed={vendor === activeVendor}
                    onClick={() => {
                      setActiveVendor(vendor);
                      if (searching) setQuery("");
                    }}
                  >
                    <img
                      className="composer-main-model-picker-provider-icon"
                      src={ACP_MODEL_VENDOR_ICONS[vendor]}
                      alt=""
                      aria-hidden
                    />
                    <span>{t(VENDOR_LABEL_KEYS[vendor])}</span>
                    {vendor === activeVendor ? <Check size={14} aria-hidden /> : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="composer-main-model-picker-content">
              {showAccounts ? (
                <div className="composer-main-model-picker-accounts">
                  <div className="composer-main-model-picker-account-heading">
                    <div className="composer-main-model-picker-section-label">
                      {t("settings.cursorApiKeys.title")}
                    </div>
                  </div>
                  <div
                    ref={accountListRef}
                    className="composer-main-model-picker-account-list"
                  >
                    {showAutoAccount ? (
                      <button
                        type="button"
                        className={!selectedAccountId ? "is-selected" : ""}
                        aria-pressed={!selectedAccountId}
                        disabled={accountReadOnly}
                        onClick={() => chooseAccount(undefined)}
                      >
                        <span className="composer-main-model-picker-account-details">
                          <span className="composer-main-model-picker-account-name">
                            {t("settings.cursorApiKeys.autoAccount")}
                          </span>
                        </span>
                        {!selectedAccountId ? <Check size={14} aria-hidden /> : null}
                      </button>
                    ) : null}
                    {visibleAccounts.map((account) => {
                      const unavailable = accountUnavailable(account);
                      const selected = account.id === selectedAccountId;
                      return (
                        <button
                          key={account.id}
                          type="button"
                          className={selected ? "is-selected" : ""}
                          aria-pressed={selected}
                          disabled={accountReadOnly || unavailable}
                          onClick={() => chooseAccount(account.id)}
                        >
                          <span className="composer-main-model-picker-account-details">
                            <span
                              className="composer-main-model-picker-account-name"
                              title={account.name}
                            >
                              {account.name}
                            </span>
                            {unavailable ? (
                              <span className="composer-main-model-picker-account-status">
                                {t("settings.cursorApiKeys.unavailableAccount")}
                              </span>
                            ) : null}
                          </span>
                          {selected ? <Check size={14} aria-hidden /> : null}
                        </button>
                      );
                    })}
                    {!accountEntries.length && !showAutoAccount ? (
                      <p className="composer-main-model-picker-hint">
                        {t("settings.cursorApiKeys.empty")}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <ComposerModelPickerHeading onRefresh={onRefreshModels} loading={loading} refreshDisabled={disabled} />
              <div
                ref={modelListRef}
                className="composer-main-model-picker-models"
                aria-label={t("settings.acpModel.models")}
              >
                {loading && visibleModels.length === 0 ? (
                  <p className="composer-main-model-picker-hint">
                    {t("settings.acpModel.loading")}
                  </p>
                ) : visibleModels.length ? (
                  <div className="composer-main-model-picker-model-grid">
                    {visibleModels.map((model) => {
                      const selected = model.id === selectedModelId;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          className={selected ? "is-selected" : ""}
                          aria-pressed={selected}
                          title={model.current
                            ? `${model.displayName} · ${t("settings.acpModel.current")}`
                            : model.displayName}
                          disabled={readOnly || loading}
                          onClick={() => chooseModel(model.id)}
                        >
                          <span>
                            {model.displayName}
                            {model.current ? ` · ${t("settings.acpModel.current")}` : ""}
                          </span>
                          {selected ? <Check size={14} aria-hidden /> : null}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="composer-main-model-picker-hint">
                    {searching
                      ? t("settings.acpModel.noMatches")
                      : t("settings.acpModel.emptyVendor")}
                  </p>
                )}
              </div>
            </div>
          </div>
          {error ? (
            <div className="composer-main-model-picker-error" role="alert">
              {t("settings.acpModel.loadError", { error })}
            </div>
          ) : null}
        </ComposerAbovePanel>
      ) : null}
    </span>
  );
}
