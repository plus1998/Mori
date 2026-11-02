import { codexQuotaPeriod, codexQuotaResetAt } from "./codex-quota-reminder";
import { Check, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CandidateModelView, CommitModelOptionView, ModelRef, ThinkingEffort } from "../shared/ipc";
import type { OpenAIAccountQuota } from "../shared/openai-account";
import { resolveProviderBrandLogo } from "../shared/provider-brand-logo";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import { ComposerModelLabel, formatComposerThinkingEffortLabel } from "./ComposerModelLabel";

type Source = "login" | "oauth" | string;
type Account = { id: string; name: string; quota?: OpenAIAccountQuota | undefined; quotaError?: string | undefined };
type PickerModel = { id: string; name: string; candidateModelId?: string;
  reasoningEfforts?: ThinkingEffort[] };
type ProviderOption = { id: Source; name: string; color?: string; icon?: string; models: PickerModel[] };
const THINKING_EFFORTS: readonly ThinkingEffort[] = ["off", "low", "medium", "high", "xhigh", "max"];
function catalogThinkingEfforts(levels: readonly string[]): ThinkingEffort[] {
  return [...new Set(levels.map((value) => value === "none" ? "off" : value)
    .filter((value): value is ThinkingEffort => THINKING_EFFORTS.includes(value as ThinkingEffort)))];
}

export function resolvePickerThinkingEffort(
  current: ThinkingEffort | undefined,
  supported: readonly ThinkingEffort[],
): ThinkingEffort | undefined {
  if (current && supported.includes(current)) return current;
  return supported.includes("low") ? "low" : supported[0];
}

export function thinkingEffortsForModel(entry: PickerModel | undefined,
  capabilities: Record<string, CandidateModelView>): readonly ThinkingEffort[] {
  if (!entry) return [];
  if (entry.reasoningEfforts) return entry.reasoningEfforts;
  if (entry.candidateModelId) {
    const capability = capabilities[entry.candidateModelId];
    if (!capability || capability.resolvedSupportsReasoning === false) return [];
  }
  return THINKING_EFFORTS;
}

function ThinkingEffortSlider({ efforts, value, disabled = false, statusLabel, onCommit }: {
  efforts: readonly ThinkingEffort[];
  value: ThinkingEffort | undefined;
  disabled?: boolean;
  statusLabel?: string;
  onCommit: (value: ThinkingEffort) => void;
}) {
  const { t } = useTranslation();
  const [draftIndex, setDraftIndex] = useState<number | undefined>();
  const draftIndexRef = useRef<number | undefined>(undefined);
  const unsupportedValue = Boolean(value && !efforts.includes(value));
  const selectedIndex = draftIndex ?? Math.max(0, efforts.indexOf(value ?? "low"));
  const selectedEffort = efforts[selectedIndex];
  const hasVisualSelection = !unsupportedValue || draftIndex !== undefined;
  const progress = hasVisualSelection && efforts.length > 1
    ? selectedIndex / (efforts.length - 1) * 100 : 0;
  const commitIndex = (index: number) => {
    draftIndexRef.current = undefined;
    setDraftIndex(undefined);
    const effort = efforts[index];
    if (effort && effort !== value) onCommit(effort);
  };
  return <div className={`composer-main-model-picker-effort-slider${disabled ? " is-disabled" : ""}`}>
    <div className="composer-main-model-picker-effort-value" aria-hidden>
      {statusLabel ?? (unsupportedValue && draftIndex === undefined
        ? t("composer.mainPicker.unsupportedThinkingEffort")
        : selectedEffort ? formatComposerThinkingEffortLabel(selectedEffort)
        : t("composer.mainPicker.noThinkingEfforts"))}
    </div>
    <div className="composer-main-model-picker-effort-track-wrap"
      style={{ "--effort-progress": `${progress}%` } as CSSProperties}>
      <div className="composer-main-model-picker-effort-track" aria-hidden>
        <div className="composer-main-model-picker-effort-fill" />
        <div className="composer-main-model-picker-effort-dots">
          {efforts.map((effort, index) => <span key={effort}
            className={hasVisualSelection && index <= selectedIndex ? "is-filled" : ""} />)}
        </div>
      </div>
      <input type="range" className={hasVisualSelection ? "" : "is-unset"}
        min={0} max={Math.max(0, efforts.length - 1)} step={1}
        value={selectedIndex} disabled={disabled || efforts.length < 2}
        aria-label={t("composer.mainPicker.thinkingEffort")}
        aria-valuetext={statusLabel ?? (unsupportedValue && draftIndex === undefined
          ? t("composer.mainPicker.unsupportedThinkingEffort")
          : selectedEffort ? formatComposerThinkingEffortLabel(selectedEffort)
          : t("composer.mainPicker.noThinkingEfforts"))}
        onChange={(event) => {
          const index = Number(event.currentTarget.value);
          draftIndexRef.current = index;
          setDraftIndex(index);
        }}
        onPointerUp={(event) => commitIndex(Number(event.currentTarget.value))}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key))
            commitIndex(Number(event.currentTarget.value));
        }}
        onBlur={() => { if (draftIndexRef.current !== undefined) commitIndex(draftIndexRef.current); }}
        onPointerCancel={() => { draftIndexRef.current = undefined; setDraftIndex(undefined); }} />
    </div>
  </div>;
}

