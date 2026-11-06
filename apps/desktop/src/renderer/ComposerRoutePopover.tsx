import { ModelFieldLabel } from "./ModelFieldLabel";
import { ArrowLeft, ChevronDown, LayoutTemplate, RotateCcw, Settings2, X } from "lucide-react";
import {
  type RefObject,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  ApprovalModelSelection,
  AuxiliaryModelSelection,
  MainAgentPromptSelection,
  ModelRef,
  ModelSettingsSnapshot,
  SubagentSelection,
  ThreadRuntimeConfig,
  VisionModelSelection,
} from "../shared/ipc";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import { ComposerMainModelPicker } from "./ComposerMainModelPicker";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";
import { StatelessModelControl } from "./StatelessModelControl";

import type { OrchestrationFieldIssue, OrchestrationFieldKey } from "./orchestration-readiness";
import { orchestrationIssueDetailKey } from "./orchestration-readiness";

const BUILTIN_PROMPT_VALUE = "builtin";
const SUBAGENTS_NONE_VALUE = "__none__";

interface CompositionControlHandlers {
  onSelectMainModel: (model: ModelRef) => void | Promise<void>;
  onSelectMainPrompt: (selection: MainAgentPromptSelection) => void | Promise<void>;
  onSelectSubagents: (selection: SubagentSelection) => void | Promise<void>;
  onSelectAuxiliaryModel: (selection: AuxiliaryModelSelection | undefined) => void | Promise<void>;
  onSelectApprovalModel: (selection: ApprovalModelSelection) => void | Promise<void>;
  onSelectVisionModel: (selection: VisionModelSelection | undefined) => void | Promise<void>;
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

export function MainModelControl({ model, coreKind, disabled, invalid, invalidLabel, onSelect, onAddProvider }: {
  model?: ModelRef | undefined;
  coreKind?: string | undefined;
  disabled?: boolean | undefined;
  invalid: boolean;
  invalidLabel: string;
  onSelect: (model: ModelRef) => void | Promise<void>;
  onAddProvider: () => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLDivElement>(null);
  return <div ref={anchorRef} className="composer-route-prompt-control composer-route-main-model-control">
    <span className="composer-route-prompt-label">{t("composer.route.mainModel")}</span>
    <ComposerMainModelPicker
      anchorRef={anchorRef}
      model={model}
      coreKind={coreKind ?? ""}
      disabled={disabled}
      invalid={invalid}
      invalidLabel={invalidLabel}
      onSelect={onSelect}
      onAddProvider={onAddProvider}
    />
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
  onAddProvider: () => void;
  onResetToGlobalSettings: () => void | Promise<void>;
  onOpenFullSettings: () => void;
  onManageAccounts: () => void;
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
  onManageAccounts: () => void;
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
  onAddProvider,
  onSelectMainPrompt,
  onSelectSubagents,
  onSelectAuxiliaryModel,
  onSelectApprovalModel,
  onSelectVisionModel,
  onOpenFullSettings,
  onManageAccounts,
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
        onAddProvider={() => {
          onClose();
          onAddProvider();
        }}
        onManageAccounts={onManageAccounts}
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
  onManageAccounts,
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
        onAddProvider={onOpenFullSettings}
        onManageAccounts={onManageAccounts}
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
  onAddProvider,
  onManageAccounts,
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
  onAddProvider: () => void;
  onManageAccounts: () => void;
} & CompositionControlHandlers) {
  const { t } = useTranslation();
  const mainAgentPrompts = (settings.mainAgentPrompts ?? []).filter(
    (prompt) => prompt.mode === "custom_append",
  );
  const subagentOrchestrations = settings.subagentOrchestrations ?? [];
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
        onAddProvider={onAddProvider}
        onSelect={onSelectMainModel}
      /> : null}
      <div className="composer-route-prompt-control">
        <ModelFieldLabel className="composer-route-prompt-label" label={t("composer.route.auxiliaryModel")} hint={auxiliaryHint} />
        <StatelessModelControl
          value={runtimeConfig?.auxiliaryModel} purpose="auxiliary"
          mainModel={runtimeConfig?.orchestrationSelection?.mainModel}
          disabled={statelessModelsDisabled ?? disabled}
          onManageAccounts={onManageAccounts}
          onAddProvider={onAddProvider}
          onChange={onSelectAuxiliaryModel}
        />
      </div>
      <div className="composer-route-prompt-control">
        <ModelFieldLabel className="composer-route-prompt-label" label={t("composer.route.approvalModel")} hint={t("composer.route.approvalModelHint")} />
        <StatelessModelControl
          value={runtimeConfig?.approvalModel} purpose="approval"
          mainModel={runtimeConfig?.orchestrationSelection?.mainModel}
          disabled={statelessModelsDisabled ?? disabled}
          onManageAccounts={onManageAccounts}
          onAddProvider={onAddProvider}
          onChange={(next) => { if (next) return onSelectApprovalModel(next); }}
        />
      </div>
      <div className="composer-route-prompt-control">
        <ModelFieldLabel className="composer-route-prompt-label" label={t("composer.route.visionModel")} hint={visionHint} />
        <StatelessModelControl
          value={runtimeConfig?.visionModel} purpose="vision"
          mainModel={runtimeConfig?.orchestrationSelection?.mainModel}
          disabled={statelessModelsDisabled ?? disabled}
          onManageAccounts={onManageAccounts}
          onAddProvider={onAddProvider}
          onChange={onSelectVisionModel}
        />
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
