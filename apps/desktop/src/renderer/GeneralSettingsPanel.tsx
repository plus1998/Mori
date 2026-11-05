import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppTheme } from "./theme";
import { SettingsGroup, SettingsRow } from "./components/SettingsRow";
import {
  CODE_FONT_SIZE_RANGE,
  type TypographyPreferences,
  UI_FONT_SIZE_RANGE,
} from "./typography-preferences";
import "./appearance-settings.css";
import "./settings-form-pages.css";

interface GeneralSettingsPanelProps {
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
  typography: TypographyPreferences;
  onTypographyChange: (preferences: TypographyPreferences) => void;
}

interface FontSizeControlProps {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function FontSizeControl({ label, description, value, min, max, onChange }: FontSizeControlProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  function commit(raw: string) {
    const next = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(next) || next < min || next > max) {
      setDraft(String(value));
      return;
    }
    setDraft(String(next));
    if (next !== value) onChange(next);
  }

  return (
    <SettingsRow
      className="appearance-font-row"
      label={label}
      description={description}
      control={(controlProps) => (
        <span className="appearance-font-size-control">
          <input
            {...controlProps}
            type="number"
            className="appearance-font-size-input"
            min={min}
            max={max}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => commit(event.currentTarget.value)}
            onPointerUp={(event) => commit(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(event.currentTarget.value);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft(String(value));
              }
            }}
          />
          <span>px</span>
        </span>
      )}
    />
  );
}

// Mori window illustration, using Codex's 80 × 60 preview proportions and
// light/dark surface palette. No product logo is embedded in the preview.
function ThemePreview({ dark = false }: { dark?: boolean }) {
  const ink = dark ? "#ffffff" : "#0d0d0d";
  return (
    <svg viewBox="0 0 80 60" fill="none" aria-hidden="true" focusable="false">
      <rect width="80" height="60" rx="8" fill={dark ? "#262626" : "#f4f4f4"} />
      <rect x="8" y="8" width="64" height="44" rx="4" fill={dark ? "#0d0d0d" : "#ffffff"} />
      <rect x="8" y="8" width="12" height="44" rx="4" fill={ink} opacity={dark ? ".2" : ".03"} />
      <rect x="24" y="18" width="30" height="2" rx="1" fill={ink} opacity={dark ? ".3" : ".1"} />
      <rect x="24" y="22" width="18" height="2" rx="1" fill={ink} opacity={dark ? ".3" : ".1"} />
      <rect x="24" y="26" width="36" height="2" rx="1" fill={ink} opacity={dark ? ".3" : ".1"} />
      <rect x="38" y="12" width="30" height="2" rx="1" fill={ink} opacity=".65" />
      <rect x="29" y="32" width="39" height="2" rx="1" fill={ink} opacity=".65" />
      <rect x="45" y="36" width="23" height="2" rx="1" fill={ink} opacity=".65" />
      <rect x="24" y="42" width="44" height="6" rx="3" stroke={ink} strokeOpacity={dark ? ".3" : ".1"} />
      <circle cx="65" cy="45" r="2" fill={ink} opacity=".65" />
    </svg>
  );
}

export function GeneralSettingsPanel({
  theme,
  onThemeChange,
  typography,
  onTypographyChange,
}: GeneralSettingsPanelProps) {
  const { t } = useTranslation();
  const themeOptions = [
    { id: "system" as const, label: t("common.system") },
    { id: "light" as const, label: t("settings.theme.light") },
    { id: "dark" as const, label: t("settings.theme.dark") },
  ];
  const themeGroup = useId();

  return (
    <div className="appearance-settings settings-form-page">
      <header className="settings-page-header">
        <h1>{t("settings.general")}</h1>
      </header>

      <section className="settings-section">
        <SettingsGroup>
          <SettingsRow
            className="appearance-theme-row"
            label={t("settings.theme")}
            description={t("settings.themeSubtitle")}
            stackControlOnNarrow
            control={(controlProps) => (
              <div {...controlProps} className="appearance-mode-picker" role="radiogroup">
                {themeOptions.map((option) => (
                  <label className="appearance-mode-option" key={option.id} title={option.label}>
                    <input
                      type="radio"
                      name={themeGroup}
                      value={option.id}
                      aria-label={option.label}
                      checked={theme === option.id}
                      onChange={() => onThemeChange(option.id)}
                    />
                    <span className={`appearance-mode-preview${option.id === "system" ? " is-system" : ""}`}>
                      <ThemePreview dark={option.id === "dark"} />
                      {option.id === "system" && <ThemePreview dark />}
                    </span>
                    <span className="appearance-mode-label">{option.label}</span>
                  </label>
                ))}
              </div>
            )}
          />
        </SettingsGroup>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <span className="settings-section-label">{t("settings.fonts")}</span>
            <p className="settings-section-subtitle">{t("settings.fontsSubtitle")}</p>
          </div>
        </div>

        <SettingsGroup>
          <FontSizeControl
            label={t("settings.uiFontSize")}
            description={t("settings.uiFontDescription")}
            value={typography.uiFontSize}
            min={UI_FONT_SIZE_RANGE.min}
            max={UI_FONT_SIZE_RANGE.max}
            onChange={(uiFontSize) => onTypographyChange({ ...typography, uiFontSize })}
          />
          <FontSizeControl
            label={t("settings.codeFontSize")}
            description={t("settings.codeFontDescription")}
            value={typography.codeFontSize}
            min={CODE_FONT_SIZE_RANGE.min}
            max={CODE_FONT_SIZE_RANGE.max}
            onChange={(codeFontSize) => onTypographyChange({ ...typography, codeFontSize })}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
