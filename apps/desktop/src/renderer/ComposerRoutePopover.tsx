import { ChevronDown, LayoutTemplate, RotateCcw, Settings2 } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  ApprovalModelSelection,
  AuxiliaryModelSelection,
  CommitModelOptionView,
  MainAgentPromptSelection,
  ModelSettingsSnapshot,
  SubagentSelection,
  ThreadRuntimeConfig,
  VisionModelSelection,
} from "../shared/ipc";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { clampComposerFloatingLeft, composerFloatingAvailableWidth } from "./composer-floating";
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

const POPOVER_WIDTH = 340;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;
const MIN_POPOVER_HEIGHT = 120;
const BUILTIN_PROMPT_VALUE = "builtin";
const SUBAGENTS_NONE_VALUE = "__none__";

interface CompositionControlHandlers {
  onSelectMainAgentConfig: (id: string) => void | Promise<void>;
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

function popoverStyleForAnchor(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(POPOVER_WIDTH, composerFloatingAvailableWidth(VIEWPORT_MARGIN));
  const spaceAbove = rect.top - VIEWPORT_MARGIN;
  const maxHeight = Math.max(MIN_POPOVER_HEIGHT, spaceAbove - ANCHOR_GAP);
  return {
    position: "fixed",
    left: clampComposerFloatingLeft(rect.left, width, VIEWPORT_MARGIN),
    bottom: window.innerHeight - rect.top + ANCHOR_GAP,
    width,
    maxHeight,
    zIndex: 10000,
  };
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
  onClose,
  onResetToGlobalSettings,
  onSelectMainAgentConfig,
  onSelectMainPrompt,
  onSelectSubagents,
  onSelectAuxiliaryModel,
  onSelectApprovalModel,
  onSelectVisionModel,
  onOpenFullSettings,
}: ComposerRoutePopoverProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));

  const updatePanelPosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(popoverStyleForAnchor(anchor));
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelStyle({ visibility: "hidden" });
      return;
    }
    updatePanelPosition();
    // Re-measure after paint in case the anchor ref attaches a frame late.
    const raf = window.requestAnimationFrame(() => updatePanelPosition());
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDownOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) {
        return;
      }
      // Nested ComposerFieldSelect / ModelCascadeSelect menus portal to
      // document.body; treat them as inside so selecting an option does not
      // dismiss this popover before the value can commit.
      if (target instanceof Element && target.closest(".composer-field-select-menu, .model-cascade-panel")) {
        return;
      }
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Portaled nested menus own their own Escape handling (clear search / close menu).
        const target = event.target as HTMLElement | null;
        if (target?.closest?.(".model-cascade-panel, .composer-field-select-menu")) {
          return;
        }
        onClose();
      }
    }
    // Defer so the opening click cannot immediately dismiss the popover.
    const listenerTimer = window.setTimeout(() => {
      document.addEventListener("mousedown", onPointerDownOutside);
    }, 0);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(listenerTimer);
      document.removeEventListener("mousedown", onPointerDownOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      ref={panelRef}
      className="composer-codex-popover composer-route-popover"
      role="dialog"
      aria-label={t("composer.route.switch")}
      style={panelStyle}
    >
      <header className="composer-route-popover-header">
        <p className="composer-codex-popover-title">{t("composer.route.profiles")}</p>
        <div className="composer-route-popover-actions">
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
        onSelectMainAgentConfig={onSelectMainAgentConfig}
        onSelectMainPrompt={onSelectMainPrompt}
        onSelectSubagents={onSelectSubagents}
        onSelectAuxiliaryModel={onSelectAuxiliaryModel}
        onSelectApprovalModel={onSelectApprovalModel}
        onSelectVisionModel={onSelectVisionModel}
      />
    </div>,
    document.body,
  );
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
  onSelectMainAgentConfig,
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
        onSelectMainAgentConfig={onSelectMainAgentConfig}
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
  onSelectMainAgentConfig,
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
  const mainAgentConfigs = (settings.mainAgentConfigs ?? []).filter(
    (config) => config.id !== "__openai_official__" || coreKind === "codex",
  );
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
  const selectedMainAgentConfigId = selection?.mainAgentConfigId ?? "";
  const mainAgentConfigId = mainAgentConfigs.some((config) => config.id === selectedMainAgentConfigId)
    ? selectedMainAgentConfigId
    : "";
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
      .listGitCommitModelOptions(mainAgentConfigId ? { mainAgentConfigId } : {})
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
  }, [mainAgentConfigId, settings.providers]);
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
      .listApprovalModelOptions(mainAgentConfigId ? { mainAgentConfigId } : {})
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
  }, [mainAgentConfigId, settings.providers]);
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
      {showOrchestration ? (
        <div className="composer-route-prompt-control">
          <span className="composer-route-prompt-label">{t("composer.route.mainAgent")}</span>
          <ComposerFieldSelect
            value={mainAgentConfigId}
            disabled={disabled || mainAgentConfigs.length === 0}
            showPlaceholder
            placeholder={t("composer.route.notConfigured")}
            invalid={mainAgentInvalid}
            invalidLabel={mainAgentInvalidLabel}
            searchable
            searchPlaceholder={t("composer.fieldSelect.searchMainAgent")}
            renderOptionIcon={(option) =>
              option.value === "__chatgpt_subscription__" ? (
                <img src="./provider-icons/openai.svg" alt="" />
              ) : option.value === "__openai_official__" ? (
                <img src="./agent-icons/codex.ico" alt="" />
              ) : null
            }
            onChange={(value) => void onSelectMainAgentConfig(value)}
          >
            {mainAgentConfigs.map((config) => (
              <option key={config.id} value={config.id}>
                {config.name} ({config.modelRef.modelId})
              </option>
            ))}
          </ComposerFieldSelect>
        </div>
      ) : null}
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
