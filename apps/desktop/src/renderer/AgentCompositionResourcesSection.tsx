import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type MainAgentConfigResource,
  type MainAgentPromptResource,
  type OrchestrationSelection,
  resolveAgentTemplateCatalog,
  type SubagentOrchestrationResource,
} from "../shared/agent-orchestration";
import type { McpServerConfigView, ModelSettingsSnapshot } from "../shared/ipc";
import { hasCompleteOrchestrationSelection } from "../shared/thread-runtime-config";
import {
  type AgentCompositionEditorMode,
  type AgentCompositionEditorScope,
  AgentResourceEditorModal,
} from "./agent-resource-editor-modal";
import {
  type AgentResourceFormState,
  buildMainAgentConfigFromForm,
  buildMainAgentPromptFromForm,
  buildSubagentOrchestrationFromForm,
  createBlankMainAgentConfigForm,
  createBlankMainAgentPromptForm,
  createBlankSubagentOrchestrationForm,
  createCopiedMainAgentConfigForm,
  createCopiedMainAgentPromptForm,
  createCopiedSubagentOrchestrationForm,
  mainAgentConfigToForm,
  mainAgentPromptToForm,
  subagentOrchestrationToForm,
} from "./agent-resource-form";
import { UseMainAgentConfigAsDefaultPromptDialog } from "./UseMainAgentConfigAsDefaultPromptDialog";

interface AgentCompositionResourcesSectionProps {
  settings: ModelSettingsSnapshot;
  mcpServers?: McpServerConfigView[] | undefined;
  busy?: boolean | undefined;
  activeScope: AgentCompositionEditorScope;
  onRegistryChange: () => Promise<void> | void;
  onSavingChange?: ((saving: boolean) => void) | undefined;
  onErrorMessage?: ((message: string) => void) | undefined;
  /** When set, open the main-config create dialog with this candidate model preselected. */
  pendingCreateMainConfig?: PendingMainAgentConfigCreateSeed | undefined;
  onPendingCreateMainConfigConsumed?: (() => void) | undefined;
  /** Current global default runtime orchestration; used to decide whether to prompt. */
  defaultOrchestrationSelection?: OrchestrationSelection | undefined;
  /** Apply a newly created main agent config as the global default runtime config. */
  onUseMainAgentConfigAsDefault?: ((mainAgentConfigId: string) => void | Promise<void>) | undefined;
}

export interface PendingMainAgentConfigCreateSeed {
  providerId: string;
  candidateModelId: string;
  modelId: string;
}

interface CompositionEditorSession {
  scope: AgentCompositionEditorScope;
  mode: AgentCompositionEditorMode;
  form: AgentResourceFormState;
}

