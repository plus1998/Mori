import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type MainAgentPromptResource,
  resolveAgentTemplateCatalog,
  type SubagentOrchestrationResource,
} from "../shared/agent-orchestration";
import type { McpServerConfigView, ModelRef, ModelSettingsSnapshot } from "../shared/ipc";
import {
  type AgentCompositionEditorMode,
  type AgentCompositionEditorScope,
  AgentResourceEditorModal,
} from "./agent-resource-editor-modal";
import {
  type AgentResourceFormState,
  buildMainAgentPromptFromForm,
  buildSubagentOrchestrationFromForm,
  createBlankMainAgentPromptForm,
  createBlankSubagentOrchestrationForm,
  createCopiedMainAgentPromptForm,
  createCopiedSubagentOrchestrationForm,
  mainAgentPromptToForm,
  subagentOrchestrationToForm,
} from "./agent-resource-form";

interface AgentCompositionResourcesSectionProps {
  settings: ModelSettingsSnapshot;
  mainModel?: ModelRef | undefined;
  mcpServers?: McpServerConfigView[] | undefined;
  busy?: boolean | undefined;
  activeScope: AgentCompositionEditorScope;
  onRegistryChange: () => Promise<void> | void;
  onSavingChange?: ((saving: boolean) => void) | undefined;
  onErrorMessage?: ((message: string) => void) | undefined;
}

interface CompositionEditorSession {
  scope: AgentCompositionEditorScope;
  mode: AgentCompositionEditorMode;
  form: AgentResourceFormState;
}

