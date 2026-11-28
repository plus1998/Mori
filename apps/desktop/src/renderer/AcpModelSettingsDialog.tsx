import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AcpModelOption } from "../shared/acp-model-vendor";
import { ModelCascadeSelect } from "./ModelCascadeSelect";
import { createAcpCurrentExtra, mapAcpModelOptions } from "./model-cascade-options";

interface AcpModelSettingsDialogProps {
  models: readonly AcpModelOption[];
  selectedModelId?: string;
  loading?: boolean;
  error?: string;
  busy?: boolean;
  title?: string;
  /** Test-only: pre-fill the search box when the panel opens. */
  initialQuery?: string;
  onChange: (modelId: string | undefined) => void;
  onRefresh?: () => void;
  onClose: () => void;
}

/**
 * Cursor ACP model settings dialog. The model catalogue itself is the
 * unified `ModelCascadeSelect` (vendor → model hierarchy with search).
 */
export function AcpModelSettingsDialog({
  models,
  selectedModelId,
  loading = false,
  error,
  busy,
  title,
  initialQuery = "",
  onChange,
  onRefresh,
  onClose,
}: AcpModelSettingsDialogProps) {
  const { t } = useTranslation();
  const options = useMemo(() => mapAcpModelOptions(models, t), [models, t]);
  const currentExtra = useMemo(
    () => createAcpCurrentExtra(models, t("settings.acpModel.current")),
    [models, t],
  );
  const value = selectedModelId
    ? { key: selectedModelId, providerId: "", modelId: selectedModelId }
    : undefined;

  return (
    <div className="settings-modal-backdrop" onClick={onClose}>
      <div
        className="settings-modal acp-model-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="acp-model-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-modal-header">
          <h2 id="acp-model-settings-title" className="settings-modal-title">
            {title ?? t("settings.acpModel.title")}
          </h2>
        </header>
        <div className="settings-modal-body acp-model-settings-body">
          <ModelCascadeSelect
            inline
            options={options}
            value={value}
            loading={loading}
            error={error}
            disabled={busy}
            clearable
            clearLabel={t("settings.acpModel.default")}
            initialQuery={initialQuery}
            renderExtra={currentExtra}
            onDismiss={onClose}
            onChange={(selection) => onChange(selection?.key ?? undefined)}
          />
        </div>
        <footer className="settings-modal-footer">
          <button type="button" className="settings-modal-cancel" onClick={onClose}>
            {t("common.close")}
          </button>
          <div className="settings-modal-footer-actions">
            {onRefresh ? (
              <button
                type="button"
                className="settings-modal-cancel"
                onClick={onRefresh}
                disabled={busy || loading}
              >
                {t("common.refresh")}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
