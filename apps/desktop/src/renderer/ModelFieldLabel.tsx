import { CircleHelp } from "lucide-react";
import { ComposerHoverTooltip } from "./ComposerHoverTooltip";

export function ModelFieldLabel({
  label,
  hint,
  className,
}: {
  label: string;
  hint: string;
  className: string;
}) {
  return (
    <span className={`${className} model-field-label`}>
      <span>{label}</span>
      <ComposerHoverTooltip content={hint}>
        <button type="button" className="model-field-help" aria-label={hint}>
          <CircleHelp size={13} strokeWidth={1.6} aria-hidden />
        </button>
      </ComposerHoverTooltip>
    </span>
  );
}
