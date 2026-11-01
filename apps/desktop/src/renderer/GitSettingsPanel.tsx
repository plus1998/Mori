import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import type { GitSettingsSnapshot } from "../shared/ipc";
import { SettingsSyncControl } from "./SettingsSyncControl";

interface GitSettingsPanelProps {
  settings: GitSettingsSnapshot;
  busy?: boolean;
  onSave: (settings: GitSettingsSnapshot) => Promise<void>;
  centerServerSyncVisible?: boolean;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}

export function GitSettingsPanel({
  settings,
  busy,
  onSave,
  centerServerSyncVisible,
  onSyncDomain,
}: GitSettingsPanelProps) {
  const { t } = useTranslation();
  const savedInstructions = settings.commitMessageInstructions ?? "";
  const [draft, setDraft] = useState(savedInstructions);
  const [saving, setSaving] = useState(false);
  const dirty = draft !== savedInstructions;

  useEffect(() => {
    setDraft(savedInstructions);
  }, [savedInstructions]);

  async function handleSave() {
    if (!dirty || saving || busy) {
      return;
    }
    setSaving(true);
    try {
      const trimmed = draft.trim();
      await onSave({
        ...(trimmed ? { commitMessageInstructions: trimmed } : {}),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <header className="settings-page-header">
        <h1>Git</h1>
      </header>

      <section className="settings-section git-settings-section">
        <div className="settings-section-head git-settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.git.instructions")}</span>
            <p className="settings-section-subtitle">{t("settings.git.instructionsSubtitle")}</p>
          </div>
          <div className="git-settings-section-actions">
            <button
              type="button"
              className={dirty ? "settings-primary-button" : "settings-secondary-button"}
              disabled={!dirty || saving || busy}
              onClick={() => void handleSave()}
            >
              {saving ? t("settings.git.saving") : t("common.save")}
            </button>
            {onSyncDomain ? (
              <SettingsSyncControl
                domain="git"
                visible={centerServerSyncVisible ?? false}
                disabled={busy || saving}
                onSync={onSyncDomain}
              />
            ) : null}
          </div>
        </div>

        <textarea
          className="git-settings-instructions-input"
          value={draft}
          placeholder={t("settings.git.placeholder")}
          rows={6}
          disabled={saving || busy}
          onChange={(event) => setDraft(event.target.value)}
        />
      </section>
    </>
  );
}