export function AgentCompositionResourcesSection({
  settings,
  mainModel,
  mcpServers = [],
  busy = false,
  activeScope,
  onRegistryChange,
  onSavingChange,
  onErrorMessage,
}: AgentCompositionResourcesSectionProps) {
  const [error, setError] = useState("");
  const [editorSession, setEditorSession] = useState<CompositionEditorSession>();
  const { t } = useTranslation();

  const clearError = useCallback(() => {
    setError("");
  }, []);

  const handleAsyncOperation = useCallback(
    async (operation: () => Promise<unknown>) => {
      if (!window.eco) {
        return;
      }
      onSavingChange?.(true);
      clearError();
      try {
        await operation();
        await Promise.resolve(onRegistryChange());
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        if (onErrorMessage) {
          onErrorMessage(message);
        } else {
          setError(message);
        }
      } finally {
        onSavingChange?.(false);
      }
    },
    [onErrorMessage, onRegistryChange, onSavingChange, clearError],
  );

  const mainAgentPrompts = settings.mainAgentPrompts ?? [];
  const subagentOrchestrations = settings.subagentOrchestrations ?? [];

  const templates = useMemo(
    () => resolveAgentTemplateCatalog(settings.agentTemplates),
    [settings.agentTemplates],
  );

  const formOptions = useMemo(
    () => ({
      providers: settings.providers.filter((provider) => provider.apiCompat !== "system_one"),
      templates,
      existingIds: [
        ...mainAgentPrompts.map((entry) => entry.id),
        ...subagentOrchestrations.map((entry) => entry.id),
      ],
      existingNames: [
        ...mainAgentPrompts.map((entry) => entry.name),
        ...subagentOrchestrations.map((entry) => entry.name),
      ],
    }),
    [mainAgentPrompts, settings.providers, subagentOrchestrations, templates],
  );

  const userMainPrompts = useMemo(
    () =>
      mainAgentPrompts.filter((prompt) => prompt.mode === "custom_append" && prompt.source !== "built_in"),
    [mainAgentPrompts],
  );

  const userSubagentOrchestrationResources = useMemo(
    () => subagentOrchestrations.filter((orchestration) => orchestration.source !== "built_in"),
    [subagentOrchestrations],
  );

  const openCreateEditor = useCallback(
    (scope: AgentCompositionEditorScope) => {
      clearError();
      const form =
        scope === "prompt"
            ? createBlankMainAgentPromptForm(formOptions)
            : createBlankSubagentOrchestrationForm(formOptions);
      setEditorSession({ scope, mode: "create", form });
    },
    [clearError, formOptions],
  );

  const openEditEditor = useCallback(
    (
      scope: AgentCompositionEditorScope,
      resource: MainAgentPromptResource | SubagentOrchestrationResource,
    ) => {
      clearError();
      const form =
        scope === "prompt"
            ? mainAgentPromptToForm(resource as MainAgentPromptResource)
            : subagentOrchestrationToForm(resource as SubagentOrchestrationResource, templates);
      setEditorSession({ scope, mode: "edit", form });
    },
    [clearError, templates],
  );

  const saveEditorSession = useCallback(async () => {
    if (!editorSession) {
      return;
    }
    const { scope, form } = editorSession;
    await handleAsyncOperation(async () => {
      if (scope === "prompt") {
        const existing = mainAgentPrompts.find((entry) => entry.id === form.id);
        const prompt = buildMainAgentPromptFromForm(form, existing ? { existing } : {});
        await window.eco!.saveMainAgentPrompt(prompt);
      } else {
        const existing = subagentOrchestrations.find((entry) => entry.id === form.id);
        const orchestration = buildSubagentOrchestrationFromForm(form, {
          ...(existing ? { existing } : {}),
          templates,
        });
        await window.eco!.saveSubagentOrchestration(orchestration);
      }
      setEditorSession(undefined);
    });
  }, [
    editorSession,
    handleAsyncOperation,
    mainAgentPrompts,
    subagentOrchestrations,
    templates,
  ]);

  const handleCopyMainPrompt = useCallback(
    async (prompt: MainAgentPromptResource) => {
      const copied = buildMainAgentPromptFromForm(createCopiedMainAgentPromptForm(prompt, formOptions));
      await handleAsyncOperation(() => window.eco!.saveMainAgentPrompt(copied));
    },
    [formOptions, handleAsyncOperation],
  );

  const handleDeleteMainPrompt = useCallback(
    async (prompt: MainAgentPromptResource) => {
      if (!window.confirm(t("settings.models.resources.confirmDeletePrompt", { name: prompt.name }))) {
        return;
      }
      await handleAsyncOperation(() => window.eco!.deleteMainAgentPrompt(prompt.id));
    },
    [handleAsyncOperation],
  );

  const handleCopySubagentOrchestration = useCallback(
    async (orchestration: SubagentOrchestrationResource) => {
      const copied = buildSubagentOrchestrationFromForm(
        createCopiedSubagentOrchestrationForm(orchestration, formOptions),
        { templates },
      );
      await handleAsyncOperation(() => window.eco!.saveSubagentOrchestration(copied));
    },
    [formOptions, handleAsyncOperation, templates],
  );

  const handleDeleteSubagentOrchestration = useCallback(
    async (orchestration: SubagentOrchestrationResource) => {
      if (
        !window.confirm(
          t("settings.models.resources.confirmDeleteOrchestration", { name: orchestration.name }),
        )
      ) {
        return;
      }
      await handleAsyncOperation(() => window.eco!.deleteSubagentOrchestration(orchestration.id));
    },
    [handleAsyncOperation],
  );

  return (
    <div className="composition-resources-panel">
      {error && <p className="settings-form-error mcp-list-error">{error}</p>}

      {activeScope === "prompt" ? (
        <section className="mcp-list-section composition-resources-block">
          <div className="mcp-list-toolbar">
            <span className="mcp-list-toolbar-label">{t("settings.models.resources.mainPrompt")}</span>
            <button
              type="button"
              className="mcp-add-button"
              onClick={() => openCreateEditor("prompt")}
              aria-label={t("settings.models.resources.mainPromptAdd")}
              disabled={busy}
            >
              <Plus size={18} /> {t("settings.models.resources.add")}
            </button>
          </div>
          {userMainPrompts.length === 0 ? (
            <p className="mcp-list-empty">{t("settings.models.resources.mainPromptEmpty")}</p>
          ) : (
            <ul className="mcp-server-list">
              {userMainPrompts.map((prompt) => (
                <li key={prompt.id} className="mcp-server-row">
                  <div className="mcp-server-summary">
                    <span className="mcp-server-name">{prompt.name}</span>
                    <span className="mcp-server-meta">
                      {prompt.prompt.slice(0, 48)}
                      {prompt.prompt.length > 48 ? "…" : ""}
                    </span>
                  </div>
                  <div className="mcp-server-actions">
                    <button
                      type="button"
                      className="mcp-icon-button"
                      onClick={() => openEditEditor("prompt", prompt)}
                      aria-label={t("settings.models.editor.editAria", { name: prompt.name })}
                      disabled={busy}
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      type="button"
                      className="mcp-icon-button"
                      onClick={() => void handleCopyMainPrompt(prompt)}
                      aria-label={t("settings.models.editor.copyAria", { name: prompt.name })}
                      disabled={busy}
                    >
                      <Copy size={18} />
                    </button>
                    <button
                      type="button"
                      className="mcp-icon-button danger"
                      onClick={() => void handleDeleteMainPrompt(prompt)}
                      aria-label={t("settings.models.editor.deleteAria", { name: prompt.name })}
                      disabled={busy}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {activeScope === "orchestration" ? (
        <section className="mcp-list-section composition-resources-block">
          <div className="mcp-list-toolbar">
            <span className="mcp-list-toolbar-label">
              {t("settings.models.resources.subagentOrchestration")}
            </span>
            <button
              type="button"
              className="mcp-add-button"
              onClick={() => openCreateEditor("orchestration")}
              aria-label={t("settings.models.resources.subagentOrchestrationAdd")}
              disabled={busy}
            >
              <Plus size={18} /> {t("settings.models.resources.add")}
            </button>
          </div>
          {userSubagentOrchestrationResources.length === 0 ? (
            <p className="mcp-list-empty">{t("settings.models.resources.subagentOrchestrationEmpty")}</p>
          ) : (
            <ul className="mcp-server-list">
              {userSubagentOrchestrationResources.map((orchestration) => (
                <li key={orchestration.id} className="mcp-server-row">
                  <div className="mcp-server-summary">
                    <span className="mcp-server-name">{orchestration.name}</span>
                    <span className="mcp-server-meta">
                      {t("settings.models.resources.agentCount", { count: orchestration.agents.length })}
                    </span>
                  </div>
                  <div className="mcp-server-actions">
                    <button
                      type="button"
                      className="mcp-icon-button"
                      onClick={() => openEditEditor("orchestration", orchestration)}
                      aria-label={t("settings.models.editor.editAria", { name: orchestration.name })}
                      disabled={busy}
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      type="button"
                      className="mcp-icon-button"
                      onClick={() => void handleCopySubagentOrchestration(orchestration)}
                      aria-label={t("settings.models.editor.copyAria", { name: orchestration.name })}
                      disabled={busy}
                    >
                      <Copy size={18} />
                    </button>
                    <button
                      type="button"
                      className="mcp-icon-button danger"
                      onClick={() => void handleDeleteSubagentOrchestration(orchestration)}
                      aria-label={t("settings.models.editor.deleteAria", { name: orchestration.name })}
                      disabled={busy}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {editorSession ? (
        <AgentResourceEditorModal
          form={editorSession.form}
          setForm={(updater) =>
            setEditorSession((current) => {
              if (!current) {
                return current;
              }
              const nextForm = typeof updater === "function" ? updater(current.form) : updater;
              return { ...current, form: nextForm };
            })
          }
          scope={editorSession.scope}
          mode={editorSession.mode}
          providers={settings.providers.filter((provider) => provider.apiCompat !== "system_one")}
          templates={templates}
          mcpServers={mcpServers}
          mainModel={mainModel}
          error={error || undefined}
          busy={busy}
          onClose={() => setEditorSession(undefined)}
          onSave={() => void saveEditorSession()}
        />
      ) : null}

    </div>
  );
}
