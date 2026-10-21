import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

export type ComposerModelEmptyState = "no-provider" | "no-orchestration";

interface ComposerModelEmptyTriggerProps {
  state: ComposerModelEmptyState;
  disabled?: boolean | undefined;
  buttonRef?: RefObject<HTMLButtonElement | null> | undefined;
  onAction: () => void;
}

export function ComposerModelEmptyTrigger({
  state,
  disabled,
  buttonRef,
  onAction,
}: ComposerModelEmptyTriggerProps) {
  const { t } = useTranslation();
  const label =
    state === "no-provider" ? t("composer.model.addProvider") : t("composer.model.selectOrchestration");
  const title =
    state === "no-orchestration" ? t("composer.model.selectOrchestrationHint") : label;

  return (
    <span className="composer-model-selector">
      <button
        ref={buttonRef}
        type="button"
        className="composer-model-trigger is-empty"
        disabled={disabled}
        aria-label={title}
        title={title}
        onClick={onAction}
      >
        <span className="composer-model-empty-label">{label}</span>
      </button>
    </span>
  );
}
