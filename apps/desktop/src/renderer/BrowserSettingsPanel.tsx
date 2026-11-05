import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import "./capability-settings.css";
import { SettingsSelect } from "./components/SettingsControls";
import { SettingsPage, SettingsSection } from "./components/SettingsPage";
import { Switch } from "./components/Switch";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrowserOpenApprovalMode, BrowserSettingsSnapshot } from "../shared/browser";
import { useBrowserIntegrationStatus } from "./browser-state-store";

interface BrowserSettingsPanelProps {
  settings: BrowserSettingsSnapshot;
  onSave: (settings: BrowserSettingsSnapshot) => Promise<void>;
}

const OPEN_APPROVAL_OPTIONS: BrowserOpenApprovalMode[] = ["always_allow", "always_ask"];

export function BrowserSettingsPanel({ settings, onSave }: BrowserSettingsPanelProps) {
  const { t } = useTranslation();
  const browserIntegration = useBrowserIntegrationStatus();
  const [busy, setBusy] = useState(false);

  const unavailable = settings.agentIntegrationEnabled && browserIntegration.available === false;
  const unavailableReason = browserIntegration.unavailableReason ?? t("settings.browser.agentUnknownReason");

  async function save(next: BrowserSettingsSnapshot) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsPage
      className="browser-settings capability-settings-page"
      title={t("settings.browser")}
      description={t("settings.browser.pageDesc")}
    >
      <SettingsGroup>
        <SettingsRow
          label={t("settings.browser.masterTitle")}
          description={t("settings.browser.masterHint")}
          control={(controlProps) => (
            <Switch
              {...controlProps}
              title={t(
                settings.agentIntegrationEnabled ? "composer.enabledNamed" : "composer.disabledNamed",
                {
                  name: t("settings.browser.masterTitle"),
                },
              )}
              checked={settings.agentIntegrationEnabled}
              disabled={busy}
              onCheckedChange={(checked) =>
                void save({
                  ...settings,
                  agentIntegrationEnabled: checked,
                })
              }
            />
          )}
        />
      </SettingsGroup>

      {unavailable ? (
        <p className="browser-settings-error" role="status">
          {t("settings.browser.statusUnavailable", { reason: unavailableReason })}
        </p>
      ) : null}

      {settings.agentIntegrationEnabled ? (
        <SettingsSection title={t("settings.browser.permissions")}>
          <SettingsGroup>
            <SettingsRow
              label={t("settings.browser.openApproval")}
              description={t("settings.browser.openApprovalHint")}
              stackControlOnNarrow
              control={(controlProps) => (
                <label className="browser-settings-select">
                  <span className="sr-only">{t("settings.browser.openApproval")}</span>
                  <SettingsSelect
                    {...controlProps}
                    variant="inline"
                    value={settings.openApprovalMode}
                    disabled={busy}
                    onChange={(event) =>
                      void save({
                        ...settings,
                        openApprovalMode: event.target.value as BrowserOpenApprovalMode,
                      })
                    }
                  >
                    {OPEN_APPROVAL_OPTIONS.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`settings.browser.openApproval.${mode}`)}
                      </option>
                    ))}
                  </SettingsSelect>
                  <ChevronDown
                    size={14}
                    strokeWidth={2}
                    aria-hidden
                    className="browser-settings-select-chevron"
                  />
                </label>
              )}
            />
          </SettingsGroup>
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
