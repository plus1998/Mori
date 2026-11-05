import "./capability-settings.css";
import { SettingsPage } from "./components/SettingsPage";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import type {
  IntegratedWebSearchSettingsSaveInput,
  IntegratedWebSearchSettingsSnapshot,
} from "../shared/ipc";
import { IntegratedWebSearchSettingsSection } from "./IntegratedWebSearchSettingsSection";
import { SettingsSyncControl } from "./SettingsSyncControl";

interface IntegratedWebSearchSettingsPanelProps {
  settings: IntegratedWebSearchSettingsSnapshot;
  busy?: boolean | undefined;
  onSave: (input: IntegratedWebSearchSettingsSaveInput) => void;
  centerServerSyncVisible?: boolean;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}

export function IntegratedWebSearchSettingsPanel({
  settings,
  busy,
  onSave,
  centerServerSyncVisible = false,
  onSyncDomain,
}: IntegratedWebSearchSettingsPanelProps) {
  const { t } = useTranslation();

  return (
    <SettingsPage
      className="capability-settings-page"
      title={t("settings.integratedWebSearch.title")}
      description={t("settings.integratedWebSearch.pageDesc")}
      actions={
        <>
          {onSyncDomain ? (
            <SettingsSyncControl
              domain="proxyBridge"
              visible={centerServerSyncVisible}
              disabled={busy}
              onSync={onSyncDomain}
            />
          ) : null}
        </>
      }
    >
      <IntegratedWebSearchSettingsSection settings={settings} disabled={busy} onSave={onSave} />
    </SettingsPage>
  );
}
