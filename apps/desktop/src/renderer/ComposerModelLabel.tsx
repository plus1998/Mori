import type { Ref } from "react";
import type { ThinkingEffort } from "../shared/ipc";
import { formatModelDisplayName } from "../shared/model-id";
import { i18n } from "./i18n";

const THINKING_EFFORT_KEYS: Record<ThinkingEffort, string> = {
  off: "settings.models.effort.off",
  low: "settings.models.effort.low",
  medium: "settings.models.effort.medium",
  high: "settings.models.effort.high",
  xhigh: "settings.models.effort.xhigh",
  max: "composer.model.effort.max",
};

export type ComposerModelLabelSize = "small" | "medium";

export interface ComposerModelLabelProps {
  modelId: string;
  displayName?: string | undefined;
  thinkingEffort?: ThinkingEffort | undefined;
  size: ComposerModelLabelSize;
  effortAccent?: boolean | undefined;
  nameRef?: Ref<HTMLSpanElement> | undefined;
}

export function ComposerModelLabel({
  modelId,
  displayName,
  thinkingEffort,
  size,
  effortAccent,
  nameRef,
}: ComposerModelLabelProps) {
  const modelName = formatComposerModelName(modelId, displayName);
  const effortLabel = formatComposerThinkingEffortLabel(thinkingEffort);
  return (
    <span className={`composer-model-label is-${size}`}>
      <span ref={nameRef} className="composer-model-label-name">
        {modelName}
      </span>
      <span
        className={effortAccent ? "composer-model-label-effort is-accent" : "composer-model-label-effort"}
      >
        {effortLabel}
      </span>
    </span>
  );
}

export function formatComposerModelName(modelId: string, displayName?: string): string {
  const preferred = displayName?.trim();
  if (preferred) {
    return preferred;
  }
  const formatted = formatModelDisplayName(modelId);
  return formatted.length > 24 ? `${formatted.slice(0, 12)}…${formatted.slice(-9)}` : formatted;
}

export function formatComposerThinkingEffortLabel(effort: ThinkingEffort | undefined): string {
  return effort ? i18n.t(THINKING_EFFORT_KEYS[effort]) : i18n.t("common.default");
}
