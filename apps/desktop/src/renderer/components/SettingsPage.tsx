import type { ReactNode } from "react";
import "./settings-page.css";

interface SettingsPageProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function SettingsPage({ title, description, actions, className, children }: SettingsPageProps) {
  return (
    <div className={["settings-ui-page", className].filter(Boolean).join(" ")}>
      <header className="settings-ui-page-header">
        <div className="settings-ui-page-heading">
          <h1>{title}</h1>
          {description != null && <div className="settings-ui-page-description">{description}</div>}
        </div>
        {actions != null && <div className="settings-ui-page-actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function SettingsSection({ title, description, actions, className, children }: SettingsPageProps) {
  return (
    <section className={["settings-ui-section", className].filter(Boolean).join(" ")}>
      <header className="settings-ui-section-header" data-description={description != null}>
        <div>
          <h2>{title}</h2>
          {description != null && <div className="settings-ui-section-description">{description}</div>}
        </div>
        {actions != null && <div className="settings-ui-section-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
