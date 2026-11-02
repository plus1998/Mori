import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import { SettingsSyncControl } from "./SettingsSyncControl";

interface AcpApiKeySettingsDialogProps {
  /** Currently saved API key (empty/undefined = not set). */
  currentKey?: string;
  busy?: boolean | undefined;
  title?: string;
  centerServerSyncVisible?: boolean;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
  onVaultRefresh?: (() => void) | undefined;
  onSave: (apiKey: string | undefined) => void;
  onClose: () => void;
}

export function AcpApiKeySettingsDialog({
  currentKey,
  busy,
  title,
  centerServerSyncVisible = false,
  onSyncDomain,
  onVaultRefresh,
  onSave,
  onClose,
}: AcpApiKeySettingsDialogProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(currentKey ?? "");

  useEffect(() => {
    setDraft(currentKey ?? "");
  }, [currentKey]);

  const commit = () => {
    const next = draft.trim();
    onSave(next ? next : undefined);
    onClose();
  };

  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <div
        className="settings-modal acp-api-key-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="acp-api-key-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-modal-header settings-modal-header-with-action">
          <h2 id="acp-api-key-settings-title" className="settings-modal-title">
            {title ?? t("settings.defaultAgent.cursorApiKey")}
          </h2>
          {onSyncDomain ? (
            <SettingsSyncControl
              domain="defaultAgent"
              visible={centerServerSyncVisible}
              disabled={busy}
              onSync={onSyncDomain}
              onVaultRefresh={onVaultRefresh}
            />
          ) : null}
        </header>
        <div className="settings-modal-body">
          <div className="settings-field">
            <label htmlFor="acp-cursor-api-key">{t("settings.defaultAgent.cursorApiKey")}</label>
            <input
              id="acp-cursor-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              placeholder={t("settings.defaultAgent.cursorApiKeyPlaceholder")}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (!busy) commit();
                }
              }}
            />
            <span className="settings-field-hint">{t("settings.defaultAgent.cursorApiKeyHint")}</span>
          </div>
        </div>
        <footer className="settings-modal-footer">
          <button type="button" className="settings-modal-cancel" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="settings-modal-confirm"
            onClick={commit}
            disabled={busy || draft.trim() === (currentKey?.trim() ?? "")}
          >
            {t("common.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
