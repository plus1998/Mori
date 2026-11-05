import { Switch } from "./components/Switch";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentTemplateCapabilityOption } from "./agent-template-form";
import { parseList, toggleAgentTemplateAdvancedDisallowedTool } from "./agent-template-form";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import {
  diagnoseCoreCapabilities,
  matchesToolCapabilityPreset,
  TOOL_CAPABILITY_PRESETS,
  type ToolCapabilityFieldValues,
} from "./tool-capability-groups";

export interface ToolCapabilityPanelProps {
  values: ToolCapabilityFieldValues;
  disabled?: boolean | undefined;
  capabilityOptions: {
    tools: AgentTemplateCapabilityOption[];
  };
  showDelegation?: boolean;
  showTaskProgress?: boolean;
  showPresets?: boolean;
  onChange: (patch: Partial<ToolCapabilityFieldValues>) => void;
}

export function ToolCapabilityPanel({
  values,
  disabled,
  capabilityOptions,
  showDelegation = true,
  showTaskProgress = true,
  showPresets = true,
  onChange,
}: ToolCapabilityPanelProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const activePresetId = useMemo(
    () => TOOL_CAPABILITY_PRESETS.find((preset) => matchesToolCapabilityPreset(values, preset))?.id,
    [values],
  );
  const advancedDisallowed = parseList(values.advancedDisallowedTools);
  const diagnostics = useMemo(() => diagnoseCoreCapabilities(values), [values]);

  function applyPreset(preset: (typeof TOOL_CAPABILITY_PRESETS)[number]) {
    onChange({
      ...preset.values,
      advancedDisallowedTools: values.advancedDisallowedTools,
      allowDelegation: values.allowDelegation,
    });
  }

  return (
    <div className="models-tool-capability-panel">
      <div className="models-core-capability-grid">
        {diagnostics.map((diagnostic) => (
          <div key={diagnostic.core} className={`models-core-capability-status ${diagnostic.support}`}>
            <div>
              <strong>{diagnostic.core === "claude" ? "Claude Code" : "Codex"}</strong>
              <span>
                {diagnostic.support === "native"
                  ? t("capability.native")
                  : diagnostic.support === "adapted"
                    ? t("capability.adapted")
                    : t("capability.unsupported")}
              </span>
            </div>
            {diagnostic.messages.map((message) => (
              <small key={message}>{message}</small>
            ))}
          </div>
        ))}
      </div>
      {showPresets ? (
        <div className="models-agent-template-preset-grid">
          {TOOL_CAPABILITY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={
                activePresetId === preset.id
                  ? "models-agent-template-preset active"
                  : "models-agent-template-preset"
              }
              disabled={disabled}
              onClick={() => applyPreset(preset)}
              title={preset.hint}
            >
              <span>{preset.label}</span>
              <small>{preset.hint}</small>
            </button>
          ))}
        </div>
      ) : null}

      <div className="models-tool-capability-list">
        <CapabilityToggle
          label={t("capability.read")}
          description={t("capability.readDescription")}
          checked={values.readCodebase}
          disabled={disabled}
          onChange={(readCodebase) => onChange({ readCodebase })}
        />

        {values.readCodebase ? (
          <label className="mcp-field models-tool-capability-subfield">
            <span className="mcp-field-label">{t("capability.readScope")}</span>
            <ComposerFieldSelect
              value={values.readScope}
              disabled={disabled}
              onChange={(readScope) =>
                onChange({
                  readScope: readScope as ToolCapabilityFieldValues["readScope"],
                })
              }
            >
              <option value="workspace">{t("capability.workspace")}</option>
              <option value="extra_dirs">{t("capability.workspaceExtra")}</option>
            </ComposerFieldSelect>
          </label>
        ) : null}

        <CapabilityToggle
          label={t("capability.write")}
          description={t("capability.writeDescription")}
          checked={values.writeCodebase}
          disabled={disabled}
          onChange={(writeCodebase) => onChange({ writeCodebase })}
        />

        <CapabilityToggle
          label={t("capability.bash")}
          description={t("capability.bashDescription")}
          checked={values.bash}
          disabled={disabled}
          onChange={(bash) => onChange({ bash })}
        />
        <CapabilityToggle
          label={t("capability.network")}
          description={t("capability.networkDescription")}
          checked={values.network}
          disabled={disabled}
          onChange={(network) => onChange({ network })}
        />

        {showTaskProgress ? (
          <CapabilityToggle
            label={t("capability.progress")}
            description={t("capability.progressDescription")}
            checked={values.taskProgress}
            disabled={disabled}
            onChange={(taskProgress) => onChange({ taskProgress })}
          />
        ) : null}

        {showDelegation ? (
          <CapabilityToggle
            label={t("capability.delegate")}
            description={t("capability.delegateDescription")}
            checked={values.allowDelegation}
            disabled={disabled}
            onChange={(allowDelegation) => onChange({ allowDelegation })}
          />
        ) : null}

        <CapabilityToggle
          label={t("capability.skill")}
          description={t("capability.skillDescription")}
          checked={values.skill}
          disabled={disabled}
          onChange={(skill) => onChange({ skill })}
        />

        <CapabilityToggle
          label={t("capability.ask")}
          description={t("capability.askDescription")}
          checked={values.askUser}
          disabled={disabled}
          onChange={(askUser) => onChange({ askUser })}
        />
      </div>

      <button
        type="button"
        className="models-tool-capability-advanced-toggle"
        disabled={disabled}
        onClick={() => setAdvancedOpen((open) => !open)}
      >
        {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <span>{t("capability.advanced")}</span>
        {advancedDisallowed.length > 0 ? (
          <small>{t("capability.disabledCount", { count: advancedDisallowed.length })}</small>
        ) : null}
      </button>

      {advancedOpen ? (
        <div className="models-core-overrides">
          <SelectableTokenGroup
            label={t("capability.claudeDisabled")}
            tone="danger"
            options={capabilityOptions.tools}
            selectedValues={advancedDisallowed}
            disabled={disabled}
            emptyText={t("capability.noClaudeTools")}
            onToggle={(value, checked) =>
              onChange({
                advancedDisallowedTools: toggleAgentTemplateAdvancedDisallowedTool(
                  values.advancedDisallowedTools,
                  value,
                  checked,
                ),
              })
            }
          />
          <div className="models-agent-token-group">
            <div className="models-agent-token-group-head">
              <span>{t("capability.codexTightening")}</span>
            </div>
            <CapabilityToggle
              label={t("capability.readOnly")}
              description={t("capability.readOnlyDescription")}
              checked={values.codexSandboxOverride === "read-only"}
              disabled={disabled}
              onChange={(checked) => onChange({ codexSandboxOverride: checked ? "read-only" : "" })}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CapabilityToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="models-agent-template-delegation-card">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <Switch
        title={checked ? t("common.enabled") : t("common.disabled")}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked)}
        aria-label={checked ? t("common.enabled") : t("common.disabled")}
      />
    </div>
  );
}