export function buildMainModelProviderOptions(
  candidates: readonly CommitModelOptionView[],
  loginModels: readonly { modelId: string; displayName: string; reasoningEfforts?: string[] }[],
  includeLogin: boolean,
): ProviderOption[] {
  const custom = new Map<string, ProviderOption>();
  for (const candidate of candidates) {
    if (!candidate.candidateModelId || candidate.providerId === "openai" ||
      candidate.providerId === "eco-coding-chatgpt") continue;
    let provider = custom.get(candidate.providerId);
    if (!provider) {
      const icon = resolveProviderBrandLogo({ name: candidate.providerName })?.iconSrc;
      provider = { id: candidate.providerId, name: candidate.providerName,
        color: candidate.providerColor,
        ...(icon ? { icon } : {}),
        models: [] };
      custom.set(candidate.providerId, provider);
    }
    provider.models.push({ id: candidate.modelId, name: candidate.modelLabel,
      candidateModelId: candidate.candidateModelId });
  }
  return [
    ...custom.values(),
    ...(includeLogin ? [{ id: "login", name: "ChatGPT Login", icon: "./provider-icons/openai.svg",
      models: loginModels.map((entry) => ({
      id: entry.modelId, name: entry.displayName,
      ...(entry.reasoningEfforts ? { reasoningEfforts: catalogThinkingEfforts(entry.reasoningEfforts) } : {}),
    })) }] : []),
    { id: "oauth", name: "ChatGPT OAuth", icon: "./provider-icons/openai.svg", models: [] },
  ];
}

