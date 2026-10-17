import { useId } from "react";
import { useTranslation } from "react-i18next";
import {
  defaultThemeColorForAgentKey,
  isValidThemeColorHex,
  SUBAGENT_PRESET_THEME_COLORS,
} from "../shared/subagent-theme";

interface AgentThemeColorFieldProps {
  label: string;
  value: string;
  agentKey: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}

export function AgentThemeColorField({
  label,
  value,
  agentKey,
  disabled,
  onChange,
}: AgentThemeColorFieldProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const resolvedValue = value.trim() || defaultThemeColorForAgentKey(agentKey);
  const invalid = value.trim().length > 0 && !isValidThemeColorHex(value);

  return (
    <div className="mcp-field models-agent-theme-color-field">
      <span className="mcp-field-label">{label}</span>
      <div className="models-agent-theme-color-row">
        <div
          className="models-agent-theme-color-swatches"
          role="list"
          aria-label={t("settings.models.node.themeColorPresets", { label })}
        >
          {SUBAGENT_PRESET_THEME_COLORS.map((preset) => {
            const active = resolvedValue.toUpperCase() === preset.toUpperCase();
            return (
              <button
                key={preset}
                type="button"
                role="listitem"
                className={`models-agent-theme-color-swatch${active ? " is-active" : ""}`}
                style={{ backgroundColor: preset }}
                disabled={disabled}
                aria-label={t("settings.models.node.themeColorSelect", { color: preset })}
                aria-pressed={active}
                onClick={() => onChange(preset)}
              />
            );
          })}
        </div>
        <label className="models-agent-theme-color-custom" htmlFor={inputId}>
          <span className="models-agent-theme-color-custom-label">
            {t("settings.models.node.themeColorCustom")}
          </span>
          <input
            id={inputId}
            className={`models-agent-theme-color-input${invalid ? " is-invalid" : ""}`}
            type="color"
            value={
              isValidThemeColorHex(resolvedValue) ? resolvedValue : defaultThemeColorForAgentKey(agentKey)
            }
            disabled={disabled}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
          />
          <input
            className={`mcp-field-input models-agent-theme-color-hex${invalid ? " is-invalid" : ""}`}
            value={value}
            disabled={disabled}
            placeholder="#A78BFA"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      </div>
      {invalid ? (
        <p className="models-agent-theme-color-error">{t("settings.models.node.themeColorInvalid")}</p>
      ) : null}
    </div>
  );
}
