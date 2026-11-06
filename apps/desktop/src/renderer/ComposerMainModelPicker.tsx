import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import { codexQuotaPeriod, codexQuotaResetAt } from "./codex-quota-reminder";
import { Check, ChevronDown, CircleHelp, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { CandidateModelView, CommitModelOptionView, ModelRef, ThinkingEffort } from "../shared/ipc";
import type { OpenAIAccountQuota } from "../shared/openai-account";
import { resolveProviderBrandLogo } from "../shared/provider-brand-logo";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import { ComposerModelLabel, formatComposerModelName, formatComposerThinkingEffortLabel } from "./ComposerModelLabel";

type Source = "login" | "oauth" | string;
type PickerPurpose = "main" | "subagent" | "auxiliary" | "vision" | "approval";
export function modelPickerAccountMode(source: Source, purpose: PickerPurpose): "select" | "inherit" | "none" {
  if (source === "oauth") return "select";
  if (source === "login") return purpose === "subagent" ? "inherit" : purpose === "main" ? "select" : "none";
  return "none";
}
type PickerDataKey = "custom" | "loginAccounts" | "oauthAccounts" | "loginModels";
type Account = { id: string; name: string; available?: boolean; statusLabel?: string; quota?: OpenAIAccountQuota | undefined; quotaError?: string | undefined };
type PickerModel = { id: string; name: string; candidateModelId?: string;
  reasoningEfforts?: ThinkingEffort[]; reasoningUnknown?: boolean; unsupportedCatalogEfforts?: string[] };
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
  if (!entry || entry.reasoningUnknown) return [];
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

export function associateOAuthModelEfforts(
  models: readonly PickerModel[],
  catalog: readonly { modelId: string; reasoningEfforts: string[] }[],
): PickerModel[] {
  const byId = new Map(catalog.map((entry) => [entry.modelId, entry]));
  return models.map((model) => {
    const entry = byId.get(model.id);
    if (!entry || entry.reasoningEfforts.length === 0) {
      return { ...model, reasoningEfforts: [], reasoningUnknown: true };
    }
    const reasoningEfforts = catalogThinkingEfforts(entry.reasoningEfforts);
    const unsupportedCatalogEfforts = entry.reasoningEfforts.filter((value) =>
      !THINKING_EFFORTS.includes((value === "none" ? "off" : value) as ThinkingEffort));
    return { ...model, reasoningEfforts, reasoningUnknown: reasoningEfforts.length === 0,
      unsupportedCatalogEfforts };
  });
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
  readOnly = false,
  invalid = false,
  invalidLabel,
  onSelect,
  onAddProvider,
  openRequest = 0,
  panelZIndex,
  purpose = "main",
  compactLabel = false,
  mainAccountId,
  onClear,
  onManageAccounts,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  model?: ModelRef | undefined;
  coreKind: string;
  panelZIndex?: number | undefined;
  purpose?: PickerPurpose;
  /** Composer toolbar reserves its label for the model and thinking effort. */
  compactLabel?: boolean;
  mainAccountId?: string | undefined;
  onClear?: (() => void | Promise<void>) | undefined;
  onManageAccounts?: (() => void) | undefined;
  openRequest?: number;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  invalid?: boolean | undefined;
  invalidLabel?: string | undefined;
  onSelect: (model: ModelRef) => void | Promise<void>;
  onAddProvider?: (() => void) | undefined;
}) {
  const { t, i18n } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const providerListRef = useRef<HTMLDivElement>(null);
  const accountListRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const loadedAccountSourcesRef = useRef(new Set<"login" | "oauth">());
  const accountPositionedRef = useRef(false);
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
  const [oauthAccountsLoaded, setOauthAccountsLoaded] = useState(false);
  const [loginModels, setLoginModels] = useState<Array<{
    modelId: string; displayName: string; reasoningEfforts: string[] }>>([]);
  const [accountModels, setAccountModels] = useState<{ accountId: string; models: PickerModel[] }>();
  const [accountModelsLoading, setAccountModelsLoading] = useState(false);
  const switchAccountIntent = useRef(false);
  const supportsThinking = purpose === "main" || purpose === "subagent";
  const selectionLabel = t(purpose === "subagent" ? "composer.route.subagentModel" : purpose === "main" ? "composer.route.mainModel" : purpose === "auxiliary"
    ? "composer.route.auxiliaryModel" : purpose === "vision" ? "composer.route.visionModel" : "composer.route.approvalModel");
  const [candidateCapabilities, setCandidateCapabilities] = useState<Record<string, CandidateModelView>>({});
  const [capabilitySettled, setCapabilitySettled] = useState<ReadonlySet<string>>(new Set());
  const [loadingData, setLoadingData] = useState<ReadonlySet<PickerDataKey>>(new Set());
  const [loadErrors, setLoadErrors] = useState<Partial<Record<PickerDataKey, string>>>({});
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!model?.providerId || !window.eco) return;
    let cancelled = false;
    if (model.providerId === "eco-coding-chatgpt") {
      void window.eco.chatGptSubscriptionAccountsList().then((accounts) => {
        if (!cancelled) {
          setOauthAccounts(accounts.map((account) => ({ id: account.accountId,
            name: account.displayName, available: account.enabled && account.hasCredentials && account.status === "ready" })));
          setOauthAccountsLoaded(true);
        }
      }).catch((cause: unknown) => { if (!cancelled) setError(String(cause)); });
    } else if (model.providerId === "openai") {
      if (purpose === "subagent") return;
      void window.eco.openAIAccountsList().then((accounts) => {
        if (!cancelled) setLoginAccounts(accounts.map((account) => ({ id: account.id, name: account.name })));
      }).catch((cause: unknown) => { if (!cancelled) setError(String(cause)); });
    } else {
      void window.eco.listGitCommitModelOptions({ includePricing: false }).then((result) => {
        if (!cancelled) setCandidates(result.options);
      }).catch((cause: unknown) => { if (!cancelled) setError(String(cause)); });
    }
    return () => { cancelled = true; };
  }, [model?.providerId, purpose]);

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
    const eco = window.eco;
    loadedAccountSourcesRef.current.clear();
    accountPositionedRef.current = false;
    setLoadingData(new Set<PickerDataKey>(["custom", "oauthAccounts", "loginModels",
      ...(purpose === "main" ? ["loginAccounts" as const] : [])]));
    setLoadErrors({});
    setError(undefined);
    function load<T>(key: PickerDataKey, request: Promise<T>, apply: (value: T) => void) {
      void request.then((value) => {
        if (!cancelled) apply(value);
      }).catch((cause: unknown) => {
        if (!cancelled) setLoadErrors((current) => ({
          ...current,
          [key]: cause instanceof Error ? cause.message : String(cause),
        }));
      }).finally(() => {
        if (!cancelled) setLoadingData((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
    }
    // Each local read publishes immediately; unrelated accounts and pricing never gate it.
    load("custom", (purpose === "approval" ? eco.listApprovalModelOptions({ includePricing: false }) : eco.listGitCommitModelOptions({ includePricing: false })),
      (result) => setCandidates(result.options));
    if (purpose === "main") load("loginAccounts", eco.openAIAccountsList(), (accounts) => {
      loadedAccountSourcesRef.current.add("login");
      setLoginAccounts(accounts.filter((account) => account.isLoggedIn || account.authState === "refreshable" ||
        account.authState === "refreshing")
      .map((account) => ({ id: account.id, name: account.name, quota: account.quota,
        quotaError: account.quotaRefresh?.error })));
    });
    load("oauthAccounts", eco.chatGptSubscriptionAccountsList(), (accounts) => {
      loadedAccountSourcesRef.current.add("oauth");
      setOauthAccountsLoaded(true);
      setOauthAccounts(accounts.map((account) => ({ id: account.accountId, name: account.displayName,
        available: account.enabled && account.hasCredentials && (account.status === "ready" || account.status === "refreshing"),
        statusLabel: !account.enabled ? t("settings.chatgptAccounts.statusDisabled")
          : account.status === "ready" ? t("settings.chatgptAccounts.statusReady")
          : account.status === "refreshing" ? t("settings.chatgptAccounts.statusRefreshing")
          : account.status === "rate_limited" ? t("settings.chatgptAccounts.statusRateLimited")
          : account.status === "subscription_usage_paused" ? t("settings.chatgptAccounts.statusUsagePaused")
          : account.status === "reauthorization_required" ? t("settings.chatgptAccounts.statusReauthorizationRequired")
          : t("settings.chatgptAccounts.statusTemporarilyUnavailable"),
      })));
    });
    load("loginModels", eco.getCodexModelCatalog(), (catalog) => setLoginModels(catalog.models
      .filter((entry) => !entry.hidden)
      .map((entry) => ({ modelId: entry.modelId, displayName: entry.displayName,
        reasoningEfforts: entry.reasoningEfforts }))));

    return () => { cancelled = true; };
  }, [open, purpose]);

  const loginAccountIds = loginAccounts.map((account) => account.id).join("\0");
  useEffect(() => {
    if (!open || purpose !== "main" || source !== "login" || !loginAccountIds || !window.eco) return;
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
  }, [open, source, loginAccountIds, purpose]);

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
    purpose === "subagent" || (purpose === "main" && coreKind === "codex")), [candidates, loginModels, coreKind, purpose]);
  const selectedProvider = providers.find((provider) => provider.id === source);
  const accountMode = modelPickerAccountMode(source, purpose);
  const accountSource = accountMode === "select";
  const accounts = !accountSource ? [] : source === "login" ? loginAccounts : oauthAccounts;

  const availableModels = source === "oauth"
    ? (accountModels?.accountId === accountId ? accountModels.models : [])
    : selectedProvider?.models ?? [];
  const accountsLoading = loadingData.has(source === "login" ? "loginAccounts" : "oauthAccounts");
  const modelsLoading = source === "oauth" ? accountModelsLoading : loadingData.has(source === "login" ? "loginModels" : "custom");
  const selectedAccount = oauthAccounts.find((account) => account.id === model?.accountId);
  const bindingError = model?.providerId === "eco-coding-chatgpt" && !model.accountId ? t("composer.route.selectAccount")
    : model?.providerId === "eco-coding-chatgpt" && oauthAccountsLoaded && !selectedAccount ? t("composer.mainPicker.accountRemoved")
    : model?.providerId === "eco-coding-chatgpt" && selectedAccount?.available === false ? t("settings.chatgptAccounts.statusTemporarilyUnavailable") : undefined;
  const displayError = [bindingError, error, ...Object.values(loadErrors)].filter(Boolean).join("；");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const accountQueryMatches = Boolean(normalizedQuery && accounts.some((account) => account.name.toLocaleLowerCase().includes(normalizedQuery)));
  const visibleModels = availableModels.filter((entry) =>
    !normalizedQuery || accountQueryMatches || entry.name.toLocaleLowerCase().includes(normalizedQuery) ||
    entry.id.toLocaleLowerCase().includes(normalizedQuery) ||
    selectedProvider?.name.toLocaleLowerCase().includes(normalizedQuery));
  const visibleAccounts = accounts.filter((account) => !accountQueryMatches || account.name.toLocaleLowerCase().includes(normalizedQuery));
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
  const capabilitiesLoading = Boolean((source === "oauth" && loadingData.has("loginModels")) ||
    (source !== "oauth" && activeModel?.candidateModelId &&
      !candidateCapabilities[activeModel.candidateModelId] && !capabilitySettled.has(source)));
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

  useEffect(() => {
    if (!open || accountPositionedRef.current || (source !== "login" && source !== "oauth") ||
      !loadedAccountSourcesRef.current.has(source) || source !== activeProviderId ||
      !accountId || accountId !== activeChoice?.accountId) return;
    const selected = accountListRef.current?.querySelector("button.is-selected");
    if (!selected) return;
    selected.scrollIntoView({ block: "nearest", inline: "nearest" });
    accountPositionedRef.current = true;
  }, [open, source, accountId, activeProviderId, activeChoice?.accountId, accounts]);

  const saveChoice = (choice: ModelRef): Promise<boolean> => {
    const { accountId: _accountId, ...withoutAccount } = choice;
    const selection = purpose === "subagent" && choice.providerId === "openai" ? withoutAccount : choice;
    const next = saveQueueRef.current.catch(() => {}).then(() => onSelect(selection));
    saveQueueRef.current = next;
    return next.then(() => true).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    });
  };

  const chooseModel = (entry: PickerModel) => {
    if (readOnly) return;
    const providerId = source === "login" ? "openai" : source === "oauth"
      ? "eco-coding-chatgpt" : source;
    if (!providerId || (accountSource && !accountId)) return;
    const initialEffort = supportsThinking ? resolvePickerThinkingEffort(preferredEffort,
      thinkingEffortsForModel(entry, candidateCapabilities)) : undefined;
    const choice: ModelRef = { providerId, modelId: entry.id,
      ...(entry.candidateModelId ? { candidateModelId: entry.candidateModelId } : {}),
      ...(accountSource ? { accountId } : {}),
      ...(initialEffort ? { thinkingEffort: initialEffort } : {}),
    };
    setActiveChoice(choice);
    if (initialEffort) setPreferredEffort(initialEffort);
    void saveChoice(choice).then((saved) => { if (saved && !supportsThinking) setOpen(false); });
  };

  const chooseAccount = (nextAccountId: string) => {
    if (nextAccountId === accountId) return;
    switchAccountIntent.current = true;
    setAccountId(nextAccountId);
    if (source === "login" && !readOnly && activeChoice?.providerId === "openai") {
      const choice = { ...activeChoice, accountId: nextAccountId };
      setActiveChoice(choice);
      void saveChoice(choice);
    }
  };

  const currentSelection = useRef({ activeChoice, readOnly, saveChoice });
  currentSelection.current = { activeChoice, readOnly, saveChoice };

  useEffect(() => {
    if (!open || source !== "oauth" || !accountId || !window.eco) return;
    let cancelled = false;
    setAccountModelsLoading(true);
    setError(undefined);
    void window.eco.chatGptSubscriptionAccountModelsList(accountId).then((models) => {
      if (cancelled) return;
      const entries = associateOAuthModelEfforts(models.map((entry) => ({ id: entry.id,
        name: entry.displayName ?? entry.id,
        ...(purpose !== "main" ? { candidateModelId: `account:eco-coding-chatgpt:${encodeURIComponent(entry.id)}` } : {}),
      })), loginModels);
      setAccountModels({ accountId, models: entries });
      const { activeChoice: currentChoice, readOnly: browseOnly, saveChoice: saveCurrentChoice } = currentSelection.current;
      if (switchAccountIntent.current && !browseOnly && currentChoice?.providerId === "eco-coding-chatgpt") {
        const supported = entries.find((entry) => entry.id === currentChoice.modelId);
        if (supported) {
          const choice = { ...currentChoice, accountId,
            ...(supported.candidateModelId ? { candidateModelId: supported.candidateModelId } : {}) };
          setActiveChoice(choice);
          void saveCurrentChoice(choice);
        } else {
          setActiveChoice(undefined);
          setError(t("composer.mainPicker.reselectModel"));
        }
      }
      switchAccountIntent.current = false;
    }).catch((cause: unknown) => {
      if (!cancelled) {
        setAccountModels(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }).finally(() => { if (!cancelled) setAccountModelsLoading(false); });
    return () => { cancelled = true; };
  }, [open, source, accountId, purpose, loginModels]);

  const chooseEffort = (effort: ThinkingEffort) => {
    if (readOnly) return;
    setPreferredEffort(effort);
    if (!activeChoice || !activeModel || sliderDisabled || !supportedEfforts.includes(effort)) return;
    const choice: ModelRef = { ...activeChoice, thinkingEffort: effort };
    setActiveChoice(choice);
    void saveChoice(choice);
  };

  useEffect(() => {
    if (!supportsThinking || readOnly || !open || !activeModel || !activeChoice || activeChoice.thinkingEffort || capabilitiesLoading) return;
    const effort = resolvePickerThinkingEffort(preferredEffort, supportedEfforts);
    if (effort) {
      setActiveChoice({ ...activeChoice, thinkingEffort: effort });
      setPreferredEffort(effort);
      void saveChoice({ ...activeChoice, thinkingEffort: effort });
    }
  }, [supportsThinking, readOnly, open, activeModel?.id, activeChoice?.thinkingEffort, preferredEffort, supportedEfforts, capabilitiesLoading]);

  const providerName = model?.providerId === "eco-coding-chatgpt" ? "ChatGPT OAuth"
    : model?.providerId === "openai" ? "ChatGPT Login"
    : providers.find((provider) => provider.id === model?.providerId)?.name ?? model?.providerId;
  const accountName = model?.providerId === "eco-coding-chatgpt" ? selectedAccount?.name
    : model?.providerId === "openai" ? purpose === "subagent" ? t("composer.mainPicker.inheritMainAccount")
      : loginAccounts.find((account) => account.id === model.accountId)?.name
    : undefined;
  const hoverDetails = [providerName, accountName, invalid ? invalidLabel : bindingError].filter(Boolean).join(" · ");
  const trigger = (
    <button ref={triggerRef} type="button"
      className={`composer-model-trigger${open ? " is-active" : ""}${model ? "" : " is-empty"}${invalid ? " is-invalid" : ""}`}
      aria-label={`${selectionLabel}：${model?.modelId ?? t("composer.route.notConfigured")}${invalid && invalidLabel ? ` — ${invalidLabel}` : ""}`}
      aria-invalid={invalid || Boolean(bindingError) || undefined}
      title={invalid ? invalidLabel : bindingError}
      aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
      onClick={() => setOpen((current) => !current)}>
      {model ? <span className="composer-model-picker-selection">
        {!compactLabel ? (model.providerId === "eco-coding-chatgpt" ? `ChatGPT · ${selectedAccount?.name ?? (model.accountId && oauthAccountsLoaded ? t("composer.mainPicker.accountRemoved") : model.accountId ? t("composer.mainPicker.selectedAccount") : t("composer.route.selectAccount"))} · `
          : purpose !== "main" ? `${providerName} · ` : "") : null}
        {supportsThinking ? <ComposerModelLabel modelId={model.modelId} thinkingEffort={model.thinkingEffort} size="medium" />
          : <span>{formatComposerModelName(model.modelId)}</span>}
      </span> : <span className="composer-model-empty-label">{t("composer.route.selectModel")}</span>}
      <ChevronDown size={13} className="composer-model-picker-chevron" aria-hidden />
    </button>
  );

  return <span className={`composer-model-selector${compactLabel ? " is-compact-label" : ""}`}>
    {compactLabel ? <ComposerHoverTooltip content={hoverDetails} disabled={open || !model}>
      {trigger}
    </ComposerHoverTooltip> : trigger}
    {open ? <ComposerAbovePanel anchorRef={anchorRef} triggerRef={triggerRef}
      className="composer-main-model-picker" label={selectionLabel}
      width={Math.max(476, anchorRef.current?.getBoundingClientRect().width ?? 476)}
      zIndex={panelZIndex} fixedHeight={420} minHeight={420} onClose={() => setOpen(false)}>
      <div className="composer-main-model-picker-search">
        <Search size={15} aria-hidden />
        <input data-panel-autofocus value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t("composer.mainPicker.searchAccounts")} aria-label={t("composer.mainPicker.searchAccounts")} />
      </div>
      {onClear ? <button type="button" className="model-cascade-clear" disabled={readOnly}
        onClick={() => { void Promise.resolve(onClear()).then(() => setOpen(false)).catch((cause: unknown) => setError(String(cause))); }}>{t("common.clear")}</button> : null}
      <div className="composer-main-model-picker-body">
        <div className="composer-main-model-picker-provider-column">
          <div className="composer-main-model-picker-section-label">{t("composer.mainPicker.providers")}</div>
          <div ref={providerListRef} className="composer-main-model-picker-providers"
            aria-label={t("composer.mainPicker.providers")}>
            {visibleProviders.map((provider) => <button key={provider.id} type="button"
              className={provider.id === source ? "is-selected" : ""}
              aria-pressed={provider.id === source}
              onClick={() => { setSource(provider.id); setAccountId(""); if (!readOnly) setActiveChoice(undefined); }}>
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
          {accountMode === "inherit" ? <div className="composer-main-model-picker-account-heading">
            <span className="composer-main-model-picker-section-label">{t("composer.mainPicker.inheritMainAccount")}</span>
            <ComposerHoverTooltip content={t("composer.mainPicker.loginSubagentAccountHint")}>
              <span tabIndex={0} aria-label={t("composer.mainPicker.loginSubagentAccountHint")}>
                <CircleHelp size={13} aria-hidden />
              </span>
            </ComposerHoverTooltip>
          </div> : null}
          {accountSource ? <div className={`composer-main-model-picker-accounts${source === "oauth" ? " is-oauth" : ""}`}>
            <div className="composer-main-model-picker-account-heading">
              <div className="composer-main-model-picker-section-label">{t("composer.mainPicker.accounts")}</div>
            {purpose !== "main" && mainAccountId && oauthAccounts.some((account) => account.id === mainAccountId && account.available) && source === "oauth" ? <button type="button"
              className="chatgpt-inline-link" disabled={readOnly} onClick={() => chooseAccount(mainAccountId)}>
              {t("composer.mainPicker.useMainAccount")}</button> : null}
            </div>
            <div ref={accountListRef} className="composer-main-model-picker-account-list">
              {accounts.length ? visibleAccounts.map((account) => <button key={account.id} type="button"
                className={account.id === accountId ? "is-selected" : ""}
                aria-pressed={account.id === accountId}
                disabled={source === "oauth" && account.available === false}
                onClick={() => chooseAccount(account.id)}>
                <span className="composer-main-model-picker-account-details">
                  <span className="composer-main-model-picker-account-name" title={account.name}>{account.name}</span>
                  {source === "oauth" ? <span className="composer-main-model-picker-account-status">{account.statusLabel}</span> : null}
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
              </button>) : <p className="composer-main-model-picker-hint">{accountsLoading
                ? t("composer.mainPicker.loading") : t("composer.mainPicker.noAccounts")}</p>}
            </div>
            {source === "oauth" && onManageAccounts ? <button type="button" className="chatgpt-inline-link"
              onClick={() => { setOpen(false); onManageAccounts(); }}>{t("composer.mainPicker.manageAccounts")}</button> : null}
          </div> : null}
          <div className="composer-main-model-picker-section-label">{t("composer.mainPicker.models")}</div>
          <div ref={modelListRef} className="composer-main-model-picker-models"
            aria-label={t("composer.mainPicker.models")}>
            {accountSource && !accountId ? <p className="composer-main-model-picker-hint">
              {t("composer.route.selectAccount")}</p>
              : modelsLoading && availableModels.length === 0 ? <p className="composer-main-model-picker-hint">
                {t("composer.mainPicker.loading")}</p>
                : visibleModels.length ? <div className="composer-main-model-picker-model-grid">
                  {visibleModels.map((entry) => {
                    const selected = activeChoice?.providerId === (source === "login" ? "openai"
                      : source === "oauth" ? "eco-coding-chatgpt" : source) &&
                      activeChoice.modelId === entry.id && (!accountSource || activeChoice.accountId === accountId) &&
                      (!entry.candidateModelId || activeChoice.candidateModelId === entry.candidateModelId);
                    return <button key={entry.candidateModelId ?? entry.id} type="button"
                      className={selected ? "is-selected" : ""} aria-pressed={selected}
                      title={entry.name} disabled={readOnly || (source === "oauth" && !accounts.some((account) => account.id === accountId && account.available))} onClick={() => chooseModel(entry)}>
                      <span>{entry.name}</span>{selected ? <Check size={14} aria-hidden /> : null}
                    </button>;
                  })}
                </div> : <p className="composer-main-model-picker-hint">{t("composer.mainPicker.noModels")}</p>}
          </div>
          {supportsThinking ? <div className="composer-main-model-picker-effort">
            <div className="composer-main-model-picker-effort-heading">
              <span className="composer-main-model-picker-section-label">
                {t("composer.mainPicker.thinkingEffort")}
              </span>
            </div>
            <ThinkingEffortSlider key={`${source}:${accountId}:${activeModel?.candidateModelId ?? activeModel?.id ?? "none"}`}
              efforts={sliderEfforts} value={activeChoice?.thinkingEffort ?? preferredEffort}
              disabled={readOnly || sliderDisabled}
              {...(capabilitiesLoading ? { statusLabel: t("composer.mainPicker.loading") }
                : activeModel?.reasoningUnknown
                  ? { statusLabel: t("composer.mainPicker.unknownThinkingEfforts") }
                  : activeModel && supportedEfforts.length === 0
                    ? { statusLabel: t("composer.mainPicker.noThinkingEfforts") } : {})}
              onCommit={chooseEffort} />
            {activeModel?.unsupportedCatalogEfforts?.length ? <p className="composer-main-model-picker-hint">
              {t("composer.mainPicker.unsupportedCatalogEfforts", { efforts: activeModel.unsupportedCatalogEfforts.join(", ") })}
            </p> : null}
          </div> : null}
        </div>
      </div>
      {onAddProvider && !readOnly && !loadingData.has("custom") && candidates.length === 0 ? <button type="button"
        className="composer-main-model-picker-add-provider"
        onClick={() => { setOpen(false); onAddProvider(); }}>
        {t("composer.model.addProvider")}
      </button> : null}
      {displayError ? <div className="composer-main-model-picker-error" role="alert">{displayError}</div> : null}
    </ComposerAbovePanel> : null}
  </span>;
}