export function AgentCompositionResourcesSection({
  settings,
  mcpServers = [],
  busy = false,
  activeScope,
  onRegistryChange,
  onSavingChange,
  onErrorMessage,
  pendingCreateMainConfig,
  onPendingCreateMainConfigConsumed,
  defaultOrchestrationSelection,
  onUseMainAgentConfigAsDefault,
}: AgentCompositionResourcesSectionProps) {
  const [error, setError] = useState("");
  const [editorSession, setEditorSession] = useState<CompositionEditorSession>();
  const [useAsDefaultPromptConfigId, setUseAsDefaultPromptConfigId] = useState<string>();
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

  const mainAgentConfigs = settings.mainAgentConfigs ?? [];
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
        ...mainAgentConfigs.map((entry) => entry.id),
        ...mainAgentPrompts.map((entry) => entry.id),
        ...subagentOrchestrations.map((entry) => entry.id),
      ],
      existingNames: [
        ...mainAgentConfigs.map((entry) => entry.name),
        ...mainAgentPrompts.map((entry) => entry.name),
        ...subagentOrchestrations.map((entry) => entry.name),
      ],
    }),
    [mainAgentConfigs, mainAgentPrompts, settings.providers, subagentOrchestrations, templates],
  );

  const userMainAgentConfigs = useMemo(
    () => mainAgentConfigs.filter((config) => config.source !== "built_in"),
    [mainAgentConfigs],
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
    (scope: AgentCompositionEditorScope, seed?: PendingMainAgentConfigCreateSeed) => {
      clearError();
      const form =
        scope === "mainConfig"
          ? createBlankMainAgentConfigForm(formOptions)
          : scope === "prompt"
            ? createBlankMainAgentPromptForm(formOptions)
            : createBlankSubagentOrchestrationForm(formOptions);
      if (scope === "mainConfig" && seed) {
        form.mainProviderId = seed.providerId;
        form.mainModelId = seed.modelId;
        form.mainCandidateModelId = seed.candidateModelId;
      }
      setEditorSession({ scope, mode: "create", form });
    },
    [clearError, formOptions],
  );

  useEffect(() => {
    if (!pendingCreateMainConfig || activeScope !== "mainConfig") {
      return;
    }
    openCreateEditor("mainConfig", pendingCreateMainConfig);
    onPendingCreateMainConfigConsumed?.();
  }, [activeScope, onPendingCreateMainConfigConsumed, openCreateEditor, pendingCreateMainConfig]);

  const openEditEditor = useCallback(
    (
      scope: AgentCompositionEditorScope,
      resource: MainAgentConfigResource | MainAgentPromptResource | SubagentOrchestrationResource,
    ) => {
      clearError();
      const form =
        scope === "mainConfig"
          ? mainAgentConfigToForm(resource as MainAgentConfigResource)
          : scope === "prompt"
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
    const { scope, mode, form } = editorSession;
    await handleAsyncOperation(async () => {
      if (scope === "mainConfig") {
        const existing = mainAgentConfigs.find((entry) => entry.id === form.id);
        const config = buildMainAgentConfigFromForm(form, existing ? { existing } : {});
        const saved = await window.eco!.saveMainAgentConfig(config);
        if (
          mode === "create" &&
          onUseMainAgentConfigAsDefault &&
          !hasCompleteOrchestrationSelection(defaultOrchestrationSelection)
        ) {
          setUseAsDefaultPromptConfigId(saved.id);
        }
      } else if (scope === "prompt") {
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
    defaultOrchestrationSelection,
    editorSession,
    handleAsyncOperation,
    mainAgentConfigs,
    mainAgentPrompts,
    onUseMainAgentConfigAsDefault,
    subagentOrchestrations,
    templates,
  ]);

  const dismissUseAsDefaultPrompt = useCallback(() => {
    setUseAsDefaultPromptConfigId(undefined);
  }, []);

  const confirmUseAsDefaultPrompt = useCallback(() => {
    if (!useAsDefaultPromptConfigId || !onUseMainAgentConfigAsDefault) {
      setUseAsDefaultPromptConfigId(undefined);
      return;
    }
    const configId = useAsDefaultPromptConfigId;
    setUseAsDefaultPromptConfigId(undefined);
    void Promise.resolve(onUseMainAgentConfigAsDefault(configId)).catch((caught) => {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (onErrorMessage) {
        onErrorMessage(message);
      } else {
        setError(message);
      }
    });
  }, [onErrorMessage, onUseMainAgentConfigAsDefault, useAsDefaultPromptConfigId]);

  const handleCopyMainAgent = useCallback(
    async (config: MainAgentConfigResource) => {
      const copied = buildMainAgentConfigFromForm(createCopiedMainAgentConfigForm(config, formOptions));
      await handleAsyncOperation(() => window.eco!.saveMainAgentConfig(copied));
    },
    [formOptions, handleAsyncOperation],
  );

  const handleDeleteMainAgent = useCallback(
    async (config: MainAgentConfigResource) => {
      if (!window.confirm(t("settings.models.resources.confirmDeleteMainConfig", { name: config.name }))) {
        return;
      }
      await handleAsyncOperation(() => window.eco!.deleteMainAgentConfig(config.id));
    },
    [handleAsyncOperation],
  );

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

      {activeScope === "mainConfig" ? (
        <section className="mcp-list-section composition-resources-block">
          <div className="mcp-list-toolbar">
            <span className="mcp-list-toolbar-label">{t("settings.models.resources.mainConfig")}</span>
            <button
              type="button"
              className="mcp-add-button"
              onClick={() => openCreateEditor("mainConfig")}
              aria-label={t("settings.models.resources.mainConfigAdd")}
              disabled={busy}
            >
              <Plus size={18} /> {t("settings.models.resources.add")}
            </button>
          </div>
          {userMainAgentConfigs.length === 0 ? (
            <p className="mcp-list-empty">{t("settings.models.resources.mainConfigEmpty")}</p>
          ) : (
            <ul className="mcp-server-list">
              {userMainAgentConfigs.map((config) => (
                <li key={config.id} className="mcp-server-row">
                  <div className="mcp-server-summary">
                    <span className="mcp-server-name">{config.name}</span>
                    <span className="mcp-server-meta">
                      {config.modelRef.providerId}:{config.modelRef.modelId}
                    </span>
                  </div>
                  <div className="mcp-server-actions">
                    <button
                      type="button"
                      className="mcp-icon-button"
                      onClick={() => openEditEditor("mainConfig", config)}
                      aria-label={t("settings.models.editor.editAria", { name: config.name })}
                      disabled={busy}
                    >
                      <Pencil size={18} />
                    </button>
                    <button
                      type="button"
                      className="mcp-icon-button"
                      onClick={() => void handleCopyMainAgent(config)}
                      aria-label={t("settings.models.editor.copyAria", { name: config.name })}
                      disabled={busy}
                    >
                      <Copy size={18} />
                    </button>
                    <button
                      type="button"
                      className="mcp-icon-button danger"
                      onClick={() => void handleDeleteMainAgent(config)}
                      aria-label={t("settings.models.editor.deleteAria", { name: config.name })}
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
          error={error || undefined}
          busy={busy}
          onClose={() => setEditorSession(undefined)}
          onSave={() => void saveEditorSession()}
        />
      ) : null}

      {useAsDefaultPromptConfigId ? (
        <UseMainAgentConfigAsDefaultPromptDialog
          onDismiss={dismissUseAsDefaultPrompt}
          onConfirm={confirmUseAsDefaultPrompt}
        />
      ) : null}
    </div>
  );
}
