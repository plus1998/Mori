import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  COMPOSER_REFERENCE_PATTERN,
  composerReferences,
  composerReferenceToken,
  parseComposerReference,
} from "../shared/composer-references";

/** Execution is an explicit, draft-persisted choice. A plain @plan can still be discussed. */
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
        .filter((ref) => ref.kind === "plan")
        .map((ref) => [ref.id, ref]),
    ).values(),
  ];
  if (!plans.length) return null;
  return (
    <div className="plan-reference-notices">
      {plans.map((plan) => (
        <div key={plan.id} className="plan-reference-notice">
          <FileText size={14} aria-hidden />
          <span>
            {t(plan.intent === "execute" ? "planExecution.willExecute" : "planExecution.referenceOnly", {
              title: plan.label,
            })}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              onChange(
                prompt.replace(COMPOSER_REFERENCE_PATTERN, (token, kind: string, value: string) => {
                  const ref = parseComposerReference(kind, value);
                  if (ref?.kind !== "plan" || ref.id !== plan.id) return token;
                  const { intent: _intent, ...reference } = ref;
                  return composerReferenceToken({
                    ...reference,
                    ...(plan.intent === "execute" ? {} : { intent: "execute" as const }),
                  });
                }),
              )
            }
          >
            {t(plan.intent === "execute" ? "planExecution.useAsReference" : "planExecution.executeHere")}
          </button>
        </div>
      ))}
    </div>
  );
}
