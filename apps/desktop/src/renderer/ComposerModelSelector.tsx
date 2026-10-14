import { Check, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type {
  CandidateModelView,
  MainAgentModelOverride,
  ProviderConfigView,
  ThinkingEffort,
} from "../shared/ipc";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";
import {
  ComposerModelLabel,
  formatComposerModelName,
  formatComposerThinkingEffortLabel,
} from "./ComposerModelLabel";
import { composerFloatingPlacementViewportWidth, composerFloatingStyleForAnchor } from "./composer-floating";

export { formatComposerModelName, formatComposerThinkingEffortLabel } from "./ComposerModelLabel";

const THINKING_EFFORT_OPTIONS = [
  { value: "off" },
  { value: "low" },
  { value: "medium" },
  { value: "high" },
  { value: "xhigh" },
  { value: "max" },
] as const satisfies readonly { value: ThinkingEffort }[];

const ROOT_MODEL_INDEX = 0;
const ROOT_EFFORT_INDEX = 1;
const ROOT_RESET_INDEX = 2;

export interface ComposerModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  displayName?: string | undefined;
  candidateModelId?: string | undefined;
  supportsReasoning?: boolean | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
}

type ComposerModelProvider = Pick<ProviderConfigView, "id" | "name" | "defaultModel" | "enabled">;
type ComposerCandidateModel = Pick<
  CandidateModelView,
  "id" | "providerId" | "modelId" | "displayName" | "resolvedSupportsReasoning"
>;

export function buildComposerModelOptions(input: {
  provider: ComposerModelProvider | undefined;
  candidates: readonly ComposerCandidateModel[];
  templateModel: ComposerModelOption;
}): ComposerModelOption[] {
  const { provider, candidates, templateModel } = input;
  if (!provider?.enabled || templateModel.providerId !== provider.id) {
    return [];
  }

  const seenModelIds = new Set<string>();
  const options: ComposerModelOption[] = [];
  for (const candidate of candidates) {
    const modelId = candidate.modelId.trim();
    if (candidate.providerId !== provider.id || !modelId || seenModelIds.has(modelId)) {
      continue;
    }
    seenModelIds.add(modelId);
    options.push({
      providerId: provider.id,
      providerName: provider.name,
      modelId,
      candidateModelId: candidate.id,
      ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
      ...(candidate.resolvedSupportsReasoning !== undefined
        ? { supportsReasoning: candidate.resolvedSupportsReasoning }
        : {}),
    });
  }

  const templateModelId = templateModel.modelId.trim();
  const defaultModel = provider.defaultModel.trim();
  if (defaultModel && !seenModelIds.has(defaultModel)) {
    seenModelIds.add(defaultModel);
    options.push(
      defaultModel === templateModelId
        ? { ...templateModel, modelId: defaultModel }
        : {
            providerId: provider.id,
            providerName: provider.name,
            modelId: defaultModel,
          },
    );
  }

  if (templateModelId && !seenModelIds.has(templateModelId)) {
    options.unshift({ ...templateModel, modelId: templateModelId });
  }
  return options;
}

interface ComposerModelIdentity {
  providerId: string;
  modelId: string;
  candidateModelId?: string | undefined;
}

export function buildComposerMainAgentOverride(input: {
  model: ComposerModelIdentity;
  thinkingEffort: ThinkingEffort | undefined;
  templateModel: ComposerModelOption;
}): MainAgentModelOverride | undefined {
  const { model, thinkingEffort, templateModel } = input;
  const normalizedProviderId = model.providerId.trim();
  const normalizedModelId = model.modelId.trim();
  const normalizedCandidateModelId = model.candidateModelId?.trim();
  const sameAsTemplate =
    normalizedProviderId === templateModel.providerId.trim() &&
    normalizedModelId === templateModel.modelId.trim() &&
    normalizedCandidateModelId === templateModel.candidateModelId?.trim() &&
    thinkingEffort === templateModel.thinkingEffort;
  if (sameAsTemplate) {
    return undefined;
  }
  return {
    providerId: normalizedProviderId,
    modelId: normalizedModelId,
    ...(thinkingEffort ? { thinkingEffort } : {}),
    ...(normalizedCandidateModelId ? { candidateModelId: normalizedCandidateModelId } : {}),
  };
}

