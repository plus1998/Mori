import { Switch } from "./components/Switch";
import { ChevronRight, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentTemplate, ProviderConfigView, ThinkingEffort } from "../shared/ipc";
import { defaultThemeColorForAgentKey } from "../shared/subagent-theme";
import type { AgentResourceAgentFormState } from "./agent-resource-form";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { formatComposerThinkingEffortLabel } from "./ComposerModelLabel";

interface SubagentOrchestrationRosterEditorProps {
  agents: AgentResourceAgentFormState[];
  templates: readonly AgentTemplate[];
  providers: readonly ProviderConfigView[];
  busy?: boolean | undefined;
  selectedAgentKey?: string | undefined;
  onAddAgent: (templateId: string) => void;
  onRemoveAgent: (index: number) => void;
  onEditAgent: (agentKey: string) => void;
  onToggleEnabled: (index: number, enabled: boolean) => void;
}

export function SubagentOrchestrationRosterEditor({
  agents,
  templates,
  providers,
  busy,
  selectedAgentKey,
  onAddAgent,
  onRemoveAgent,
  onEditAgent,
  onToggleEnabled,
}: SubagentOrchestrationRosterEditorProps) {
  const { t } = useTranslation();
  const [pendingTemplateId, setPendingTemplateId] = useState("");

  const rosterTemplateIds = useMemo(() => new Set(agents.map((agent) => agent.templateId)), [agents]);

  const addableTemplates = useMemo(
    () => templates.filter((template) => !rosterTemplateIds.has(template.id)),
    [rosterTemplateIds, templates],
  );

  function handleAddAgent() {
    if (!pendingTemplateId || busy) {
      return;
    }
    onAddAgent(pendingTemplateId);
    setPendingTemplateId("");
  }

  return (
    <section className="orchestration-roster" aria-label={t("settings.models.editor.rosterAria")}>
      <header className="orchestration-roster-header">
        <div className="orchestration-roster-header-copy">
          <h3 className="orchestration-roster-title">{t("settings.models.editor.rosterLabel")}</h3>
          <p className="orchestration-roster-subtitle">{t("settings.models.editor.rosterSubtitle")}</p>
        </div>
        <span
          className="orchestration-roster-count"
          aria-label={t("settings.models.editor.rosterCountAria", { count: agents.length })}
        >
          {agents.length}
        </span>
      </header>

      <div className="orchestration-roster-add-bar">
        <label className="orchestration-roster-add-field">
          <span className="orchestration-roster-add-label">{t("settings.models.editor.rosterAddLabel")}</span>
          <ComposerFieldSelect
            value={pendingTemplateId}
            disabled={busy || addableTemplates.length === 0}
            showPlaceholder
            placeholder={
              addableTemplates.length === 0
                ? t("settings.models.editor.rosterAllAdded")
                : t("settings.models.editor.rosterSelectPlaceholder")
            }
            title={t("settings.models.editor.rosterSelectAria")}
            searchable={addableTemplates.length > 0}
            searchPlaceholder={t("composer.fieldSelect.searchSubagent")}
            onChange={setPendingTemplateId}
          >
            {addableTemplates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </ComposerFieldSelect>
        </label>
        <button
          type="button"
          className="mcp-add-button orchestration-roster-add-button"
          disabled={busy || !pendingTemplateId}
          onClick={handleAddAgent}
        >
          <Plus size={16} strokeWidth={2.25} />
          {t("settings.models.editor.rosterAddButton")}
        </button>
      </div>

      {agents.length === 0 ? (
        <div className="orchestration-roster-empty-state" role="status">
          <span className="orchestration-roster-empty-icon" aria-hidden>
            <Users size={22} strokeWidth={1.75} />
          </span>
          <p className="orchestration-roster-empty-title">{t("settings.models.editor.rosterEmptyTitle")}</p>
          <p className="orchestration-roster-empty-copy">{t("settings.models.editor.rosterEmptyCopy")}</p>
        </div>
      ) : (
        <ul className="orchestration-roster-group">
          {agents.map((agent, index) => {
            const template = templates.find((entry) => entry.id === agent.templateId);
            const provider = providers.find((entry) => entry.id === agent.providerId);
            const displayName = agent.displayName.trim() || template?.name || agent.agentKey;
            const themeColor = agent.themeColor.trim() || defaultThemeColorForAgentKey(agent.agentKey);
            const modelLabel = agent.modelId
              ? `${provider?.name ?? agent.providerId} / ${agent.modelId}`
              : t("settings.models.editor.rosterNoModel");
            const thinkingEffort = isThinkingEffort(agent.thinkingEffort) ? agent.thinkingEffort : undefined;
            const thinkingEffortLabel =
              agent.modelId && thinkingEffort ? formatComposerThinkingEffortLabel(thinkingEffort) : "";
            const modelMetaLabel = thinkingEffortLabel
              ? `${modelLabel} · ${thinkingEffortLabel}`
              : modelLabel;
            return (
              <li
                key={agent.agentKey}
                className={`orchestration-roster-row${agent.enabled ? "" : " is-disabled"}${
                  selectedAgentKey === agent.agentKey ? " is-selected" : ""
                }`}
                style={{ ["--orchestration-roster-accent" as string]: themeColor }}
              >
                <button
                  type="button"
                  className="orchestration-roster-row-hit"
                  disabled={busy}
                  onClick={() => onEditAgent(agent.agentKey)}
                  aria-label={t("settings.models.editor.editAria", { name: displayName })}
                  aria-current={selectedAgentKey === agent.agentKey ? "true" : undefined}
                >
                  <span className="orchestration-roster-avatar" aria-hidden>
                    {displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="orchestration-roster-row-body">
                    <span className="orchestration-roster-row-top">
                      <span className="orchestration-roster-row-name">{displayName}</span>
                      <span className="orchestration-roster-status">
                        {agent.enabled
                          ? t("settings.models.editor.rosterEnabled")
                          : t("settings.models.editor.rosterDisabled")}
                      </span>
                    </span>
                    <span className="orchestration-roster-row-meta">{modelMetaLabel}</span>
                    <span className="orchestration-roster-row-foot">
                      <span className="orchestration-roster-key">{agent.agentKey}</span>
                    </span>
                  </span>
                  <ChevronRight size={16} className="orchestration-roster-chevron" aria-hidden />
                </button>
                <div className="orchestration-roster-row-controls">
                  <Switch
                    size="sm"
                    title={
                      agent.enabled
                        ? t("settings.models.editor.rosterToggleEnabled")
                        : t("settings.models.editor.rosterToggleDisabled")
                    }
                    onClick={(event) => event.stopPropagation()}
                    checked={agent.enabled}
                    disabled={busy}
                    onCheckedChange={(checked) => onToggleEnabled(index, checked)}
                    aria-label={
                      agent.enabled
                        ? t("settings.models.editor.rosterToggleEnabled")
                        : t("settings.models.editor.rosterToggleDisabled")
                    }
                  />
                  <button
                    type="button"
                    className="mcp-icon-button danger orchestration-roster-remove"
                    disabled={busy}
                    onClick={() => onRemoveAgent(index)}
                    aria-label={t("settings.models.editor.rosterRemoveAria", { name: displayName })}
                    title={t("settings.models.editor.rosterRemoveTitle", { name: displayName })}
                  >
                    <Trash2 size={17} strokeWidth={2} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function isThinkingEffort(value: string): value is ThinkingEffort {
  return (
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  );
}
