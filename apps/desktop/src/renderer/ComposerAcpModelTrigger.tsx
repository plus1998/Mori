import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CursorApiKeyView } from "../shared/ipc";
import type { AcpModelOption } from "../shared/acp-model-vendor";
import { ModelCascadeSelect } from "./ModelCascadeSelect";
import { createAcpCurrentExtra, mapAcpModelOptions, resolveAcpVendorNames } from "./model-cascade-options";

export interface ComposerAcpModelTriggerProps {
  models: readonly AcpModelOption[];
  selectedModelId?: string;
  disabled?: boolean;
  readOnly?: boolean;
  loading?: boolean;
  error?: string;
  onOpen?: () => void;
  accounts?: readonly CursorApiKeyView[];
  selectedAccountId?: string | undefined;
  accountReadOnly?: boolean;
  onAccountChange?: (accountId: string | undefined) => void;
  onChange: (modelId: string | undefined) => void;
  panelZIndex?: number | undefined;
}

/**
 * Fixed popover height so switching vendors does not resize the panel —
 * longer model lists scroll within the columns instead.
 */
const PANEL_FIXED_HEIGHT = 360;

/**
 * Cursor ACP model selection in the composer. Built on the unified
 * `ModelCascadeSelect` so it keeps the vendor → model hierarchy and search
 * instead of a flat model list.
 */
export function ComposerAcpModelTrigger({
  models,
  selectedModelId,
  disabled,
  readOnly,
  loading,
  error,
  onOpen,
  accounts,
  selectedAccountId,
  accountReadOnly,
  onAccountChange,
  onChange,
  panelZIndex,
}: ComposerAcpModelTriggerProps) {
  const { t } = useTranslation();
  const vendorNames = useMemo(() => resolveAcpVendorNames(t), [t]);
  const options = useMemo(() => mapAcpModelOptions(models, vendorNames), [models, vendorNames]);
  const currentExtra = useMemo(
    () => createAcpCurrentExtra(models, t("settings.acpModel.current")),
    [models, t],
  );
  const value = selectedModelId
    ? { key: selectedModelId, providerId: "", modelId: selectedModelId }
    : undefined;
  const selectedModel = models.find((model) => model.id === selectedModelId);

  return (
    <span className="composer-model-selector">
      <ModelCascadeSelect
        options={options}
        value={value}
        loading={loading}
        error={error}
        disabled={disabled}
        readOnly={readOnly}
        clearable
        clearLabel={t("settings.acpModel.default")}
        placeholder={selectedModel?.displayName ?? t("settings.acpModel.default")}
        hint={t("settings.acpModel.defaultHint")}
        triggerClassName="composer-model-trigger composer-acp-model-trigger"
        fixedHeight={PANEL_FIXED_HEIGHT}
        panelZIndex={panelZIndex}
        onOpen={onOpen}
        panelFooter={onAccountChange && (accounts?.length || selectedAccountId) ? (
          <label className="mcp-field" style={{ padding: "8px 12px" }}>
            <span className="mcp-field-label">{t("settings.cursorApiKeys.title")}</span>
            <select className="mcp-field-input" disabled={disabled || accountReadOnly} value={selectedAccountId ?? ""}
              onChange={(event) => onAccountChange(event.target.value || undefined)}>
              <option value="">{t("settings.cursorApiKeys.autoAccount")}</option>
              {(accounts ?? []).map((account) => (
                <option key={account.id} value={account.id} disabled={!account.enabled || account.oauthExpiresAt === 0}>{account.name}</option>
              ))}
              {selectedAccountId && !accounts?.some((account) => account.id === selectedAccountId) ? (
                <option value={selectedAccountId} disabled>{t("settings.cursorApiKeys.unavailableAccount")}</option>
              ) : null}
            </select>
          </label>
        ) : undefined}
        renderExtra={currentExtra}
        onChange={(selection) => onChange(selection?.key ?? undefined)}
      />
    </span>
  );
}