export function ComposerMainModelPicker({
  anchorRef,
  model,
  coreKind,
  disabled,
  invalid = false,
  invalidLabel,
  onSelect,
  onAddProvider,
  openRequest = 0,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  model?: ModelRef | undefined;
  coreKind: string;
  openRequest?: number;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  invalidLabel?: string | undefined;
  onSelect: (model: ModelRef) => void | Promise<void>;
  onAddProvider: () => void;
}) {
  const { t, i18n } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const providerListRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [open, setOpen] = useState(false);
  const previousOpenRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === previousOpenRequest.current) return;
    previousOpenRequest.current = openRequest;
    if (!disabled) setOpen(true);
  }, [openRequest, disabled]);
  const [activeChoice, setActiveChoice] = useState<ModelRef | undefined>(model);
  const [preferredEffort, setPreferredEffort] = useState<ThinkingEffort>(model?.thinkingEffort ?? "low");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source>(model?.providerId === "openai" ? "login"
    : model?.providerId === "eco-coding-chatgpt" ? "oauth" : model?.providerId ?? "");
  const [accountId, setAccountId] = useState(model?.accountId ?? "");
  const [candidates, setCandidates] = useState<CommitModelOptionView[]>([]);
  const [loginAccounts, setLoginAccounts] = useState<Account[]>([]);
  const [oauthAccounts, setOauthAccounts] = useState<Account[]>([]);
  const [loginModels, setLoginModels] = useState<Array<{
    modelId: string; displayName: string; reasoningEfforts: string[] }>>([]);
  const [oauthModels, setOauthModels] = useState<PickerModel[]>([]);
  const [candidateCapabilities, setCandidateCapabilities] = useState<Record<string, CandidateModelView>>({});
  const [capabilitySettled, setCapabilitySettled] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setSource(model?.providerId === "openai" ? "login"
      : model?.providerId === "eco-coding-chatgpt" ? "oauth" : model?.providerId ?? "");
    setAccountId(model?.accountId ?? "");
    setQuery("");
    setActiveChoice(model);
    setPreferredEffort(model?.thinkingEffort ?? "low");
  }, [open, model?.providerId, model?.accountId]);

  useEffect(() => {
    if (!open || !window.eco) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void Promise.allSettled([
      window.eco.listGitCommitModelOptions({}),
      window.eco.openAIAccountsList(),
      window.eco.chatGptSubscriptionAccountsList(),
      window.eco.getCodexModelCatalog(),
    ]).then(([custom, login, oauth, catalog]) => {
      if (cancelled) return;
      if (custom.status === "fulfilled") setCandidates(custom.value.options);
      if (login.status === "fulfilled") setLoginAccounts(login.value
        .filter((account) => account.isLoggedIn || account.authState === "refreshable" ||
          account.authState === "refreshing")
        .map((account) => ({ id: account.id, name: account.name, quota: account.quota,
          quotaError: account.quotaRefresh?.error })));
      if (oauth.status === "fulfilled") setOauthAccounts(oauth.value
        .filter((account) => account.enabled && account.hasCredentials)
        .map((account) => ({ id: account.accountId, name: account.displayName })));
      if (catalog.status === "fulfilled") setLoginModels(catalog.value.models
        .filter((entry) => !entry.hidden)
        .map((entry) => ({ modelId: entry.modelId, displayName: entry.displayName,
          reasoningEfforts: entry.reasoningEfforts })));
      const failures = [custom, login, oauth, catalog]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      setError(failures.length ? failures.join("；") : undefined);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [open]);

  const loginAccountIds = loginAccounts.map((account) => account.id).join("\0");
  useEffect(() => {
    if (!open || source !== "login" || !loginAccountIds || !window.eco) return;
    let cancelled = false;
    const eco = window.eco;
    for (const id of loginAccountIds.split("\0")) {
      void eco.openAIAccountsQueryQuota(id, "view").then((quota) => {
        if (!cancelled) setLoginAccounts((accounts) => accounts.map((account) =>
          account.id === id ? { ...account, quota, quotaError: undefined } : account));
      }).catch((cause: unknown) => {
        if (!cancelled) setLoginAccounts((accounts) => accounts.map((account) =>
          account.id === id ? { ...account, quotaError: cause instanceof Error ? cause.message : String(cause) } : account));
      });
    }
    return () => { cancelled = true; };
  }, [open, source, loginAccountIds]);

  useEffect(() => {
    if (!open || source !== "oauth" || !accountId || !window.eco) {
      setOauthModels([]);
      return;
    }
    let cancelled = false;
    setOauthModels([]);
    setModelsLoading(true);
    void window.eco.chatGptSubscriptionAccountModelsList(accountId)
      .then((models) => {
        if (!cancelled) setOauthModels(models.map((entry) => ({
          id: entry.id, name: entry.displayName ?? entry.id,
        })));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [open, source, accountId]);

  useEffect(() => {
    if (!open || source === "login" || source === "oauth" || !source || !window.eco) return;
    let cancelled = false;
    void window.eco.listCandidateModels(source).then((models) => {
      if (!cancelled) {
        setCandidateCapabilities((current) => ({ ...current,
          ...Object.fromEntries(models.map((entry) => [entry.id, entry])) }));
        setCapabilitySettled((current) => new Set(current).add(source));
      }
    }).catch((cause: unknown) => {
      if (!cancelled) {
        setCapabilitySettled((current) => new Set(current).add(source));
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => { cancelled = true; };
  }, [open, source]);

  const providers = useMemo(() => buildMainModelProviderOptions(candidates, loginModels,
    coreKind === "codex"), [candidates, loginModels, coreKind]);
  const selectedProvider = providers.find((provider) => provider.id === source);
  const accountSource = source === "login" || source === "oauth";
  const accounts = source === "login" ? loginAccounts : oauthAccounts;
  const availableModels = source === "oauth" ? oauthModels.map((entry) => {
    const catalog = loginModels.find((model) => model.modelId === entry.id);
    return catalog ? { ...entry, reasoningEfforts: catalogThinkingEfforts(catalog.reasoningEfforts) } : entry;
  }) : selectedProvider?.models ?? [];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleModels = availableModels.filter((entry) =>
    !normalizedQuery || entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
    entry.id.toLocaleLowerCase().includes(normalizedQuery) ||
    selectedProvider?.name.toLocaleLowerCase().includes(normalizedQuery));
  const visibleProviders = providers.filter((provider) =>
    !normalizedQuery || provider.id === source ||
    provider.name.toLocaleLowerCase().includes(normalizedQuery) ||
    provider.models.some((entry) => entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
      entry.id.toLocaleLowerCase().includes(normalizedQuery)));
  const activeProviderId = activeChoice?.providerId === "openai" ? "login"
    : activeChoice?.providerId === "eco-coding-chatgpt" ? "oauth" : activeChoice?.providerId;
  const activeModel = activeProviderId === source && (!accountSource || activeChoice?.accountId === accountId)
    ? availableModels.find((entry) => entry.id === activeChoice?.modelId &&
      (!entry.candidateModelId || entry.candidateModelId === activeChoice?.candidateModelId))
    : undefined;
  const supportedEfforts = thinkingEffortsForModel(activeModel, candidateCapabilities);
  const capabilitiesLoading = Boolean(activeModel?.candidateModelId &&
    !candidateCapabilities[activeModel.candidateModelId] && !capabilitySettled.has(source));
  const sliderDisabled = capabilitiesLoading || Boolean(activeModel && supportedEfforts.length === 0);
  const sliderEfforts = activeModel && supportedEfforts.length > 0 ? supportedEfforts : THINKING_EFFORTS;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      providerListRef.current?.querySelector("button.is-selected")
        ?.scrollIntoView({ block: "nearest" });
      modelListRef.current?.querySelector("button.is-selected")
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, source, providers.length, availableModels.length, model?.modelId]);

  const saveChoice = (choice: ModelRef): Promise<boolean> => {
    const next = saveQueueRef.current.catch(() => {}).then(() => onSelect(choice));
    saveQueueRef.current = next;
    return next.then(() => true).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    });
  };

  const chooseModel = (entry: PickerModel) => {
    const providerId = source === "login" ? "openai" : source === "oauth"
      ? "eco-coding-chatgpt" : source;
    if (!providerId || (accountSource && !accountId)) return;
    const initialEffort = resolvePickerThinkingEffort(preferredEffort,
      thinkingEffortsForModel(entry, candidateCapabilities));
    const choice: ModelRef = { providerId, modelId: entry.id,
      ...(entry.candidateModelId ? { candidateModelId: entry.candidateModelId } : {}),
      ...(accountSource ? { accountId } : {}),
      ...(initialEffort ? { thinkingEffort: initialEffort } : {}),
    };
    setActiveChoice(choice);
    if (initialEffort) setPreferredEffort(initialEffort);
    void saveChoice(choice);
  };

  const chooseAccount = (nextAccountId: string) => {
    if (nextAccountId === accountId) return;
    const providerId = source === "login" ? "openai" : "eco-coding-chatgpt";
    const currentChoice = activeChoice?.providerId === providerId ? activeChoice
      : model?.providerId === providerId ? model : undefined;
    setAccountId(nextAccountId);
    if (!currentChoice) {
      setActiveChoice(undefined);
      return;
    }
    const choice: ModelRef = { ...currentChoice, accountId: nextAccountId };
    setActiveChoice(choice);
    void saveChoice(choice);
  };

  const chooseEffort = (effort: ThinkingEffort) => {
    setPreferredEffort(effort);
    if (!activeChoice || !activeModel || sliderDisabled || !supportedEfforts.includes(effort)) return;
    const choice: ModelRef = { ...activeChoice, thinkingEffort: effort };
    setActiveChoice(choice);
    void saveChoice(choice);
  };

  useEffect(() => {
    if (!open || !activeModel || !activeChoice || activeChoice.thinkingEffort) return;
    const effort = resolvePickerThinkingEffort(preferredEffort, supportedEfforts);
    if (effort) {
      setActiveChoice({ ...activeChoice, thinkingEffort: effort });
      setPreferredEffort(effort);
      void saveChoice({ ...activeChoice, thinkingEffort: effort });
    }
  }, [open, activeModel?.id, activeChoice?.thinkingEffort, preferredEffort, supportedEfforts]);

  return <span className="composer-model-selector">
    <button ref={triggerRef} type="button"
      className={`composer-model-trigger${open ? " is-active" : ""}${model ? "" : " is-empty"}${invalid ? " is-invalid" : ""}`}
      aria-label={`${t("composer.route.mainModel")}：${model?.modelId ?? t("composer.route.notConfigured")}${invalid && invalidLabel ? ` — ${invalidLabel}` : ""}`}
      aria-invalid={invalid || undefined}
      title={invalid ? invalidLabel : undefined}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
      onClick={() => setOpen((current) => !current)}>
      {model ? <ComposerModelLabel modelId={model.modelId} thinkingEffort={model.thinkingEffort}
        size="medium" /> : <span className="composer-model-empty-label">{t("composer.route.selectModel")}</span>}
    </button>
    {open ? <ComposerAbovePanel anchorRef={anchorRef} triggerRef={triggerRef}
      className="composer-main-model-picker" label={t("composer.mainPicker.title")}
      fixedHeight={420} minHeight={280} onClose={() => setOpen(false)}>
      <div className="composer-main-model-picker-search">
        <Search size={15} aria-hidden />
        <input data-panel-autofocus value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t("composer.mainPicker.search")} aria-label={t("composer.mainPicker.search")} />
      </div>
      <div className="composer-main-model-picker-body">
        <div className="composer-main-model-picker-provider-column">
          <div className="composer-main-model-picker-section-label">{t("composer.mainPicker.providers")}</div>
          <div ref={providerListRef} className="composer-main-model-picker-providers"
            aria-label={t("composer.mainPicker.providers")}>
            {visibleProviders.map((provider) => <button key={provider.id} type="button"
              className={provider.id === source ? "is-selected" : ""}
              aria-pressed={provider.id === source}
              onClick={() => { setSource(provider.id); setAccountId(""); setActiveChoice(undefined); }}>
              {provider.icon ? <img className="composer-main-model-picker-provider-icon"
                src={provider.icon} alt="" aria-hidden />
                : <span className="composer-main-model-picker-provider-dot"
                  style={{ backgroundColor: provider.color }} aria-hidden />}
              <span>{provider.name}</span>
              {provider.id === source ? <Check size={14} aria-hidden /> : null}
            </button>)}
          </div>
        </div>
        <div className="composer-main-model-picker-content">
          {accountSource ? <div className="composer-main-model-picker-accounts">
            <div className="composer-main-model-picker-section-label">{t("composer.mainPicker.accounts")}</div>
            <div className="composer-main-model-picker-account-list">
              {accounts.length ? accounts.map((account) => <button key={account.id} type="button"
                className={account.id === accountId ? "is-selected" : ""}
                aria-pressed={account.id === accountId}
                onClick={() => chooseAccount(account.id)}>
                <span className="composer-main-model-picker-account-details">
                  <span className="composer-main-model-picker-account-name">{account.name}</span>
                  {source === "login" ? <span className="composer-main-model-picker-account-quota"
                    title={account.quotaError || undefined}>
                    {account.quotaError ? <span className="composer-main-model-picker-quota-error">{t("codexQuota.refreshFailed")}</span> : null}
                    {account.quota && (account.quota.rateLimit.primaryWindow || account.quota.rateLimit.secondaryWindow)
                      ? [account.quota.rateLimit.primaryWindow, account.quota.rateLimit.secondaryWindow]
                        .filter((window) => window !== null)
                        .map((window, index) => {
                          const label = codexQuotaPeriod(window.limitWindowSeconds) === "month"
                            ? t("settings.openaiAccounts.monthlyQuota")
                            : codexQuotaPeriod(window.limitWindowSeconds) === "week"
                              ? t("settings.openaiAccounts.weeklyQuota")
                              : window.limitWindowSeconds > 0
                              ? t("settings.openaiAccounts.windowHours", { count: window.limitWindowSeconds / 3_600 })
                              : t("settings.openaiAccounts.quotaWindow");
                          const remaining = Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
                          const remainingText = t("codexSwitch.remaining", { percent: remaining });
                          const resetAt = codexQuotaResetAt(window, account.quota!.fetchedAt);
                          const resetText = resetAt === undefined
                            ? t("settings.openaiAccounts.quotaResetUnknown")
                            : resetAt <= Date.now()
                              ? t("settings.openaiAccounts.quotaResetDueShort")
                              : t("settings.openaiAccounts.quotaResetAtShort", { time: new Date(resetAt).toLocaleString(i18n.language, {
                                month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
                              }) });
                          return <span className="composer-main-model-picker-quota-window" key={index}>
                            <span className="composer-main-model-picker-quota-heading"><span>{label}</span><span>{remaining}%</span></span>
                            <span className={`composer-main-model-picker-quota-track${remaining <= 10 ? " is-limited" : remaining <= 20 ? " is-low" : ""}`}
                              role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
                              aria-valuenow={remaining} aria-valuetext={remainingText}>
                              <span style={{ width: `${remaining}%` }} />
                            </span>
                            <span className="composer-main-model-picker-quota-reset" title={resetText}>{resetText}</span>
                          </span>;
                        })
                      : t("settings.openaiAccounts.quotaIdle")}
                  </span> : null}
                </span>{account.id === accountId ? <Check size={14} aria-hidden /> : null}
              </button>) : <p className="composer-main-model-picker-hint">{loading
                ? t("composer.mainPicker.loading") : t("composer.mainPicker.noAccounts")}</p>}
            </div>
          </div> : null}
          <div className="composer-main-model-picker-section-label">{t("composer.mainPicker.models")}</div>
          <div ref={modelListRef} className="composer-main-model-picker-models"
            aria-label={t("composer.mainPicker.models")}>
            {accountSource && !accountId ? <p className="composer-main-model-picker-hint">
              {t("composer.route.selectAccount")}</p>
              : loading || modelsLoading ? <p className="composer-main-model-picker-hint">
                {t("composer.mainPicker.loading")}</p>
                : visibleModels.length ? <div className="composer-main-model-picker-model-grid">
                  {visibleModels.map((entry) => {
                    const selected = activeChoice?.providerId === (source === "login" ? "openai"
                      : source === "oauth" ? "eco-coding-chatgpt" : source) &&
                      activeChoice.modelId === entry.id && (!accountSource || activeChoice.accountId === accountId) &&
                      (!entry.candidateModelId || activeChoice.candidateModelId === entry.candidateModelId);
                    return <button key={entry.candidateModelId ?? entry.id} type="button"
                      className={selected ? "is-selected" : ""} aria-pressed={selected}
                      title={entry.name} onClick={() => chooseModel(entry)}>
                      <span>{entry.name}</span>{selected ? <Check size={14} aria-hidden /> : null}
                    </button>;
                  })}
                </div> : <p className="composer-main-model-picker-hint">{t("composer.mainPicker.noModels")}</p>}
          </div>
          <div className="composer-main-model-picker-effort">
            <div className="composer-main-model-picker-effort-heading">
              <span className="composer-main-model-picker-section-label">
                {t("composer.mainPicker.thinkingEffort")}
              </span>
            </div>
            <ThinkingEffortSlider key={`${source}:${accountId}:${activeModel?.candidateModelId ?? activeModel?.id ?? "none"}`}
              efforts={sliderEfforts} value={activeChoice?.thinkingEffort ?? preferredEffort}
              disabled={sliderDisabled}
              {...(capabilitiesLoading ? { statusLabel: t("composer.mainPicker.loading") }
                : activeModel && supportedEfforts.length === 0
                  ? { statusLabel: t("composer.mainPicker.noThinkingEfforts") } : {})}
              onCommit={chooseEffort} />
          </div>
        </div>
      </div>
      {!loading && candidates.length === 0 ? <button type="button"
        className="composer-main-model-picker-add-provider"
        onClick={() => { setOpen(false); onAddProvider(); }}>
        {t("composer.model.addProvider")}
      </button> : null}
      {error ? <div className="composer-main-model-picker-error" role="alert">{error}</div> : null}
    </ComposerAbovePanel> : null}
  </span>;
}