function SelectableTokenGroup({
  label,
  options,
  selectedValues,
  disabled,
  tone,
  emptyText,
  onToggle,
}: {
  label: string;
  options: AgentTemplateCapabilityOption[];
  selectedValues: string[];
  disabled?: boolean | undefined;
  tone?: "danger" | undefined;
  emptyText?: string;
  onToggle: (value: string, checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const selected = new Set(selectedValues);
  const resolvedEmptyText = emptyText ?? t("capability.empty");
  return (
    <section className="models-agent-token-group">
      <div className="models-agent-token-group-head">
        <span>{label}</span>
        <small>{t("capability.selectedCount", { count: selectedValues.length })}</small>
      </div>
      {options.length === 0 ? (
        <p className="models-agent-token-empty">{resolvedEmptyText}</p>
      ) : (
        <div className="models-agent-token-options">
          {options.map((option) => {
            const active = selected.has(option.value);
            const optionDisabled = disabled || (option.disabled && !active);
            const className = [
              "models-agent-token-option",
              active ? "active" : "",
              tone === "danger" ? "danger" : "",
              optionDisabled ? "is-disabled" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <label key={option.value} className={className} title={option.description ?? option.label}>
                <input
                  type="checkbox"
                  checked={active}
                  disabled={optionDisabled}
                  onChange={(event) => onToggle(option.value, event.target.checked)}
                />
                <span className="models-agent-token-option-label">{option.label}</span>
                <span className="models-agent-token-option-meta">{option.sourceLabel}</span>
              </label>
            );
          })}
        </div>
      )}
    </section>
  );
}
