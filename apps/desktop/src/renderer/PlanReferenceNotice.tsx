import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  COMPOSER_REFERENCE_PATTERN,
  composerReferences,
  composerReferenceToken,
  parseComposerReference,
} from "../shared/composer-references";

/** Only a pending execution needs a notice; ordinary plan references stay inline. */
export function PlanReferenceNotice({
  prompt,
  onChange,
  disabled,
}: {
  prompt: string;
  onChange(prompt: string): void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const plans = [
    ...new Map(
      composerReferences(prompt)
        .filter((ref) => ref.kind === "plan" && ref.intent === "execute")
        .map((ref) => [ref.id, ref]),
    ).values(),
  ];
  if (!plans.length) return null;
  return (
    <div className="plan-reference-notices">
      {plans.map((plan) => (
        <div key={plan.id} className="plan-reference-notice">
          <span className="plan-reference-notice-icon" aria-hidden>
            <FileText size={16} />
          </span>
          <span className="plan-reference-notice-label">
            {t("planExecution.willExecute", { title: plan.label })}
          </span>
          <button
            type="button"
            disabled={disabled}
            aria-label={t("planExecution.cancelExecution")}
            title={t("planExecution.cancelExecution")}
            onClick={() =>
              onChange(
                prompt.replace(COMPOSER_REFERENCE_PATTERN, (token, kind: string, value: string) => {
                  const ref = parseComposerReference(kind, value);
                  if (ref?.kind !== "plan" || ref.id !== plan.id) return token;
                  const { intent: _intent, ...reference } = ref;
                  return composerReferenceToken(reference);
                }),
              )
            }
          >
            {t("common.cancel")}
          </button>
        </div>
      ))}
    </div>
  );
}