export interface ComposerCascadeRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ComposerCascadePlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  overlay: boolean;
}

export function resolveComposerCascadePlacement(input: {
  rootRect: ComposerCascadeRect;
  anchorRect: ComposerCascadeRect;
  viewportWidth: number;
  viewportHeight: number;
  preferredWidth: number;
  estimatedHeight: number;
  margin?: number;
  gap?: number;
}): ComposerCascadePlacement {
  const margin = input.margin ?? 8;
  const gap = input.gap ?? 2;
  const availableWidth = Math.max(160, input.viewportWidth - margin * 2);
  let width = Math.min(input.preferredWidth, availableWidth);
  const rightLeft = input.rootRect.right + gap;
  const leftLeft = input.rootRect.left - gap - width;
  const canOpenRight = rightLeft + width <= input.viewportWidth - margin;
  const canOpenLeft = leftLeft >= margin;
  let overlay = false;
  let left: number;
  if (canOpenRight) {
    left = rightLeft;
  } else if (canOpenLeft) {
    left = leftLeft;
  } else {
    overlay = true;
    width = Math.min(input.rootRect.width, availableWidth);
    left = clamp(input.rootRect.left, margin, input.viewportWidth - margin - width);
  }

  const desiredHeight = Math.min(input.estimatedHeight, input.viewportHeight - margin * 2);
  const maxTop = Math.max(margin, input.viewportHeight - margin - desiredHeight);
  const desiredTop = overlay ? input.rootRect.top : input.anchorRect.top - 6;
  const top = clamp(desiredTop, margin, maxTop);
  return {
    left,
    top,
    width,
    maxHeight: Math.max(72, input.viewportHeight - margin - top),
    overlay,
  };
}

export interface ComposerModelSelectorProps {
  options: readonly ComposerModelOption[];
  templateModel: ComposerModelOption;
  value?: MainAgentModelOverride | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
  onOpen?: (() => void) | undefined;
  onChange: (value: MainAgentModelOverride | undefined) => void;
}

type CascadeMenu = "models" | "efforts";
type FocusSurface = "root" | "submenu";

interface SubmenuLayout {
  style: CSSProperties;
  overlay: boolean;
}

function modelOptionKey(option: ComposerModelOption): string {
  return option.candidateModelId?.trim() || `${option.providerId.trim()}::${option.modelId.trim()}`;
}

export function resolveComposerModelFocusIndex(input: {
  options: readonly ComposerModelOption[];
  focusedKey?: string | undefined;
  selectedKey?: string | undefined;
}): number | undefined {
  if (input.options.length === 0) {
    return undefined;
  }
  const focusedIndex = input.focusedKey
    ? input.options.findIndex((option) => modelOptionKey(option) === input.focusedKey)
    : -1;
  if (focusedIndex >= 0) {
    return focusedIndex;
  }
  const selectedIndex = input.selectedKey
    ? input.options.findIndex((option) => modelOptionKey(option) === input.selectedKey)
    : -1;
  return selectedIndex >= 0 ? selectedIndex : 0;
}

