import type { ComponentPropsWithoutRef, ReactNode } from "react";
import "./settings-resource-list.css";

export function SettingsResourceList({ className, ...props }: ComponentPropsWithoutRef<"ul">) {
  return <ul {...props} className={["settings-ui-resource-list", className].filter(Boolean).join(" ")} />;
}

interface SettingsResourceRowProps {
  name: string;
  description?: ReactNode;
  metadata?: ReactNode;
  icon?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}

export function SettingsResourceRow({
  name,
  description,
  metadata,
  icon,
  status,
  actions,
}: SettingsResourceRowProps) {
  return (
    <li className="settings-ui-resource-row" data-icon={icon != null}>
      {icon != null && (
        <span className="settings-ui-resource-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <div className="settings-ui-resource-copy">
        <div className="settings-ui-resource-name" title={name}>
          {name}
        </div>
        {description != null && <div className="settings-ui-resource-description">{description}</div>}
        {metadata != null && <div className="settings-ui-resource-meta">{metadata}</div>}
      </div>
      <div className="settings-ui-resource-actions">
        {status}
        {actions}
      </div>
    </li>
  );
}
