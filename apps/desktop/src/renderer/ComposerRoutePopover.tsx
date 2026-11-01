import { ArrowLeft, ChevronDown, LayoutTemplate, RotateCcw, Settings2, X } from "lucide-react";
import {
  type RefObject,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ApprovalModelSelection,
  AuxiliaryModelSelection,
  CommitModelOptionView,
  MainAgentPromptSelection,
  ModelRef,
  ModelSettingsSnapshot,
  SubagentSelection,
  ThreadRuntimeConfig,
  VisionModelSelection,
} from "../shared/ipc";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";
import { ModelCascadeSelect } from "./ModelCascadeSelect";
import {
  createCommitModelPricingExtra,
  mapCommitModelOptions,
  toCandidateModelSelection,
  toModelCascadeSelection,
} from "./model-cascade-options";
import type { OrchestrationFieldIssue, OrchestrationFieldKey } from "./orchestration-readiness";
import { orchestrationIssueDetailKey } from "./orchestration-readiness";

const BUILTIN_PROMPT_VALUE = "builtin";
const SUBAGENTS_NONE_VALUE = "__none__";

interface CompositionControlHandlers {
  onSelectMainModel: (model: ModelRef) => void | Promise<void>;
  onSelectMainPrompt: (selection: MainAgentPromptSelection) => void | Promise<void>;
  onSelectSubagents: (selection: SubagentSelection) => void | Promise<void>;
  onSelectAuxiliaryModel: (selection: AuxiliaryModelSelection) => void | Promise<void>;
  onSelectApprovalModel: (selection: ApprovalModelSelection) => void | Promise<void>;
  onSelectVisionModel: (selection: VisionModelSelection) => void | Promise<void>;
}

function mainPromptSelectionValue(selection: MainAgentPromptSelection | undefined): string {
  if (!selection) {
    return "";
  }
  return selection.mode === "builtin" ? BUILTIN_PROMPT_VALUE : selection.promptId;
}

function subagentSelectionValue(selection: SubagentSelection | undefined): string {
  if (!selection || selection.mode === "none") {
    return SUBAGENTS_NONE_VALUE;
  }
  return selection.orchestrationId;
}