function modelIdentityMatchesOption(identity: ComposerModelIdentity, option: ComposerModelOption): boolean {
  const identityCandidateId = identity.candidateModelId?.trim();
  const optionCandidateId = option.candidateModelId?.trim();
  if (identityCandidateId && optionCandidateId) {
    return identityCandidateId === optionCandidateId;
  }
  return (
    identity.providerId.trim() === option.providerId.trim() &&
    identity.modelId.trim() === option.modelId.trim()
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function domRectValue(rect: DOMRect): ComposerCascadeRect {
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

export function ComposerModelSelector({
  options,
  templateModel,
  value,
  disabled,
  loading,
  error,
  onOpen,
  onChange,
}: ComposerModelSelectorProps) {
  const { t } = useTranslation();
  const rootMenuId = useId();
  const modelMenuId = useId();
  const effortMenuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootPanelRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const submenuBackRef = useRef<HTMLButtonElement>(null);
  const rootButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const modelButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const effortButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusedModelKeyRef = useRef<string | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [activeMenu, setActiveMenu] = useState<CascadeMenu | undefined>(undefined);
  const [focusSurface, setFocusSurface] = useState<FocusSurface>("root");
  const [focusedRootIndex, setFocusedRootIndex] = useState(ROOT_MODEL_INDEX);
  const [focusedModelIndex, setFocusedModelIndex] = useState(0);
  const [focusedEffortIndex, setFocusedEffortIndex] = useState(0);
  const [rootPanelStyle, setRootPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));
  const [submenuLayout, setSubmenuLayout] = useState<SubmenuLayout>(() => ({
    style: { visibility: "hidden" },
    overlay: false,
  }));

  const selectedOption = useMemo(() => {
    const identity = value ?? templateModel;
    return options.find((option) => modelIdentityMatchesOption(identity, option));
  }, [options, templateModel, value]);
  const currentModel = useMemo<ComposerModelOption>(() => {
    if (selectedOption) {
      return selectedOption;
    }
    if (!value) {
      return templateModel;
    }
    return {
      providerId: value.providerId,
      providerName: templateModel.providerName,
      modelId: value.modelId,
      ...(value.candidateModelId ? { candidateModelId: value.candidateModelId } : {}),
      thinkingEffort: value.thinkingEffort,
    };
  }, [selectedOption, templateModel, value]);
  const overrideUsesTemplateModel =
    value?.providerId.trim() === templateModel.providerId.trim() &&
    value?.modelId.trim() === templateModel.modelId.trim();
  const currentEffort =
    value?.thinkingEffort ?? (!value || overrideUsesTemplateModel ? templateModel.thinkingEffort : undefined);
  const currentModelName = formatComposerModelName(currentModel.modelId, currentModel.displayName);
  const currentEffortLabel = formatComposerThinkingEffortLabel(currentEffort);
  const triggerLabel = `${currentModelName} ${currentEffortLabel}`;
  // Hover tooltip shows only the provider name — not the model id — and stays
  // available even when the trigger is disabled.
  const providerName = currentModel.providerName.trim();
  const tooltipLabel = providerName || triggerLabel;
  const currentOverrideMissing = Boolean(value && !selectedOption);
  const selectedModelKey = selectedOption ? modelOptionKey(selectedOption) : undefined;
  const selectedModelIndex = Math.max(
    0,
    options.findIndex((option) => modelOptionKey(option) === selectedModelKey),
  );
  const selectedEffortIndex = Math.max(
    0,
    THINKING_EFFORT_OPTIONS.findIndex((option) => option.value === currentEffort),
  );
  const reasoningUnavailable = currentModel.supportsReasoning === false;
  const rootItemCount = value ? 3 : 2;
  const interactionDisabled = Boolean(disabled);

  const updateRootPanelPosition = useCallback(() => {
    const anchor = triggerRef.current;
    if (!anchor) {
      return;
    }
    setRootPanelStyle(
      composerFloatingStyleForAnchor(anchor, {
        width: 224,
        minHeight: value ? 108 : 76,
        prefer: "above",
      }),
    );
  }, [value]);

  const updateSubmenuPosition = useCallback(() => {
    const rootPanel = rootPanelRef.current;
    const anchorIndex = activeMenu === "models" ? ROOT_MODEL_INDEX : ROOT_EFFORT_INDEX;
    const anchor = rootButtonRefs.current[anchorIndex];
    if (!rootPanel || !anchor || !activeMenu) {
      return;
    }
    const itemCount = activeMenu === "models" ? Math.max(options.length, 1) : THINKING_EFFORT_OPTIONS.length;
    const statusRows =
      activeMenu === "models" && (loading || error || currentOverrideMissing || options.length === 0) ? 1 : 0;
    const placement = resolveComposerCascadePlacement({
      rootRect: domRectValue(rootPanel.getBoundingClientRect()),
      anchorRect: domRectValue(anchor.getBoundingClientRect()),
      viewportWidth: composerFloatingPlacementViewportWidth(),
      viewportHeight: window.innerHeight,
      preferredWidth: activeMenu === "models" ? 280 : 188,
      estimatedHeight: 38 + itemCount * 30 + statusRows * 30,
    });
    setSubmenuLayout({
      style: {
        position: "fixed",
        left: placement.left,
        top: placement.top,
        width: placement.width,
        maxHeight: placement.maxHeight,
        zIndex: 10001,
      },
      overlay: placement.overlay,
    });
  }, [activeMenu, currentOverrideMissing, error, loading, options.length]);

  const closePanel = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setActiveMenu(undefined);
    setFocusSurface("root");
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const focusRootAt = useCallback(
    (index: number, activate = true) => {
      const nextIndex = clamp(index, 0, rootItemCount - 1);
      setFocusedRootIndex(nextIndex);
      setFocusSurface("root");
      if (activate) {
        setActiveMenu(
          nextIndex === ROOT_MODEL_INDEX ? "models" : nextIndex === ROOT_EFFORT_INDEX ? "efforts" : undefined,
        );
      }
      requestAnimationFrame(() => rootButtonRefs.current[nextIndex]?.focus());
    },
    [rootItemCount],
  );

  const focusModelAt = useCallback(
    (index: number) => {
      if (options.length === 0) {
        return;
      }
      const nextIndex = clamp(index, 0, options.length - 1);
      const option = options[nextIndex];
      if (!option) {
        return;
      }
      focusedModelKeyRef.current = modelOptionKey(option);
      setFocusedModelIndex(nextIndex);
      setFocusSurface("submenu");
      requestAnimationFrame(() => modelButtonRefs.current[nextIndex]?.focus());
    },
    [options],
  );

  const focusEffortAt = useCallback(
    (index: number) => {
      const nextIndex = reasoningUnavailable ? 0 : clamp(index, 0, THINKING_EFFORT_OPTIONS.length - 1);
      setFocusedEffortIndex(nextIndex);
      setFocusSurface("submenu");
      requestAnimationFrame(() => effortButtonRefs.current[nextIndex]?.focus());
    },
    [reasoningUnavailable],
  );

  const openSubmenu = useCallback(
    (menu: CascadeMenu, moveFocus: boolean) => {
      setActiveMenu(menu);
      if (!moveFocus) {
        return;
      }
      if (menu === "models") {
        focusModelAt(selectedModelIndex);
      } else {
        focusEffortAt(selectedEffortIndex);
      }
    },
    [focusEffortAt, focusModelAt, selectedEffortIndex, selectedModelIndex],
  );

  const openPanel = useCallback(() => {
    if (interactionDisabled) {
      return;
    }
    onOpen?.();
    setFocusedRootIndex(ROOT_MODEL_INDEX);
    setFocusedModelIndex(selectedModelIndex);
    focusedModelKeyRef.current = options[selectedModelIndex]
      ? modelOptionKey(options[selectedModelIndex])
      : undefined;
    setFocusedEffortIndex(selectedEffortIndex);
    setActiveMenu(undefined);
    setFocusSurface("root");
    setSubmenuLayout({ style: { visibility: "hidden" }, overlay: false });
    updateRootPanelPosition();
    setOpen(true);
  }, [
    interactionDisabled,
    onOpen,
    options,
    selectedEffortIndex,
    selectedModelIndex,
    updateRootPanelPosition,
  ]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const updateViewportPositions = () => {
      updateRootPanelPosition();
      requestAnimationFrame(updateSubmenuPosition);
    };
    updateRootPanelPosition();
    window.addEventListener("resize", updateViewportPositions);
    window.addEventListener("scroll", updateViewportPositions, true);
    return () => {
      window.removeEventListener("resize", updateViewportPositions);
      window.removeEventListener("scroll", updateViewportPositions, true);
    };
  }, [open, updateRootPanelPosition, updateSubmenuPosition]);

  useLayoutEffect(() => {
    if (!open || !activeMenu) {
      return;
    }
    const frame = requestAnimationFrame(updateSubmenuPosition);
    return () => cancelAnimationFrame(frame);
  }, [activeMenu, open, updateSubmenuPosition]);

  useEffect(() => {
    if (!open || focusSurface !== "root") {
      return;
    }
    const frame = requestAnimationFrame(() => rootButtonRefs.current[focusedRootIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusSurface, focusedRootIndex, open]);

  useEffect(() => {
    if (!open || !activeMenu || !submenuLayout.overlay || focusSurface !== "root") {
      return;
    }
    if (activeMenu === "models" && options.length > 0) {
      focusModelAt(selectedModelIndex);
      return;
    }
    if (activeMenu === "efforts") {
      focusEffortAt(selectedEffortIndex);
      return;
    }
    setFocusSurface("submenu");
    const frame = requestAnimationFrame(() => submenuBackRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [
    activeMenu,
    focusEffortAt,
    focusModelAt,
    focusSurface,
    open,
    options.length,
    selectedEffortIndex,
    selectedModelIndex,
    submenuLayout.overlay,
  ]);

  useEffect(() => {
    if (!open || activeMenu !== "models" || focusSurface !== "submenu") {
      return;
    }
    if (options.length === 0) {
      focusedModelKeyRef.current = undefined;
      setFocusedModelIndex(0);
      if (!submenuLayout.overlay) {
        focusRootAt(ROOT_MODEL_INDEX, false);
        return;
      }
      const frame = requestAnimationFrame(() => submenuBackRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    const nextIndex = resolveComposerModelFocusIndex({
      options,
      focusedKey: focusedModelKeyRef.current,
      selectedKey: selectedModelKey,
    });
    if (nextIndex === undefined) {
      return;
    }
    const option = options[nextIndex];
    if (!option) {
      return;
    }
    focusedModelKeyRef.current = modelOptionKey(option);
    setFocusedModelIndex(nextIndex);
    const frame = requestAnimationFrame(() => modelButtonRefs.current[nextIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeMenu, focusRootAt, focusSurface, open, options, selectedModelKey, submenuLayout.overlay]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        rootPanelRef.current?.contains(target) ||
        submenuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      closePanel(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        if (focusSurface === "submenu") {
          const rootIndex = activeMenu === "efforts" ? ROOT_EFFORT_INDEX : ROOT_MODEL_INDEX;
          setActiveMenu(undefined);
          focusRootAt(rootIndex, false);
        } else {
          closePanel(true);
        }
      } else if (event.key === "Tab") {
        closePanel(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeMenu, closePanel, focusRootAt, focusSurface, open]);

  useEffect(() => {
    if (open && interactionDisabled) {
      closePanel(false);
    }
  }, [closePanel, interactionDisabled, open]);

  function commitModel(option: ComposerModelOption) {
    const thinkingEffort = option.supportsReasoning === false ? "off" : currentEffort;
    onChange(buildComposerMainAgentOverride({ model: option, thinkingEffort, templateModel }));
    closePanel(true);
  }

  function commitEffort(thinkingEffort: ThinkingEffort) {
    if (reasoningUnavailable && thinkingEffort !== "off") {
      return;
    }
    onChange(buildComposerMainAgentOverride({ model: currentModel, thinkingEffort, templateModel }));
    closePanel(true);
  }

  function clearOverride() {
    if (!value) {
      return;
    }
    onChange(undefined);
    closePanel(true);
  }

  function handleRootKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRootAt(index === rootItemCount - 1 ? 0 : index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRootAt(index === 0 ? rootItemCount - 1 : index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRootAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRootAt(rootItemCount - 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveMenu(undefined);
    } else if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (index === ROOT_MODEL_INDEX) {
        openSubmenu("models", true);
      } else if (index === ROOT_EFFORT_INDEX) {
        openSubmenu("efforts", true);
      } else {
        clearOverride();
      }
    }
  }

  function handleModelKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
    option: ComposerModelOption,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusModelAt(index === options.length - 1 ? 0 : index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusModelAt(index === 0 ? options.length - 1 : index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusModelAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusModelAt(options.length - 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveMenu(undefined);
      focusRootAt(ROOT_MODEL_INDEX, false);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commitModel(option);
    }
  }

  function handleEffortKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
    thinkingEffort: ThinkingEffort,
    unavailable: boolean,
  ) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusEffortAt(reasoningUnavailable || index === THINKING_EFFORT_OPTIONS.length - 1 ? 0 : index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusEffortAt(reasoningUnavailable ? 0 : index === 0 ? THINKING_EFFORT_OPTIONS.length - 1 : index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusEffortAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusEffortAt(reasoningUnavailable ? 0 : THINKING_EFFORT_OPTIONS.length - 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setActiveMenu(undefined);
      focusRootAt(ROOT_EFFORT_INDEX, false);
    } else if ((event.key === "Enter" || event.key === " ") && !unavailable) {
      event.preventDefault();
      commitEffort(thinkingEffort);
    }
  }

  const submenu = activeMenu ? (
    <div
      id={activeMenu === "models" ? modelMenuId : effortMenuId}
      ref={submenuRef}
      className={`composer-codex-popover composer-model-submenu${submenuLayout.overlay ? " is-overlay" : ""}`}
      role="menu"
      aria-label={activeMenu === "models" ? t("composer.model.model") : t("composer.model.effort")}
      style={submenuLayout.style}
    >
      <div className="composer-model-submenu-header">
        <button
          ref={submenuBackRef}
          type="button"
          className="composer-model-submenu-back"
          aria-label={t("settings.back")}
          onFocus={() => setFocusSurface("submenu")}
          onClick={() => {
            const rootIndex = activeMenu === "models" ? ROOT_MODEL_INDEX : ROOT_EFFORT_INDEX;
            setActiveMenu(undefined);
            focusRootAt(rootIndex, false);
          }}
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
        <span>{activeMenu === "models" ? t("composer.model.model") : t("composer.model.effort")}</span>
      </div>

      {activeMenu === "models" ? (
        <>
          <ul className="composer-model-submenu-list">
            {options.map((option, index) => {
              const key = modelOptionKey(option);
              const selected = key === selectedModelKey;
              return (
                <li key={key}>
                  <button
                    ref={(node) => {
                      modelButtonRefs.current[index] = node;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    tabIndex={focusSurface === "submenu" && focusedModelIndex === index ? 0 : -1}
                    className={
                      selected ? "composer-model-submenu-item is-selected" : "composer-model-submenu-item"
                    }
                    title={`${option.providerName} · ${option.modelId}`}
                    onFocus={() => {
                      focusedModelKeyRef.current = key;
                      setFocusSurface("submenu");
                      setFocusedModelIndex(index);
                    }}
                    onKeyDown={(event) => handleModelKeyDown(event, index, option)}
                    onClick={() => commitModel(option)}
                  >
                    <span>{formatComposerModelName(option.modelId, option.displayName)}</span>
                    {selected ? <Check size={15} strokeWidth={2} aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {loading ? (
            <p className="composer-model-menu-status" role="status">
              {t("composer.model.loading")}
            </p>
          ) : options.length === 0 ? (
            <p className="composer-model-menu-status">{t("composer.model.noCandidates")}</p>
          ) : null}
          {currentOverrideMissing ? (
            <p className="composer-model-menu-status is-warning" role="status">
              {t("composer.model.overrideMissing")}
            </p>
          ) : null}
          {error ? (
            <p className="composer-model-menu-status is-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <ul className="composer-model-submenu-list">
            {THINKING_EFFORT_OPTIONS.map((option, index) => {
              const unavailable = reasoningUnavailable && option.value !== "off";
              const selected = option.value === currentEffort;
              return (
                <li key={option.value}>
                  <button
                    ref={(node) => {
                      effortButtonRefs.current[index] = node;
                    }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    disabled={unavailable}
                    tabIndex={focusSurface === "submenu" && focusedEffortIndex === index ? 0 : -1}
                    className={
                      selected ? "composer-model-submenu-item is-selected" : "composer-model-submenu-item"
                    }
                    onFocus={() => {
                      setFocusSurface("submenu");
                      setFocusedEffortIndex(index);
                    }}
                    onKeyDown={(event) => handleEffortKeyDown(event, index, option.value, unavailable)}
                    onClick={() => commitEffort(option.value)}
                  >
                    <span>{formatComposerThinkingEffortLabel(option.value)}</span>
                    {selected ? <Check size={15} strokeWidth={2} aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {reasoningUnavailable ? (
            <p className="composer-model-menu-status">{t("composer.model.reasoningUnavailable")}</p>
          ) : null}
        </>
      )}
    </div>
  ) : null;

  const popover =
    open &&
    createPortal(
      <>
        <div
          id={rootMenuId}
          ref={rootPanelRef}
          className="composer-codex-popover composer-model-root-menu"
          role="menu"
          aria-label={t("composer.model.settings")}
          style={rootPanelStyle}
        >
          <button
            ref={(node) => {
              rootButtonRefs.current[ROOT_MODEL_INDEX] = node;
            }}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeMenu === "models"}
            aria-controls={modelMenuId}
            tabIndex={focusSurface === "root" && focusedRootIndex === ROOT_MODEL_INDEX ? 0 : -1}
            className={
              activeMenu === "models" ? "composer-model-root-item is-active" : "composer-model-root-item"
            }
            onMouseEnter={() => setActiveMenu("models")}
            onFocus={() => {
              setFocusSurface("root");
              setFocusedRootIndex(ROOT_MODEL_INDEX);
            }}
            onKeyDown={(event) => handleRootKeyDown(event, ROOT_MODEL_INDEX)}
            onClick={() => openSubmenu("models", false)}
          >
            <span className="composer-model-root-label">{t("composer.model.model")}</span>
            <span className="composer-model-root-value" title={currentModelName}>
              {currentModelName}
            </span>
            <ChevronRight size={15} aria-hidden />
          </button>

          <button
            ref={(node) => {
              rootButtonRefs.current[ROOT_EFFORT_INDEX] = node;
            }}
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={activeMenu === "efforts"}
            aria-controls={effortMenuId}
            tabIndex={focusSurface === "root" && focusedRootIndex === ROOT_EFFORT_INDEX ? 0 : -1}
            className={
              activeMenu === "efforts" ? "composer-model-root-item is-active" : "composer-model-root-item"
            }
            onMouseEnter={() => setActiveMenu("efforts")}
            onFocus={() => {
              setFocusSurface("root");
              setFocusedRootIndex(ROOT_EFFORT_INDEX);
            }}
            onKeyDown={(event) => handleRootKeyDown(event, ROOT_EFFORT_INDEX)}
            onClick={() => openSubmenu("efforts", false)}
          >
            <span className="composer-model-root-label">{t("composer.model.effort")}</span>
            <span className="composer-model-root-value">{currentEffortLabel}</span>
            <ChevronRight size={15} aria-hidden />
          </button>

          {value ? (
            <>
              <hr className="composer-model-root-divider" />
              <button
                ref={(node) => {
                  rootButtonRefs.current[ROOT_RESET_INDEX] = node;
                }}
                type="button"
                role="menuitem"
                tabIndex={focusSurface === "root" && focusedRootIndex === ROOT_RESET_INDEX ? 0 : -1}
                className="composer-model-root-item composer-model-reset-item"
                onMouseEnter={() => setActiveMenu(undefined)}
                onFocus={() => {
                  setFocusSurface("root");
                  setFocusedRootIndex(ROOT_RESET_INDEX);
                  setActiveMenu(undefined);
                }}
                onKeyDown={(event) => handleRootKeyDown(event, ROOT_RESET_INDEX)}
                onClick={clearOverride}
              >
                <RotateCcw size={14} aria-hidden />
                <span className="composer-model-root-label">{t("composer.model.restoreDefault")}</span>
              </button>
            </>
          ) : null}
        </div>
        {submenu}
      </>,
      document.body,
    );

  return (
    <ComposerHoverTooltip
      content={tooltipLabel}
      disabled={open}
    >
      <span className="composer-model-selector">
        <button
          ref={triggerRef}
          type="button"
          className={["composer-model-trigger", open ? "is-active" : "", value ? "has-override" : ""]
            .filter(Boolean)
            .join(" ")}
          disabled={interactionDisabled}
          aria-label={t("composer.model.triggerAria", { label: providerName ? `${providerName} · ${triggerLabel}` : triggerLabel })}
          aria-haspopup="menu"
          aria-controls={rootMenuId}
          aria-expanded={open}
          aria-busy={loading || undefined}
          onKeyDown={(event) => {
            if (!open && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              openPanel();
            }
          }}
          onClick={() => {
            if (open) {
              closePanel(false);
            } else {
              openPanel();
            }
          }}
        >
          <ComposerModelLabel
            modelId={currentModel.modelId}
            displayName={currentModel.displayName}
            thinkingEffort={currentEffort}
            size="medium"
            effortAccent={Boolean(value)}
          />
        </button>
        {popover}
      </span>
    </ComposerHoverTooltip>
  );
}
