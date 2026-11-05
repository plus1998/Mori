import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react";
import "./settings-row.css";

interface SettingsControlProps {
  "aria-labelledby": string;
  "aria-describedby"?: string;
}

interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  control: (props: SettingsControlProps) => ReactNode;
  stackControlOnNarrow?: boolean;
  className?: string;
}

export function SettingsRow({
  label,
  description,
  control,
  stackControlOnNarrow = false,
  className,
}: SettingsRowProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = description != null ? `${id}-description` : undefined;
  return (
    <li
      className={["settings-ui-row", className].filter(Boolean).join(" ")}
      data-stack-narrow={stackControlOnNarrow}
    >
      <div className="settings-ui-row-main">
        <div className="settings-ui-row-label" id={labelId}>
          {label}
        </div>
        {description != null && (
          <div className="settings-ui-row-description" id={descriptionId}>
            {description}
          </div>
        )}
      </div>
      <div className="settings-ui-row-control">
        {control({ "aria-labelledby": labelId, ...(descriptionId && { "aria-describedby": descriptionId }) })}
      </div>
    </li>
  );
}

export function SettingsGroup({ className, ...props }: ComponentPropsWithoutRef<"ul">) {
  return <ul {...props} className={["settings-ui-group", className].filter(Boolean).join(" ")} />;
}