export function MainModelControl({ model, coreKind, disabled, invalid, invalidLabel, onSelect }: {
  model?: ModelRef | undefined;
  coreKind?: string | undefined;
  disabled?: boolean | undefined;
  invalid: boolean;
  invalidLabel: string;
  onSelect: (model: ModelRef) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const sourceFromModel = model?.providerId === "openai" ? "login"
    : model?.providerId === "eco-coding-chatgpt" ? "oauth" : "custom";
  const [source, setSource] = useState(sourceFromModel);
  const [accountId, setAccountId] = useState(model?.accountId ?? "");
  const [customModels, setCustomModels] = useState<CommitModelOptionView[]>([]);
  const [loginAccounts, setLoginAccounts] = useState<Array<{
    id: string; name: string; isLoggedIn: boolean; authState?: string;
  }>>([]);
  const [oauthAccounts, setOauthAccounts] = useState<Array<{
    accountId: string; displayName: string; enabled: boolean; hasCredentials: boolean;
  }>>([]);
  const [loginModels, setLoginModels] = useState<Array<{ modelId: string; displayName: string }>>([]);
  const [oauthModels, setOauthModels] = useState<Array<{ id: string; displayName?: string }>>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setSource(sourceFromModel);
    setAccountId(model?.accountId ?? "");
  }, [sourceFromModel, model?.accountId]);

  useEffect(() => {
    if (!window.eco) return;
    let cancelled = false;
    void Promise.allSettled([
      window.eco.listGitCommitModelOptions({}),
      window.eco.openAIAccountsList(),
      window.eco.chatGptSubscriptionAccountsList(),
      window.eco.getCodexModelCatalog(),
    ]).then(([custom, login, oauth, catalog]) => {
      if (cancelled) return;
      if (custom.status === "fulfilled") setCustomModels(custom.value.options);
      if (login.status === "fulfilled") setLoginAccounts(login.value);
      if (oauth.status === "fulfilled") setOauthAccounts(oauth.value);
      if (catalog.status === "fulfilled") setLoginModels(catalog.value.models
        .filter((entry) => !entry.hidden).map((entry) => ({
          modelId: entry.modelId, displayName: entry.displayName,
        })));
      const failures = [custom, login, oauth, catalog]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      setError(failures.length ? failures.join("；") : undefined);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (source !== "oauth" || !accountId || !window.eco) {
      setOauthModels([]);
      return;
    }
    let cancelled = false;
    setOauthModels([]);
    void window.eco.chatGptSubscriptionAccountModelsList(accountId)
      .then((models) => { if (!cancelled) { setOauthModels(models); setError(undefined); } })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, [source, accountId]);

  const currentChoice = source === "login" ? "login" : source === "oauth" ? "oauth"
    : model?.candidateModelId ? `candidate:${model.candidateModelId}` : "";
  const currentModels = source === "login"
    ? loginModels.map((entry) => ({ id: entry.modelId, name: entry.displayName }))
    : oauthModels.map((entry) => ({ id: entry.id, name: entry.displayName ?? entry.id }));
  return <div className="composer-route-prompt-control composer-route-main-model-control">
    <span className="composer-route-prompt-label">{t("composer.route.mainModel")}</span>
    <div className="composer-route-main-model-account-row">
      <ComposerFieldSelect value={currentChoice} disabled={disabled} showPlaceholder
        placeholder={t("composer.route.notConfigured")} searchable invalid={invalid}
        invalidLabel={invalidLabel} searchPlaceholder={t("composer.fieldSelect.searchMainAgent")}
        onChange={(value) => {
          if (value === "login" || value === "oauth") {
            setSource(value);
            setAccountId("");
            return;
          }
          const selected = customModels.find((entry) => `candidate:${entry.candidateModelId}` === value);
          if (!selected) return;
          setSource("custom");
          void onSelect({ providerId: selected.providerId, modelId: selected.modelId,
            candidateModelId: selected.candidateModelId });
        }}>
        {customModels.map((entry) => <option key={entry.candidateModelId}
          value={`candidate:${entry.candidateModelId}`}>{entry.modelLabel} · {entry.providerName}</option>)}
        {coreKind === "codex" ? <option value="login">ChatGPT Login</option> : null}
        <option value="oauth">ChatGPT OAuth</option>
      </ComposerFieldSelect>
      {source === "login" || source === "oauth" ? <ComposerFieldSelect value={accountId}
        disabled={disabled} showPlaceholder searchable
        placeholder={t("composer.route.selectAccount")}
        onChange={(value) => { setAccountId(value); }}>
        {(source === "login"
          ? loginAccounts.filter((entry) => entry.isLoggedIn || entry.authState === "refreshable" ||
              entry.authState === "refreshing").map((entry) => ({ id: entry.id, name: entry.name }))
          : oauthAccounts.filter((entry) => entry.enabled && entry.hasCredentials)
            .map((entry) => ({ id: entry.accountId, name: entry.displayName })))
          .map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </ComposerFieldSelect> : null}
    </div>
    {(source === "login" || source === "oauth") && accountId ? (
      <ComposerFieldSelect
        value={model?.providerId === (source === "login" ? "openai" : "eco-coding-chatgpt") &&
          model.accountId === accountId ? model.modelId : ""}
        disabled={disabled || currentModels.length === 0}
        showPlaceholder
        searchable
        placeholder={t("composer.route.selectModel")}
        onChange={(modelId) => {
          if (!currentModels.some((entry) => entry.id === modelId)) return;
          void onSelect({
            providerId: source === "login" ? "openai" : "eco-coding-chatgpt",
            accountId,
            modelId,
          });
        }}
      >
        {currentModels.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </ComposerFieldSelect>
    ) : null}
    {error ? <span className="composer-route-prompt-hint" role="alert">{error}</span> : null}
  </div>;
}

interface ComposerRoutePopoverProps extends CompositionControlHandlers {
  open: boolean;
  settings: ModelSettingsSnapshot;
  runtimeConfig?: ThreadRuntimeConfig | undefined;
  busy?: boolean | undefined;
  canEdit?: boolean | undefined;
  /**
   * Auxiliary / approval / vision requests are stateless single-shot calls, so those
   * three selectors stay editable while a run is active. Defaults to `canEdit`.
   */
  canEditStatelessModels?: boolean | undefined;
  showOrchestration?: boolean | undefined;
  invalidFields?: readonly OrchestrationFieldKey[] | undefined;
  orchestrationIssues?: readonly OrchestrationFieldIssue[] | undefined;
  coreKind?: string | undefined;
  anchorRef: RefObject<HTMLElement | null>;
  triggerRef?: RefObject<HTMLElement | null> | undefined;
  onBack: () => void;
  onClose: () => void;
  onResetToGlobalSettings: () => void | Promise<void>;
  onOpenFullSettings: () => void;
}

interface ComposerRouteCardBodyProps extends CompositionControlHandlers {
  settings: ModelSettingsSnapshot;
  runtimeConfig?: ThreadRuntimeConfig | undefined;
  busy?: boolean | undefined;
  canEdit?: boolean | undefined;
  canEditStatelessModels?: boolean | undefined;
  showOrchestration?: boolean | undefined;
  invalidFields?: readonly OrchestrationFieldKey[] | undefined;
  orchestrationIssues?: readonly OrchestrationFieldIssue[] | undefined;
  coreKind?: string | undefined;
  onOpenFullSettings: () => void;
}

export function ComposerRoutePopover({
  open,
  settings,
  runtimeConfig,
  busy,
  canEdit = true,
  canEditStatelessModels = canEdit,
  showOrchestration = true,
  invalidFields,
  orchestrationIssues,
  coreKind,
  anchorRef,
  triggerRef,
  onBack,
  onClose,
  onResetToGlobalSettings,
  onSelectMainModel,
  onSelectMainPrompt,
  onSelectSubagents,
  onSelectAuxiliaryModel,
  onSelectApprovalModel,
  onSelectVisionModel,
  onOpenFullSettings,
}: ComposerRoutePopoverProps) {
  const { t } = useTranslation();
  const [singleColumn, setSingleColumn] = useState(false);
  if (!open) return null;
  return <ComposerAbovePanel anchorRef={anchorRef} triggerRef={triggerRef} className={`composer-route-popover${singleColumn ? " is-single-column" : ""}`} label={t("composer.route.profiles")} onClose={onClose}>
      <header className="composer-route-popover-header">
        <button type="button" className="composer-route-builder-button" onClick={onBack} aria-label={t("composer.plus.back")}><ArrowLeft size={18}/></button>
        <p className="composer-codex-popover-title">{t("composer.route.profiles")}</p>
        <div className="composer-route-popover-actions">
          <button type="button" className="composer-route-column-toggle" onClick={() => setSingleColumn(value => !value)}>{t(singleColumn ? "composer.plus.twoColumns" : "composer.plus.oneColumn")}</button>
          <button
            type="button"
            className="composer-route-builder-button"
            disabled={busy || !canEdit}
            title={t("composer.route.resetToGlobal")}
            aria-label={t("composer.route.resetToGlobal")}
            onClick={() => void onResetToGlobalSettings()}
          >
            <RotateCcw size={15} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            className="composer-route-builder-button"
            disabled={busy || !canEdit}
            title={t("composer.route.openBuilder")}
            aria-label={t("composer.route.openBuilder")}
            onClick={() => {
              onClose();
              onOpenFullSettings();
            }}
          >
            <Settings2 size={15} strokeWidth={1.75} aria-hidden />
          </button>
          <button type="button" className="composer-route-builder-button" onClick={onClose} aria-label={t("common.close")}><X size={18}/></button>
        </div>
      </header>
      <ComposerRouteCompositionControls
        settings={settings}
        runtimeConfig={runtimeConfig}
        disabled={busy || !canEdit}
        statelessModelsDisabled={busy || !canEditStatelessModels}
        showOrchestration={showOrchestration}
        invalidFields={invalidFields}
        orchestrationIssues={orchestrationIssues}
        coreKind={coreKind}
        onSelectMainModel={onSelectMainModel}
        onSelectMainPrompt={onSelectMainPrompt}
        onSelectSubagents={onSelectSubagents}
        onSelectAuxiliaryModel={onSelectAuxiliaryModel}
        onSelectApprovalModel={onSelectApprovalModel}
        onSelectVisionModel={onSelectVisionModel}
      />
    </ComposerAbovePanel>;
}

export function ComposerRouteCardBody({
  settings,
  runtimeConfig,
  busy,
  canEdit = false,
  canEditStatelessModels = canEdit,
  showOrchestration = true,
  invalidFields,
  orchestrationIssues,
  coreKind,
  onSelectMainModel,
  onSelectMainPrompt,
  onSelectSubagents,
  onSelectAuxiliaryModel,
  onSelectApprovalModel,
  onSelectVisionModel,
  onOpenFullSettings,
}: ComposerRouteCardBodyProps) {
  const { t } = useTranslation();

  return (
    <div className="composer-route-card-body">
      <ComposerRouteCompositionControls
        settings={settings}
        runtimeConfig={runtimeConfig}
        disabled={busy || !canEdit}
        statelessModelsDisabled={busy || !canEditStatelessModels}
        showOrchestration={showOrchestration}
        invalidFields={invalidFields}
        orchestrationIssues={orchestrationIssues}
        coreKind={coreKind}
        onSelectMainModel={onSelectMainModel}
        onSelectMainPrompt={onSelectMainPrompt}
        onSelectSubagents={onSelectSubagents}
        onSelectAuxiliaryModel={onSelectAuxiliaryModel}
        onSelectApprovalModel={onSelectApprovalModel}
        onSelectVisionModel={onSelectVisionModel}
      />
      <div className="composer-route-card-footer">
        <button
          type="button"
          className="composer-route-builder-button"
          disabled={busy || !canEdit}
          title={t("composer.route.openBuilder")}
          aria-label={t("composer.route.openBuilder")}
          onClick={onOpenFullSettings}
        >
          <Settings2 size={15} strokeWidth={1.75} aria-hidden />
          <span>{t("settings.orchestrationComponents")}</span>
        </button>
      </div>
    </div>
  );
}

function ComposerRouteCompositionControls({
  settings,
  runtimeConfig,
  disabled,
  statelessModelsDisabled,
  showOrchestration = true,
  invalidFields,
  orchestrationIssues,
  onSelectMainModel,
  onSelectMainPrompt,
  onSelectSubagents,
  onSelectAuxiliaryModel,
  onSelectApprovalModel,
  onSelectVisionModel,
  coreKind,
}: {
  settings: ModelSettingsSnapshot;
  runtimeConfig?: ThreadRuntimeConfig | undefined;
  disabled?: boolean | undefined;
  statelessModelsDisabled?: boolean | undefined;
  showOrchestration?: boolean | undefined;
  invalidFields?: readonly OrchestrationFieldKey[] | undefined;
  orchestrationIssues?: readonly OrchestrationFieldIssue[] | undefined;
  coreKind?: string | undefined;
} & CompositionControlHandlers) {
  const { t } = useTranslation();
  const mainAgentPrompts = (settings.mainAgentPrompts ?? []).filter(
    (prompt) => prompt.mode === "custom_append",
  );
  const subagentOrchestrations = settings.subagentOrchestrations ?? [];
  const [auxiliaryModelOptions, setAuxiliaryModelOptions] = useState<CommitModelOptionView[]>([]);
  const [auxiliaryModelsLoading, setAuxiliaryModelsLoading] = useState(false);
  const [auxiliaryModelsError, setAuxiliaryModelsError] = useState<string>();
  const auxiliaryModelCascadeOptions = useMemo(
    () => mapCommitModelOptions(auxiliaryModelOptions),
    [auxiliaryModelOptions],
  );
  const auxiliaryModelPricingExtra = useMemo(
    () => createCommitModelPricingExtra(auxiliaryModelOptions),
    [auxiliaryModelOptions],
  );
  const [approvalModelOptions, setApprovalModelOptions] = useState<CommitModelOptionView[]>([]);
  const [approvalModelsLoading, setApprovalModelsLoading] = useState(false);
  const [approvalModelsError, setApprovalModelsError] = useState<string>();
  const approvalModelCascadeOptions = useMemo(
    () => mapCommitModelOptions(approvalModelOptions),
    [approvalModelOptions],
  );
  const approvalModelPricingExtra = useMemo(
    () => createCommitModelPricingExtra(approvalModelOptions),
    [approvalModelOptions],
  );
  const selection = runtimeConfig?.orchestrationSelection;
  const mainAgentInvalid = Boolean(invalidFields?.includes("mainAgent"));
  const subagentOrchestrationInvalid = Boolean(invalidFields?.includes("subagentOrchestration"));
  const mainAgentIssue = orchestrationIssues?.find((issue) => issue.field === "mainAgent");
  const subagentIssue = orchestrationIssues?.find((issue) => issue.field === "subagentOrchestration");
  const mainAgentInvalidLabel = mainAgentIssue
    ? t(orchestrationIssueDetailKey(mainAgentIssue), {
        name: mainAgentIssue.mainAgentConfigName || t("composer.route.mainAgent"),
        provider: mainAgentIssue.providerName,
      }).replace(/^[:：]\s*/, "")
    : t("composer.route.fieldInvalid");
  const subagentInvalidLabel = subagentIssue
    ? t(orchestrationIssueDetailKey(subagentIssue), {
        orchestration: subagentIssue.orchestrationName || t("composer.route.subagentOrchestration"),
        agent: subagentIssue.agentKey
          ? t(`agent.role.${subagentIssue.agentKey}`, { defaultValue: subagentIssue.agentKey })
          : "",
        provider: subagentIssue.providerName,
      }).replace(/^[:：]\s*/, "")
    : t("composer.route.fieldInvalid");
  useEffect(() => {
    if (!window.eco) {
      setAuxiliaryModelOptions([]);
      setAuxiliaryModelsLoading(false);
      setAuxiliaryModelsError(undefined);
      return;
    }
    let cancelled = false;
    setAuxiliaryModelsLoading(true);
    setAuxiliaryModelsError(undefined);
    void window.eco
      .listGitCommitModelOptions({})
      .then((result) => {
        if (!cancelled) {
          setAuxiliaryModelOptions(result.options);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAuxiliaryModelOptions([]);
          setAuxiliaryModelsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuxiliaryModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.providers]);
  useEffect(() => {
    if (!window.eco) {
      setApprovalModelOptions([]);
      setApprovalModelsLoading(false);
      setApprovalModelsError(undefined);
      return;
    }
    let cancelled = false;
    setApprovalModelsLoading(true);
    setApprovalModelsError(undefined);
    void window.eco
      .listApprovalModelOptions({})
      .then((result) => {
        if (!cancelled) {
          setApprovalModelOptions(result.options);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setApprovalModelOptions([]);
          setApprovalModelsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setApprovalModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.providers]);
  const auxiliaryHint = showOrchestration
    ? t("composer.route.auxiliaryModelHint")
    : t("composer.route.auxiliaryModelHintAcp");
  const visionHint = showOrchestration
    ? t("composer.route.visionModelHint")
    : t("composer.route.visionModelHintAcp");
  const selectedMainPromptValue = mainPromptSelectionValue(selection?.mainPrompt);
  const mainPromptValue =
    selectedMainPromptValue === BUILTIN_PROMPT_VALUE ||
    mainAgentPrompts.some((prompt) => prompt.id === selectedMainPromptValue)
      ? selectedMainPromptValue
      : "";
  const subagentsValue = subagentSelectionValue(selection?.subagents);
  const subagentOrchestrationId =
    subagentsValue !== SUBAGENTS_NONE_VALUE &&
    subagentOrchestrations.some((orchestration) => orchestration.id === subagentsValue)
      ? subagentsValue
      : subagentsValue === SUBAGENTS_NONE_VALUE
        ? SUBAGENTS_NONE_VALUE
        : "";

  return (
    <div className="composer-route-composition-controls">
      {showOrchestration ? <MainModelControl
        model={selection?.mainModel}
        coreKind={coreKind}
        disabled={disabled}
        invalid={mainAgentInvalid}
        invalidLabel={mainAgentInvalidLabel}
        onSelect={onSelectMainModel}
      /> : null}
      <div className="composer-route-prompt-control">
        <span className="composer-route-prompt-label">{t("composer.route.auxiliaryModel")}</span>
        <ModelCascadeSelect
          value={toModelCascadeSelection(runtimeConfig?.auxiliaryModel)}
          options={auxiliaryModelCascadeOptions}
          loading={auxiliaryModelsLoading}
          error={auxiliaryModelsError}
          disabled={statelessModelsDisabled ?? disabled}
          hint={auxiliaryHint}
          placeholder={t("composer.route.auxiliaryModel")}
          renderExtra={auxiliaryModelPricingExtra}
          onChange={(selection) => {
            if (selection) {
              void onSelectAuxiliaryModel(toCandidateModelSelection(selection));
            }
          }}
        />
        <span className="composer-route-prompt-hint">{auxiliaryHint}</span>
      </div>
      <div className="composer-route-prompt-control">
        <span className="composer-route-prompt-label">{t("composer.route.approvalModel")}</span>
        <ModelCascadeSelect
          value={toModelCascadeSelection(runtimeConfig?.approvalModel)}
          options={approvalModelCascadeOptions}
          loading={approvalModelsLoading}
          error={approvalModelsError}
          disabled={statelessModelsDisabled ?? disabled}
          hint={t("composer.route.approvalModelHint")}
          placeholder={t("composer.route.approvalModel")}
          renderExtra={approvalModelPricingExtra}
          onChange={(selection) => {
            if (selection) {
              void onSelectApprovalModel(toCandidateModelSelection(selection));
            }
          }}
        />
        <span className="composer-route-prompt-hint">{t("composer.route.approvalModelHint")}</span>
      </div>
      <div className="composer-route-prompt-control">
        <span className="composer-route-prompt-label">{t("composer.route.visionModel")}</span>
        <ModelCascadeSelect
          value={toModelCascadeSelection(runtimeConfig?.visionModel)}
          options={auxiliaryModelCascadeOptions}
          loading={auxiliaryModelsLoading}
          error={auxiliaryModelsError}
          disabled={statelessModelsDisabled ?? disabled}
          hint={visionHint}
          placeholder={t("composer.route.visionModel")}
          renderExtra={auxiliaryModelPricingExtra}
          onChange={(selection) => {
            if (selection) {
              void onSelectVisionModel(toCandidateModelSelection(selection));
            }
          }}
        />
        <span className="composer-route-prompt-hint">{visionHint}</span>
      </div>
      {showOrchestration ? (
        <>
          <div className="composer-route-prompt-control">
            <span className="composer-route-prompt-label">{t("composer.route.prompt")}</span>
            <ComposerFieldSelect
              value={mainPromptValue}
              disabled={disabled}
              showPlaceholder
              placeholder={t("composer.route.notConfigured")}
              onChange={(value) => {
                if (!value) {
                  return;
                }
                void onSelectMainPrompt(
                  value === BUILTIN_PROMPT_VALUE
                    ? { mode: "builtin" }
                    : { mode: "custom_append", promptId: value },
                );
              }}
            >
              <option value={BUILTIN_PROMPT_VALUE}>{t("composer.route.defaultBuiltinPrompt")}</option>
              {mainAgentPrompts.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>
                  {prompt.name}
                </option>
              ))}
            </ComposerFieldSelect>
          </div>
          <div className="composer-route-prompt-control">
            <span className="composer-route-prompt-label">{t("composer.route.subagentOrchestration")}</span>
            <ComposerFieldSelect
              value={subagentOrchestrationId}
              disabled={disabled}
              invalid={subagentOrchestrationInvalid}
              invalidLabel={subagentInvalidLabel}
              searchable
              searchPlaceholder={t("composer.fieldSelect.searchSubagent")}
              onChange={(value) => {
                if (!value) {
                  return;
                }
                void onSelectSubagents(
                  value === SUBAGENTS_NONE_VALUE
                    ? { mode: "none" }
                    : { mode: "orchestration", orchestrationId: value },
                );
              }}
            >
              <option value={SUBAGENTS_NONE_VALUE}>{t("composer.route.noSubagents")}</option>
              {subagentOrchestrations.map((orchestration) => (
                <option key={orchestration.id} value={orchestration.id}>
                  {orchestration.name} ({orchestration.agents.length})
                </option>
              ))}
            </ComposerFieldSelect>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ComposerRoutePopoverTrigger({
  disabled,
  open,
  orchestrationName,
  buttonRef,
  compact,
  onToggle,
}: {
  disabled?: boolean | undefined;
  open: boolean;
  orchestrationName?: string | undefined;
  buttonRef: RefObject<HTMLButtonElement | null>;
  compact?: boolean | undefined;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label = orchestrationName?.trim() || t("composer.route.selectOrchestration");

  return (
    <button
      ref={buttonRef}
      type="button"
      className={[
        "composer-context-trigger",
        "composer-route-trigger",
        compact ? "is-compact" : "",
        open ? "is-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onToggle}
      disabled={disabled}
      title={
        orchestrationName
          ? t("composer.route.currentOrchestration", { name: orchestrationName })
          : t("composer.route.switch")
      }
      aria-label={
        orchestrationName
          ? t("composer.route.currentOrchestrationSwitch", { name: orchestrationName })
          : t("composer.route.switch")
      }
      aria-expanded={open}
    >
      <LayoutTemplate
        size={COMPOSER_TOOLBAR_ICON_PX}
        strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
        aria-hidden
        className="composer-context-trigger-icon"
      />
      <span
        className={
          orchestrationName
            ? "composer-context-trigger-label"
            : "composer-context-trigger-label is-placeholder"
        }
      >
        {label}
      </span>
      <ChevronDown size={14} aria-hidden className="composer-trigger-chevron" />
    </button>
  );
}
