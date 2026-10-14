import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { LazyOpenAIAccountsPanel } from "./lazy-app-panels";
import { ChatGPTSubscriptionAccountsPanel } from "./ChatGPTSubscriptionAccountsPanel";
import {
  ChevronDown,
  ChevronRight,
  Eraser,
  Globe2,
  LinkIcon,
  Network,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  type Dispatch,
  type DragEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { requestPathPlaceholderForApiCompat } from "../shared/api-compat";
import type { CenterServerSyncDomain, CenterServerSyncDomainResult } from "../shared/center-server";
import type {
  AuxiliaryModelSelection,
  ApprovalModelSelection,
  CandidateModelView,
  CommitModelOptionView,
  McpServerConfigView,
  ModelSettingsSnapshot,
  ModelsDevModelOption,
  OrchestrationSelection,
  ProviderConfigInput,
  ProviderConfigView,
  ProviderDeleteReference,
  ProviderRequestError,
  SkillsListResult,
  VisionModelSelection,
} from "../shared/ipc";
import { ROUTE_TEST_THINKING_EFFORT, type UpstreamModelOption } from "../shared/models";
import { hasCompleteOrchestrationSelection } from "../shared/thread-runtime-config";
import {
  AgentCompositionResourcesSection,
  type PendingMainAgentConfigCreateSeed,
} from "./AgentCompositionResourcesSection";
import { EndpointCompatSelect, type EndpointCompatOption } from "./EndpointCompatSelect";
import { AppMessage, formatDurationMs, useAppMessage, type AppMessageKind } from "./AppMessage";
import { buildAgentTemplateCapabilityOptions } from "./agent-template-form";
import { AgentThemeColorField } from "./agent-theme-color-field";
import { CandidateModelPanel, type CandidateModelPanelHandle } from "./CandidateModelListSection";
import { ComposerFieldSelect } from "./ComposerFieldSelect";
import { CreateMainAgentConfigPromptDialog } from "./CreateMainAgentConfigPromptDialog";
import { ModelCascadeSelect } from "./ModelCascadeSelect";
import { CandidateModelSpecPanel } from "./ModelSpecSummary";
import {
  createCommitModelPricingExtra,
  mapCommitModelOptions,
  toCandidateModelSelection,
  toModelCascadeSelection,
} from "./model-cascade-options";
import {
  applyProviderPreset,
  DEFAULT_NEW_PROVIDER_PRESET_ID,
  findPresetEndpointVariant,
  findPresetForForm,
  getProviderPresetById,
  getProviderPresetEndpointVariants,
  MAINSTREAM_PROVIDER_PRESETS,
} from "./provider-presets";
import { ProviderPresetTabs } from "./ProviderPresetTabs";
import { SettingsSyncControl } from "./SettingsSyncControl";
import { SubagentSettingsSection } from "./SubagentSettingsSection";
import { ToolCapabilityPanel } from "./ToolCapabilityPanel";

export type ModelsSettingsTab =
  | "subagents"
  | "providers"
  | "compositionParts"
  | "openaiAccounts"
  | "chatgptAccounts";

type RuntimeConfigTab = "defaults" | "mainConfig" | "prompt" | "orchestration";

interface ModelsSettingsPanelProps {
  settings: ModelSettingsSnapshot;
  mcpServers?: McpServerConfigView[] | undefined;
  skillsSnapshot?: SkillsListResult | undefined;
  busy?: boolean | undefined;
  initialTab?: ModelsSettingsTab | undefined;
  mode?: "agentBuilder" | "providerSettings" | undefined;
  hideCategoryTabs?: boolean | undefined;
  heading?: string | undefined;
  onSettingsChange: (settings: ModelSettingsSnapshot) => void;
  defaultOrchestrationSelection?: OrchestrationSelection | undefined;
  onDefaultOrchestrationSelectionChange?:
    | ((selection: OrchestrationSelection | undefined) => void | Promise<void>)
    | undefined;
  defaultAuxiliaryModel?: AuxiliaryModelSelection | undefined;
  onDefaultAuxiliaryModelChange?:
    | ((selection: AuxiliaryModelSelection | undefined) => void | Promise<void>)
    | undefined;
  defaultApprovalModel?: ApprovalModelSelection | undefined;
  onDefaultApprovalModelChange?:
    | ((selection: ApprovalModelSelection | undefined) => void | Promise<void>)
    | undefined;
  defaultVisionModel?: VisionModelSelection | undefined;
  onDefaultVisionModelChange?:
    | ((selection: VisionModelSelection | undefined) => void | Promise<void>)
    | undefined;
  onSavingChange?: ((saving: boolean) => void) | undefined;
  /** Ask App to open orchestration settings and create a main agent config. */
  onRequestCreateMainAgentConfig?: ((seed: PendingMainAgentConfigCreateSeed) => void) | undefined;
  /** When set (orchestration panel), open create dialog with this model preselected. */
  pendingCreateMainConfig?: PendingMainAgentConfigCreateSeed | undefined;
  onPendingCreateMainConfigConsumed?: (() => void) | undefined;
  centerServerSyncVisible?: boolean;
  onSyncDomain?: (
    domain: CenterServerSyncDomain,
    mode: "pull" | "push",
  ) => Promise<CenterServerSyncDomainResult>;
}

interface ModelsCacheEntry {
  models: UpstreamModelOption[];
  /** Endpoint the entry was fetched from; a different endpoint must refetch. */
  signature: string;
  error?: string | undefined;
}

/**
 * Model discovery depends on the endpoint, not only on the provider id: editing
 * baseURL / requestPath / version / apiCompat has to re-run the upstream fetch
 * instead of replaying the previous provider's list.
 */
function modelsRequestSignature(target: ProviderConfigInput): string {
  return [
    target.baseUrl?.trim() ?? "",
    target.requestPath?.trim() ?? "",
    target.version?.trim() ?? "",
    target.apiCompat ?? "",
    target.authMethod ?? "",
  ].join("|");
}

function providerProtocolPresentation(provider: Pick<ProviderConfigView, "apiCompat">) {
  if (provider.apiCompat === "system_one") {
    return { label: "SystemOne", iconSrc: "./provider-icons/system-one.png" };
  }
  if (provider.apiCompat === "anthropic") {
    return { label: "Anthropic API", iconSrc: "./provider-icons/claude.ico" };
  }
  if (provider.apiCompat === "openai_responses") {
    return { label: "OpenAI Responses API", iconSrc: "./provider-icons/openai.svg" };
  }
  if (provider.apiCompat === "openai_chat_completions") {
    return { label: "OpenAI Chat Completions API", iconSrc: "./provider-icons/openai.svg" };
  }
  return { label: "自定义 API", iconSrc: undefined };
}

const OFFICIAL_PROVIDER_HOSTS: Record<string, { label: string; iconSrc: string }> = {
  "api.typesafe.ai": { label: "TypeSafe (Jev)", iconSrc: "./provider-icons/system-one.png" },
  "api.openai.com": { label: "OpenAI", iconSrc: "./provider-icons/openai.svg" },
  "api.anthropic.com": { label: "Anthropic", iconSrc: "./provider-icons/claude.ico" },
  "api.deepseek.com": { label: "DeepSeek", iconSrc: "./provider-icons/deepseek.ico" },
  "api.minimax.io": { label: "MiniMax", iconSrc: "./provider-icons/minimax.ico" },
  "api.moonshot.cn": { label: "Kimi", iconSrc: "./provider-icons/kimi.ico" },
  "dashscope.aliyuncs.com": { label: "百炼", iconSrc: "./provider-icons/bailian.png" },
  "tokenhub.tencentmaas.com": { label: "Tencent Hunyuan", iconSrc: "./provider-icons/tencent-hunyuan.png" },
  "api.xiaomimimo.com": { label: "Xiaomi MiMo", iconSrc: "./provider-icons/xiaomi-mimo.ico" },
  "opencode.ai": { label: "OpenCode Zen", iconSrc: "./provider-icons/opencode-zen.ico" },
};

function providerBrandPresentation(provider: Pick<ProviderConfigView, "id" | "baseUrl" | "apiCompat">) {
  let hostname = "";
  try {
    hostname = new URL(provider.baseUrl).hostname.toLowerCase();
  } catch {
    // Keep protocol fallback for historical or incomplete URLs.
  }
  const official = OFFICIAL_PROVIDER_HOSTS[hostname];
  if (official) return official;
  const preset = getProviderPresetById(provider.id);
  if (preset) {
    try {
      if (new URL(preset.baseUrl).hostname.toLowerCase() === hostname) {
        return { label: preset.name, iconSrc: preset.iconSrc };
      }
    } catch {
      // Keep protocol fallback for an invalid preset URL.
    }
  }
  return providerProtocolPresentation(provider);
}

export function ModelsSettingsPanel({
  settings,
  mcpServers = [],
  skillsSnapshot,
  busy,
  initialTab = "subagents",
  mode = "agentBuilder",
  hideCategoryTabs = false,
  heading,
  onSettingsChange,
  defaultOrchestrationSelection,
  onDefaultOrchestrationSelectionChange,
  defaultAuxiliaryModel,
  onDefaultAuxiliaryModelChange,
  defaultApprovalModel,
  onDefaultApprovalModelChange,
  defaultVisionModel,
  onDefaultVisionModelChange,
  onSavingChange,
  onRequestCreateMainAgentConfig,
  pendingCreateMainConfig,
  onPendingCreateMainConfigConsumed,
  centerServerSyncVisible = false,
  onSyncDomain,
}: ModelsSettingsPanelProps) {
  const { t } = useTranslation();
  const providerSettingsTabItems: Array<{ id: ModelsSettingsTab; label: string; icon?: string }> = [
    { id: "providers", label: t("settings.models.providers") },
    { id: "openaiAccounts" as ModelsSettingsTab, label: "Codex 账号", icon: "./provider-icons/openai.svg" },
    { id: "chatgptAccounts", label: "ChatGPT 账号", icon: "./provider-icons/openai.svg" },
  ];
  const runtimeConfigTabItems: Array<{ id: RuntimeConfigTab; label: string }> = [
    { id: "defaults", label: t("settings.models.runtimeConfigTab.defaults") },
    { id: "mainConfig", label: t("settings.models.runtimeConfigTab.mainAgent") },
    { id: "prompt", label: t("settings.models.runtimeConfigTab.prompt") },
    { id: "orchestration", label: t("settings.models.runtimeConfigTab.subagent") },
  ];
  const resolvedInitialTab =
    mode === "providerSettings" ? "providers" : initialTab === "providers" ? "subagents" : initialTab;
  const [activeTab, setActiveTab] = useState<ModelsSettingsTab>(resolvedInitialTab);
  const [runtimeConfigTab, setRuntimeConfigTab] = useState<RuntimeConfigTab>(() =>
    pendingCreateMainConfig ? "mainConfig" : "defaults",
  );

  useEffect(() => {
    if (!pendingCreateMainConfig) {
      return;
    }
    setActiveTab("compositionParts");
    setRuntimeConfigTab("mainConfig");
  }, [pendingCreateMainConfig]);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [createMainConfigPromptSeed, setCreateMainConfigPromptSeed] = useState<
    PendingMainAgentConfigCreateSeed | undefined
  >();
  const [providerForm, setProviderForm] = useState<ProviderConfigInput>(() => providerToForm());
  const [providerSearchQuery, setProviderSearchQuery] = useState("");
  const [oauthLoginStatus, setOauthLoginStatus] = useState<{ isLoggedIn: boolean; message: string }>({
    isLoggedIn: false,
    message: "",
  });
  const [oauthLoggingIn, setOauthLoggingIn] = useState(false);
  const [modelsCache, setModelsCache] = useState<Record<string, ModelsCacheEntry>>({});
  const [loadingProviderId, setLoadingProviderId] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string>();
  const syncDomain: CenterServerSyncDomain | undefined =
    mode === "providerSettings"
      ? "providers"
      : activeTab === "compositionParts"
        ? "orchestration"
        : activeTab === "subagents"
          ? "agentLibrary"
          : undefined;
  const syncControl =
    syncDomain && onSyncDomain ? (
      <SettingsSyncControl
        domain={syncDomain}
        visible={centerServerSyncVisible}
        disabled={busy === true}
        onSync={onSyncDomain}
      />
    ) : null;
  const [defaultOrchestrationDraft, setDefaultOrchestrationDraft] = useState<OrchestrationSelection>(
    () =>
      defaultOrchestrationSelection ?? {
        mainAgentConfigId: "",
        mainPrompt: { mode: "builtin" },
        subagents: { mode: "none" },
      },
  );
  const [auxiliaryModelOptions, setAuxiliaryModelOptions] = useState<CommitModelOptionView[]>([]);
  const [auxiliaryModelsLoading, setAuxiliaryModelsLoading] = useState(false);
  const [auxiliaryModelsError, setAuxiliaryModelsError] = useState<string>();
  const commitModelPricingExtra = useMemo(
    () => createCommitModelPricingExtra(auxiliaryModelOptions),
    [auxiliaryModelOptions],
  );
  const [approvalModelOptions, setApprovalModelOptions] = useState<CommitModelOptionView[]>([]);
  const [approvalModelsLoading, setApprovalModelsLoading] = useState(false);
  const [approvalModelsError, setApprovalModelsError] = useState<string>();
  const approvalModelPricingExtra = useMemo(
    () => createCommitModelPricingExtra(approvalModelOptions),
    [approvalModelOptions],
  );

  useEffect(() => {
    setDefaultOrchestrationDraft(
      defaultOrchestrationSelection ?? {
        mainAgentConfigId: "",
        mainPrompt: { mode: "builtin" },
        subagents: { mode: "none" },
      },
    );
  }, [defaultOrchestrationSelection]);

  const updateDefaultOrchestrationDraft = useCallback(
    (patch: Partial<OrchestrationSelection>) => {
      const next: OrchestrationSelection = {
        mainAgentConfigId: patch.mainAgentConfigId ?? defaultOrchestrationDraft.mainAgentConfigId,
        mainPrompt: patch.mainPrompt ?? defaultOrchestrationDraft.mainPrompt,
        subagents: patch.subagents ?? defaultOrchestrationDraft.subagents,
      };
      setDefaultOrchestrationDraft(next);
      if (hasCompleteOrchestrationSelection(next)) {
        void Promise.resolve(onDefaultOrchestrationSelectionChange?.(next)).catch((error) => {
          setPanelError(error instanceof Error ? error.message : String(error));
        });
      }
    },
    [defaultOrchestrationDraft, onDefaultOrchestrationSelectionChange],
  );

  const auxiliaryModelLookupId = settings.mainAgentConfigs.some(
    (config) => config.id === defaultOrchestrationDraft.mainAgentConfigId,
  )
    ? defaultOrchestrationDraft.mainAgentConfigId
    : (settings.mainAgentConfigs[0]?.id ?? "");

  useEffect(() => {
    if (!window.eco?.listGitCommitModelOptions) {
      setAuxiliaryModelOptions([]);
      setAuxiliaryModelsLoading(false);
      setAuxiliaryModelsError(undefined);
      return;
    }
    let cancelled = false;
    setAuxiliaryModelsLoading(true);
    setAuxiliaryModelsError(undefined);
    void window.eco
      .listGitCommitModelOptions(auxiliaryModelLookupId ? { mainAgentConfigId: auxiliaryModelLookupId } : {})
      .then((result) => {
        if (!cancelled) {
          setAuxiliaryModelOptions(result.options);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setAuxiliaryModelOptions([]);
          setAuxiliaryModelsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAuxiliaryModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auxiliaryModelLookupId, settings.providers]);

  useEffect(() => {
    if (!window.eco?.listApprovalModelOptions) {
      setApprovalModelOptions([]);
      setApprovalModelsLoading(false);
      setApprovalModelsError(undefined);
      return;
    }
    let cancelled = false;
    setApprovalModelsLoading(true);
    setApprovalModelsError(undefined);
    void window.eco
      .listApprovalModelOptions(auxiliaryModelLookupId ? { mainAgentConfigId: auxiliaryModelLookupId } : {})
      .then((result) => {
        if (!cancelled) {
          setApprovalModelOptions(result.options);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setApprovalModelOptions([]);
          setApprovalModelsError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setApprovalModelsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auxiliaryModelLookupId, settings.providers]);

  const selectDefaultAuxiliaryModel = useCallback(
    (selection: AuxiliaryModelSelection | undefined) => {
      void Promise.resolve(onDefaultAuxiliaryModelChange?.(selection)).catch((error) => {
        setPanelError(error instanceof Error ? error.message : String(error));
      });
    },
    [onDefaultAuxiliaryModelChange],
  );
  const selectDefaultApprovalModel = useCallback(
    (selection: ApprovalModelSelection | undefined) => {
      void Promise.resolve(onDefaultApprovalModelChange?.(selection)).catch((error) => {
        setPanelError(error instanceof Error ? error.message : String(error));
      });
    },
    [onDefaultApprovalModelChange],
  );
  const selectDefaultVisionModel = useCallback(
    (selection: VisionModelSelection | undefined) => {
      void Promise.resolve(onDefaultVisionModelChange?.(selection)).catch((error) => {
        setPanelError(error instanceof Error ? error.message : String(error));
      });
    },
    [onDefaultVisionModelChange],
  );
  const [modalError, setModalError] = useState<string>();
  const [testingProviderKey, setTestingProviderKey] = useState<string | null>(null);
  const {
    state: appMessage,
    dismiss: dismissAppMessage,
    showError: showAppMessageError,
    showSuccess: showAppMessageSuccess,
    showInfo: showAppMessageInfo,
  } = useAppMessage();
  const [modelsDevOptions, setModelsDevOptions] = useState<ModelsDevModelOption[]>([]);
  const [modelsDevLoading, setModelsDevLoading] = useState(false);

  useEffect(() => {
    setActiveTab(resolvedInitialTab);
  }, [resolvedInitialTab]);

  const modalProviderId = providerForm.id ?? "__draft__";
  const modalCache = modelsCache[modalProviderId];

  const refreshSettings = useCallback(async () => {
    if (!window.eco) {
      return;
    }
    const snapshot = await window.eco.getModelSettings();
    onSettingsChange(snapshot);
  }, [onSettingsChange]);

  const checkOauthStatus = useCallback(async () => {
    if (!window.eco?.codexOAuthGetStatus) {
      return;
    }
    try {
      const status = await window.eco.codexOAuthGetStatus();
      setOauthLoginStatus(status);
    } catch {
      setOauthLoginStatus({ isLoggedIn: false, message: "" });
    }
  }, []);

  const handleOauthLogin = useCallback(async (upstreamProxyUrl?: string) => {
    if (!window.eco?.codexOAuthStartLogin) {
      return;
    }
    setOauthLoggingIn(true);
    try {
      await window.eco.codexOAuthStartLogin(upstreamProxyUrl);
      // Listen for result event
      window.eco.onCodexOauthLoginResult(async (res) => {
        setOauthLoggingIn(false);
        if (res.success) {
          await checkOauthStatus();
        }
      });
    } catch {
      setOauthLoggingIn(false);
    }
  }, [checkOauthStatus]);

  const handleOauthLogout = useCallback(async () => {
    if (!window.eco?.codexOAuthLogout) {
      return;
    }
    try {
      await window.eco.codexOAuthLogout();
      setOauthLoginStatus({ isLoggedIn: false, message: t("settings.models.provider.oauthLoggedOut") });
    } catch {
      // ignore
    }
  }, [t]);

  useEffect(() => {
    if (!window.eco?.listModelsDevModels) {
      return;
    }
    if (modelsDevOptions.length > 0 || modelsDevLoading) {
      return;
    }
    setModelsDevLoading(true);
    window.eco
      .listModelsDevModels()
      .then((options) => setModelsDevOptions(options))
      .catch(() => {})
      .finally(() => setModelsDevLoading(false));
  }, [modelsDevOptions.length, modelsDevLoading]);

  const fetchModels = useCallback(
    async (target: ProviderConfigInput) => {
      if (!window.eco) {
        return;
      }
      const cacheKey = target.id ?? "__draft__";
      const signature = modelsRequestSignature(target);
      setLoadingProviderId(cacheKey);

      try {
        const request = {
          baseUrl: target.baseUrl,
          ...(target.requestPath !== undefined && target.requestPath !== ""
            ? { requestPath: target.requestPath }
            : {}),
          ...(target.version !== undefined && target.version !== "" ? { version: target.version } : {}),
          ...(target.apiCompat && { apiCompat: target.apiCompat }),
          ...(target.id && { providerId: target.id }),
          ...(target.authMethod && { authMethod: target.authMethod }),
          ...(target.apiKey && { apiKey: target.apiKey }),
        };
        const result = await window.eco.listProviderModels(request);
        if (!result.ok) {
          const detail = localizeProviderRequestError(result, t);
          setModelsCache((current) => ({
            ...current,
            [cacheKey]: { models: current[cacheKey]?.models ?? [], signature, error: detail },
          }));
          showAppMessageError(t("settings.models.provider.modelsFailed", { detail }));
          return;
        }
        setModelsCache((current) => ({
          ...current,
          [cacheKey]: { models: result.models, signature },
        }));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        setModelsCache((current) => ({
          ...current,
          [cacheKey]: { models: current[cacheKey]?.models ?? [], signature, error: message },
        }));
        showAppMessageError(t("settings.models.provider.modelsFailed", { detail: message }));
      } finally {
        setLoadingProviderId(null);
      }
    },
    [showAppMessageError, t],
  );

  useEffect(() => {
    if (!providerModalOpen || !providerForm.id) {
      return;
    }
    const cached = modelsCache[providerForm.id];
    if (cached && cached.signature === modelsRequestSignature(providerForm)) {
      return;
    }
    // Debounced: the endpoint fields change keystroke by keystroke while editing.
    const timer = setTimeout(() => {
      void fetchModels(providerForm);
    }, 600);
    return () => clearTimeout(timer);
  }, [providerModalOpen, providerForm, modelsCache, fetchModels]);

  const modelsForProvider = useCallback(
    (providerId: string): UpstreamModelOption[] => modelsCache[providerId]?.models ?? [],
    [modelsCache],
  );

  const modelsErrorForProvider = useCallback(
    (providerId: string): string | undefined => modelsCache[providerId]?.error,
    [modelsCache],
  );

  const loadingForProvider = useCallback(
    (providerId: string) => loadingProviderId === providerId,
    [loadingProviderId],
  );

  function openCreateProvider() {
    setPanelError(undefined);
    setModalError(undefined);
    const defaultPreset =
      getProviderPresetById(DEFAULT_NEW_PROVIDER_PRESET_ID) ?? MAINSTREAM_PROVIDER_PRESETS[0]!;
    setProviderForm(applyProviderPreset(providerToForm(), defaultPreset));
    setProviderModalOpen(true);
  }

  function openEditProvider(provider: ProviderConfigView) {
    setPanelError(undefined);
    setModalError(undefined);
    setProviderForm(providerToForm(provider));
    setProviderModalOpen(true);
  }

  function showProviderTestMessage(kind: AppMessageKind, message: string) {
    if (kind === "success") {
      showAppMessageSuccess(message);
    } else if (kind === "info") {
      showAppMessageInfo(message);
    } else {
      showAppMessageError(message);
    }
  }

  function closeProviderModal(options?: { clearCreateMainConfigPrompt?: boolean }) {
    setProviderModalOpen(false);
    setModalError(undefined);
    setProviderForm(providerToForm());
    if (options?.clearCreateMainConfigPrompt ?? true) {
      setCreateMainConfigPromptSeed(undefined);
    }
  }

  async function maybePromptCreateMainAgentConfigAfterSave(provider: ProviderConfigView) {
    if (!window.eco) {
      return;
    }
    const snapshot = await window.eco.getModelSettings();
    const providerInMainConfigs = snapshot.mainAgentConfigs.some(
      (config) => config.modelRef.providerId === provider.id,
    );
    if (providerInMainConfigs) {
      return;
    }

    let candidates: CandidateModelView[] = [];
    try {
      candidates = await window.eco.listCandidateModels(provider.id);
    } catch {
      return;
    }
    const first = candidates[0];
    if (!first) {
      return;
    }

    setCreateMainConfigPromptSeed({
      providerId: provider.id,
      candidateModelId: first.id,
      modelId: first.modelId,
    });
  }

  function dismissCreateMainConfigPrompt() {
    setCreateMainConfigPromptSeed(undefined);
  }

  function confirmCreateMainConfigPrompt() {
    if (!createMainConfigPromptSeed || !onRequestCreateMainAgentConfig) {
      setCreateMainConfigPromptSeed(undefined);
      return;
    }
    onRequestCreateMainAgentConfig(createMainConfigPromptSeed);
    setCreateMainConfigPromptSeed(undefined);
    closeProviderModal();
  }

  async function saveProvider(options?: { closeOnSuccess?: boolean }) {
    if (!window.eco) {
      return undefined;
    }
    const closeOnSuccess = options?.closeOnSuccess ?? Boolean(providerForm.id);
    setModalError(undefined);
    onSavingChange?.(true);
    try {
      const provider = await window.eco.saveProvider(providerForm);
      await refreshSettings();
      setModelsCache((current) => {
        const draft = current.__draft__;
        if (!draft) {
          return current;
        }
        const next = { ...current };
        next[provider.id] = draft;
        delete next.__draft__;
        return next;
      });
      // Keep editor open after first create so candidate models can be added/tested immediately.
      setProviderForm(providerToForm(provider));
      if (closeOnSuccess) {
        closeProviderModal({ clearCreateMainConfigPrompt: false });
      }
      await maybePromptCreateMainAgentConfigAfterSave(provider);
      return provider;
    } catch (caught) {
      setModalError(caught instanceof Error ? caught.message : String(caught));
      return undefined;
    } finally {
      onSavingChange?.(false);
    }
  }

  async function deleteProvider() {
    if (!window.eco || !providerForm.id) {
      return;
    }
    const providerName = providerForm.name.trim() || t("settings.models.providerFallback");
    if (!window.confirm(t("settings.models.confirmDeleteProvider", { name: providerName }))) {
      return;
    }

    const deletedId = providerForm.id;
    setModalError(undefined);
    onSavingChange?.(true);
    try {
      const result = await window.eco.deleteProvider(deletedId);
      if (!result.ok) {
        if (result.reason === "not_found") {
          setModalError(t("settings.models.providerDeleteNotFound"));
          await refreshSettings();
          return;
        }
        setModalError(
          t("settings.models.providerDeleteInUse", {
            references: result.references
              .map((reference) => formatProviderDeleteReference(reference, t))
              .join(t("settings.models.providerDeleteReferenceSeparator")),
          }),
        );
        return;
      }
      await refreshSettings();
      setModelsCache((current) => {
        const next = { ...current };
        delete next[deletedId];
        return next;
      });
      closeProviderModal();
    } catch (caught) {
      setModalError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      onSavingChange?.(false);
    }
  }

  async function toggleProvider(provider: ProviderConfigView) {
    if (!window.eco) {
      return;
    }
    setPanelError(undefined);
    onSavingChange?.(true);
    try {
      await window.eco.saveProvider({ ...providerToForm(provider), enabled: !provider.enabled });
      await refreshSettings();
    } catch (caught) {
      setPanelError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      onSavingChange?.(false);
    }
  }

  async function testProvider(target: ProviderConfigInput, modelId?: string) {
    if (!window.eco?.testProviderConnection) {
      return;
    }
    const providerName = target.name.trim() || t("settings.models.providerFallback");
    if (!target.baseUrl.trim()) {
      showProviderTestMessage("error", t("settings.models.baseUrlRequired"));
      return;
    }
    const testModel = (modelId ?? target.defaultModel).trim();
    if (!testModel) {
      showProviderTestMessage("error", t("settings.models.testModelRequired"));
      return;
    }

    const feedbackKey = modelId?.trim()
      ? `${target.id ?? "__draft__"}::${testModel}`
      : (target.id ?? "__draft__");
    setTestingProviderKey(feedbackKey);

    const startedAt = performance.now();
    try {
      const result = await window.eco.testProviderConnection({
        baseUrl: target.baseUrl,
        ...(target.requestPath !== undefined && { requestPath: target.requestPath }),
        ...(target.version !== undefined && { version: target.version }),
        ...(target.apiCompat && { apiCompat: target.apiCompat }),
        defaultModel: testModel,
        thinkingEffort: ROUTE_TEST_THINKING_EFFORT,
        ...(target.id && { providerId: target.id }),
        ...(target.apiKey && { apiKey: target.apiKey }),
      });
      if (result.ok) {
        const duration = formatDurationMs(performance.now() - startedAt);
        showProviderTestMessage(
          "success",
          t("settings.models.providerTestPassed", {
            provider: providerName,
            model: testModel,
            duration,
          }),
        );
      } else {
        showProviderTestMessage("error", localizeProviderRequestError(result, t));
      }
    } catch (caught) {
      showProviderTestMessage("error", caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTestingProviderKey(null);
    }
  }

  // ChatGPT plan connections are managed from the account page, just like
  // Codex's auth.json. The provider row remains an internal routing object so
  // agents can select its models, but it must not look like a user-created
  // provider that can be edited, deleted, or configured with a base URL.
  const providerOptions = useMemo(
    () => settings.providers.filter((p) => p.id !== "openai" && p.id !== "eco-coding-chatgpt"),
    [settings.providers],
  );
  const filteredProviderOptions = useMemo(() => {
    const query = providerSearchQuery.trim().toLowerCase();
    if (!query) return providerOptions;
    return providerOptions.filter((provider) =>
      [provider.name, provider.baseUrl, provider.defaultModel, provider.authMethod ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [providerOptions, providerSearchQuery]);
  return (
    <>
      {appMessage && (
        <AppMessage kind={appMessage.kind} message={appMessage.message} onDismiss={dismissAppMessage} />
      )}
      {mode === "providerSettings" ? (
        <header className="mcp-page-header settings-page-header-with-action">
          <h1>{t("settings.models.providers")}</h1>
          {syncControl}
        </header>
      ) : (
        <header className="settings-page-header settings-page-header-with-action">
          <h1>{heading ?? t("settings.agentLibrary")}</h1>
          {syncControl}
        </header>
      )}

      {!hideCategoryTabs && (mode !== "providerSettings" || providerSettingsTabItems.length > 1) && (
        <div
          className="models-settings-tabs"
          role="tablist"
          aria-label={t("settings.models.providerCategories")}
        >
          {providerSettingsTabItems.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "models-settings-tab active" : "models-settings-tab"}
              onClick={() => setActiveTab(tab.id)}
            >
              <div style={{ height: "100%", display: "flex", gap: 5 }}>
                {tab.icon && (
                  <div style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center" }}>
                    <img src={tab.icon} alt="" width="14" height="14" style={{ display: "block" }} />
                  </div>
                )}
                <div>{tab.label}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {panelError && <p className="settings-form-error mcp-list-error">{panelError}</p>}

      {activeTab === "subagents" && (
        <SubagentSettingsSection
          templates={settings.agentTemplates}
          mcpServers={mcpServers}
          registryDisabled={busy}
          onRegistryChange={refreshSettings}
          onSavingChange={onSavingChange}
        />
      )}

      {activeTab === "providers" && (
        <section className="provider-list-panel providers-list-section">
          <div className="provider-list-hero">
            <div className="provider-list-heading">
              <h2>{t("settings.models.providers")}</h2>
              <p>管理 API 服务商、连接方式和默认模型。</p>
            </div>
            <button type="button" className="settings-primary-button" disabled={busy} onClick={openCreateProvider}>
              <Plus size={15} />
              {t("settings.models.addProvider")}
            </button>
          </div>

          <div className="provider-list-toolbar">
            <span>{providerOptions.length} 个服务商</span>
            <div className="provider-list-search">
              <Search size={14} className="provider-list-search-icon" />
              <input
                type="search"
                value={providerSearchQuery}
                placeholder="搜索服务商、地址或模型"
                aria-label="搜索服务商"
                onChange={(event) => setProviderSearchQuery(event.target.value)}
              />
              {providerSearchQuery ? (
                <button type="button" aria-label="清除搜索" onClick={() => setProviderSearchQuery("")}>
                  <X size={13} />
                </button>
              ) : null}
            </div>
          </div>

          {providerOptions.length === 0 ? (
            <div className="provider-list-empty"><strong>{t("settings.models.noProviders")}</strong><span>添加服务商后，可以在 Agent 设置中选择对应模型。</span></div>
          ) : filteredProviderOptions.length === 0 ? (
            <div className="provider-list-empty"><Search size={22} /><strong>没有匹配的服务商</strong><span>试试搜索名称、地址或默认模型。</span></div>
          ) : (
            <div className="provider-card-list">
              {filteredProviderOptions.map((provider) => {
                const brand = providerBrandPresentation(provider);
                const protocol = providerProtocolPresentation(provider);
                const authLabel = provider.authMethod === "oauth" ? "OAuth" : provider.authMethod === "auth_json" ? "Codex Auth" : provider.authMethod === "chatgpt_subscription" ? "ChatGPT 订阅" : "API Key";
                return (
                  <article key={provider.id} className={`provider-card ${provider.enabled ? "is-enabled" : "is-disabled"}`}>
                    <div className="provider-card-main">
                      <div className="provider-card-avatar">
                        {brand.iconSrc ? (
                          <img src={brand.iconSrc} alt={brand.label} title={brand.label} />
                        ) : (
                          <Globe2 size={18} aria-label={brand.label} />
                        )}
                      </div>
                      <div className="provider-card-identity">
                        <strong title={provider.name}>{provider.name}</strong>
                        <span title={provider.baseUrl}>{authLabel} · {provider.baseUrl}</span>
                      </div>
                      <button
                        type="button"
                        className={`provider-status-badge ${provider.enabled ? "is-enabled" : "is-disabled"}`}
                        onClick={() => void toggleProvider(provider)}
                        disabled={busy}
                        aria-pressed={provider.enabled}
                        title={provider.enabled ? "点击停用" : "点击启用"}
                      ><i />{provider.enabled ? "已启用" : "已停用"}</button>
                      <div className="provider-card-actions">
                        <button type="button" className="provider-config-button" onClick={() => openEditProvider(provider)} aria-label={t("settings.models.configureProvider", { name: provider.name })} disabled={busy}><Settings2 size={14} />配置</button>
                      </div>
                    </div>
                    <div className="provider-card-meta">
                      <span>默认模型：{provider.defaultModel || "未设置"}</span>
                      <span className="provider-card-protocol">端口类型：{protocol.label}</span>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === "openaiAccounts" && <LazyOpenAIAccountsPanel />}

      {activeTab === "chatgptAccounts" && <ChatGPTSubscriptionAccountsPanel />}


      {activeTab === "compositionParts" && (
        <>
          <div
            className="models-settings-tabs"
            role="tablist"
            aria-label={t("settings.models.runtimeConfigCategories")}
          >
            {runtimeConfigTabItems.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={runtimeConfigTab === tab.id}
                className={runtimeConfigTab === tab.id ? "models-settings-tab active" : "models-settings-tab"}
                onClick={() => setRuntimeConfigTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {runtimeConfigTab === "defaults" ? (
            <section className="settings-global-orchestration">
              <div className="settings-global-orchestration-header">
                <div className="settings-global-orchestration-heading">
                  <span className="settings-global-orchestration-icon" aria-hidden>
                    <Globe2 size={18} strokeWidth={1.8} />
                  </span>
                  <div>
                    <h3>{t("settings.models.resources.globalOrchestration")}</h3>
                    <p>{t("settings.models.resources.globalOrchestrationHint")}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-global-orchestration-reset"
                  title={t("settings.models.resources.clearGlobalOrchestration")}
                  aria-label={t("settings.models.resources.clearGlobalOrchestration")}
                  disabled={busy || !defaultOrchestrationSelection}
                  onClick={() => {
                    setDefaultOrchestrationDraft({
                      mainAgentConfigId: "",
                      mainPrompt: { mode: "builtin" },
                      subagents: { mode: "none" },
                    });
                    void Promise.resolve(onDefaultOrchestrationSelectionChange?.(undefined)).catch(
                      (error) => {
                        setPanelError(error instanceof Error ? error.message : String(error));
                      },
                    );
                  }}
                >
                  <Eraser size={17} aria-hidden />
                </button>
              </div>
              <div className="settings-global-orchestration-list">
                <label className="settings-global-orchestration-row">
                  <span className="settings-global-orchestration-label">{t("composer.route.mainAgent")}</span>
                  <ComposerFieldSelect
                    value={defaultOrchestrationDraft.mainAgentConfigId.trim()}
                    disabled={busy || settings.mainAgentConfigs.length === 0}
                    showPlaceholder
                    placeholder={t("composer.route.notConfigured")}
                    searchable
                    searchPlaceholder={t("composer.fieldSelect.searchMainAgent")}
                    renderOptionIcon={(option) =>
                      option.value === "__chatgpt_subscription__" ? (
                        <img src="./provider-icons/openai.svg" alt="" />
                      ) : null
                    }
                    invalid={
                      Boolean(defaultOrchestrationDraft.mainAgentConfigId.trim()) &&
                      !settings.mainAgentConfigs.some(
                        (config) => config.id === defaultOrchestrationDraft.mainAgentConfigId,
                      )
                    }
                    invalidLabel={t("settings.models.resources.missingMainAgentHint")}
                    onChange={(value) => updateDefaultOrchestrationDraft({ mainAgentConfigId: value })}
                  >
                    {defaultOrchestrationDraft.mainAgentConfigId.trim() &&
                    !settings.mainAgentConfigs.some(
                      (config) => config.id === defaultOrchestrationDraft.mainAgentConfigId,
                    ) ? (
                      <option value={defaultOrchestrationDraft.mainAgentConfigId}>
                        {t("settings.models.resources.missingMainAgentOption", {
                          id: defaultOrchestrationDraft.mainAgentConfigId,
                        })}
                      </option>
                    ) : null}
                    {settings.mainAgentConfigs.map((config) => (
                      <option key={config.id} value={config.id}>
                        {config.name} ({config.modelRef.modelId})
                      </option>
                    ))}
                  </ComposerFieldSelect>
                </label>
                <label className="settings-global-orchestration-row settings-global-orchestration-row-with-hint">
                  <span className="settings-global-orchestration-label">
                    {t("composer.route.auxiliaryModel")}
                    <span className="settings-global-orchestration-hint">
                      {t("composer.route.auxiliaryModelHint")}
                    </span>
                  </span>
                  <ModelCascadeSelect
                    value={toModelCascadeSelection(defaultAuxiliaryModel)}
                    options={mapCommitModelOptions(auxiliaryModelOptions)}
                    loading={auxiliaryModelsLoading}
                    error={auxiliaryModelsError}
                    disabled={busy}
                    clearable
                    hint={t("composer.route.auxiliaryModelHint")}
                    placeholder={t("composer.route.auxiliaryModel")}
                    renderExtra={commitModelPricingExtra}
                    onChange={(selection) =>
                      selectDefaultAuxiliaryModel(
                        selection ? toCandidateModelSelection(selection) : undefined,
                      )
                    }
                  />
                </label>
                <label className="settings-global-orchestration-row settings-global-orchestration-row-with-hint">
                  <span className="settings-global-orchestration-label">
                    {t("composer.route.approvalModel")}
                    <span className="settings-global-orchestration-hint">
                      {t("composer.route.approvalModelHint")}
                    </span>
                  </span>
                  <ModelCascadeSelect
                    value={toModelCascadeSelection(defaultApprovalModel)}
                    options={mapCommitModelOptions(approvalModelOptions)}
                    loading={approvalModelsLoading}
                    error={approvalModelsError}
                    disabled={busy}
                    clearable
                    hint={t("composer.route.approvalModelHint")}
                    placeholder={t("composer.route.approvalModel")}
                    renderExtra={approvalModelPricingExtra}
                    onChange={(selection) =>
                      selectDefaultApprovalModel(selection ? toCandidateModelSelection(selection) : undefined)
                    }
                  />
                </label>
                <label className="settings-global-orchestration-row settings-global-orchestration-row-with-hint">
                  <span className="settings-global-orchestration-label">
                    {t("composer.route.visionModel")}
                    <span className="settings-global-orchestration-hint">
                      {t("composer.route.visionModelHint")}
                    </span>
                  </span>
                  <ModelCascadeSelect
                    value={toModelCascadeSelection(defaultVisionModel)}
                    options={mapCommitModelOptions(auxiliaryModelOptions)}
                    loading={auxiliaryModelsLoading}
                    error={auxiliaryModelsError}
                    disabled={busy}
                    clearable
                    hint={t("composer.route.visionModelHint")}
                    placeholder={t("composer.route.visionModel")}
                    renderExtra={commitModelPricingExtra}
                    onChange={(selection) =>
                      selectDefaultVisionModel(selection ? toCandidateModelSelection(selection) : undefined)
                    }
                  />
                </label>
                <label className="settings-global-orchestration-row">
                  <span className="settings-global-orchestration-label">{t("composer.route.prompt")}</span>
                  <ComposerFieldSelect
                    value={
                      defaultOrchestrationDraft.mainPrompt.mode === "builtin"
                        ? "__builtin__"
                        : defaultOrchestrationDraft.mainPrompt.promptId
                    }
                    disabled={busy}
                    onChange={(value) =>
                      updateDefaultOrchestrationDraft({
                        mainPrompt:
                          value === "__builtin__"
                            ? { mode: "builtin" }
                            : { mode: "custom_append", promptId: value },
                      })
                    }
                  >
                    <option value="__builtin__">{t("composer.route.defaultBuiltinPrompt")}</option>
                    {settings.mainAgentPrompts
                      .filter((prompt) => prompt.mode === "custom_append")
                      .map((prompt) => (
                        <option key={prompt.id} value={prompt.id}>
                          {prompt.name}
                        </option>
                      ))}
                  </ComposerFieldSelect>
                </label>
                <label className="settings-global-orchestration-row">
                  <span className="settings-global-orchestration-label">
                    {t("composer.route.subagentOrchestration")}
                  </span>
                  <ComposerFieldSelect
                    value={
                      defaultOrchestrationDraft.subagents.mode === "none"
                        ? "__none__"
                        : defaultOrchestrationDraft.subagents.orchestrationId
                    }
                    disabled={busy}
                    searchable
                    searchPlaceholder={t("composer.fieldSelect.searchSubagent")}
                    onChange={(value) =>
                      updateDefaultOrchestrationDraft({
                        subagents:
                          value === "__none__"
                            ? { mode: "none" }
                            : { mode: "orchestration", orchestrationId: value },
                      })
                    }
                  >
                    <option value="__none__">{t("composer.route.noSubagents")}</option>
                    {settings.subagentOrchestrations.map((orchestration) => (
                      <option key={orchestration.id} value={orchestration.id}>
                        {orchestration.name} ({orchestration.agents.length})
                      </option>
                    ))}
                  </ComposerFieldSelect>
                </label>
              </div>
            </section>
          ) : (
            <AgentCompositionResourcesSection
              settings={settings}
              mcpServers={mcpServers}
              busy={busy}
              activeScope={runtimeConfigTab}
              onRegistryChange={refreshSettings}
              onSavingChange={onSavingChange}
              onErrorMessage={(message: string) => showProviderTestMessage("error", message)}
              {...(pendingCreateMainConfig ? { pendingCreateMainConfig } : {})}
              {...(onPendingCreateMainConfigConsumed ? { onPendingCreateMainConfigConsumed } : {})}
              {...(defaultOrchestrationSelection ? { defaultOrchestrationSelection } : {})}
              onUseMainAgentConfigAsDefault={(mainAgentConfigId) => {
                updateDefaultOrchestrationDraft({
                  mainAgentConfigId,
                  mainPrompt: { mode: "builtin" },
                  subagents: { mode: "none" },
                });
                setRuntimeConfigTab("defaults");
              }}
            />
          )}
        </>
      )}

      {providerModalOpen && (
        <ProviderEditorModal
          form={providerForm}
          setForm={setProviderForm}
          hasExistingApiKey={
            providerOptions.find((provider) => provider.id === providerForm.id)?.hasApiKey ?? false
          }
          models={modalCache?.models ?? []}
          modelsLoading={loadingForProvider(modalProviderId)}
          modelsDevOptions={modelsDevOptions}
          modelsDevLoading={modelsDevLoading}
          error={modalError}
          testingModelKey={testingProviderKey}
          busy={busy}
          onClose={closeProviderModal}
          onSave={(options) => saveProvider(options)}
          onDelete={() => void deleteProvider()}
          onRefreshModels={() => void fetchModels(providerForm)}
          onTestCandidate={(modelId) => void testProvider(providerForm, modelId)}
          oauthLoginStatus={oauthLoginStatus}
          oauthLoggingIn={oauthLoggingIn}
        />
      )}

      {createMainConfigPromptSeed ? (
        <CreateMainAgentConfigPromptDialog
          onDismiss={dismissCreateMainConfigPrompt}
          onConfirm={confirmCreateMainConfigPrompt}
        />
      ) : null}
    </>
  );
}

function ProviderEditorModal({
  form,
  setForm,
  hasExistingApiKey,
  models,
  modelsLoading,
  modelsDevOptions,
  modelsDevLoading,
  error,
  testingModelKey,
  busy,
  onClose,
  onSave,
  onDelete,
  onRefreshModels,
  onTestCandidate,
  oauthLoginStatus,
  oauthLoggingIn,
}: {
  form: ProviderConfigInput;
  setForm: Dispatch<SetStateAction<ProviderConfigInput>>;
  hasExistingApiKey: boolean;
  models: UpstreamModelOption[];
  modelsLoading: boolean;
  modelsDevOptions: readonly ModelsDevModelOption[];
  modelsDevLoading: boolean;
  error?: string | undefined;
  testingModelKey?: string | null | undefined;
  busy?: boolean | undefined;
  onClose: () => void;
  onSave: (options?: { closeOnSuccess?: boolean }) => void | Promise<ProviderConfigView | undefined>;
  onDelete: () => void;
  onRefreshModels: () => void;
  onTestCandidate: (modelId: string) => void;
  oauthLoginStatus: { isLoggedIn: boolean; message: string };
  oauthLoggingIn: boolean;
}) {
  const { t } = useTranslation();
  const isEditing = Boolean(form.id);
  const title = isEditing
    ? t("settings.models.provider.editTitle", {
        name: form.name.trim() || t("settings.models.providerFallback"),
      })
    : t("settings.models.provider.createTitle");
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    () => findPresetForForm(form)?.id ?? null,
  );
  // Editing starts with the candidate panel visible; creating starts form-only
  // and reveals the panel right after the first save.
  const [candidatesPanelOpen, setCandidatesPanelOpen] = useState(() => Boolean(form.id));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [candidateSaveError, setCandidateSaveError] = useState<string | undefined>(undefined);
  const candidatePanelRef = useRef<CandidateModelPanelHandle>(null);
  const prefersReducedMotion = useReducedMotion();
  const activePreset = selectedPresetId ? getProviderPresetById(selectedPresetId) : undefined;
  const apiCompat = form.apiCompat ?? "anthropic";
  const formError = error ?? candidateSaveError;

  async function handleSaveProvider() {
    setCandidateSaveError(undefined);
    try {
      if (isEditing && form.id) {
        await candidatePanelRef.current?.savePendingEdits();
      }
      // On create: save and stay open so candidate models can be added immediately.
      // On edit: save and close.
      await onSave({ closeOnSuccess: isEditing });
    } catch (caught) {
      setCandidateSaveError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  useEffect(() => {
    // Candidate models are the primary place to pick/test models —
    // reveal the panel as soon as a provider exists (edit, or right after first save).
    if (form.id) {
      setCandidatesPanelOpen(true);
    }
  }, [form.id]);

  const selectedPreset = selectedPresetId ? getProviderPresetById(selectedPresetId) : undefined;
  // ChatGPT OAuth is a built-in account connection, not a provider preset
  // users create manually. It is kept in the preset catalogue for migration
  // and matching existing records, but never offered in the editor.
  const visiblePresets = MAINSTREAM_PROVIDER_PRESETS.filter((preset) => preset.id !== "chatgpt-subscription");
  const selectedPresetVariants = selectedPreset ? getProviderPresetEndpointVariants(selectedPreset) : [];
  const endpointOptions: EndpointCompatOption[] =
    selectedPreset && selectedPresetVariants.length > 0
      ? selectedPresetVariants
      : [
          { apiCompat: "anthropic", requestPath: "/anthropic" },
          { apiCompat: "openai_responses", requestPath: "/openai" },
          { apiCompat: "openai_chat_completions", requestPath: "/" },
          { apiCompat: "system_one", requestPath: "" },
        ];
  const endpointDisabled = busy || endpointOptions.length <= 1;

  function handleApiCompatChange(nextApiCompat: NonNullable<ProviderConfigInput["apiCompat"]>) {
    if (selectedPreset) {
      const variant = findPresetEndpointVariant(selectedPreset, nextApiCompat);
      if (!variant) {
        return;
      }
      setForm((current) => ({
        ...current,
        apiCompat: variant.apiCompat,
        requestPath: variant.requestPath,
        version: variant.version ?? selectedPreset.version,
      }));
      return;
    }
    setForm((current) => ({ ...current, apiCompat: nextApiCompat }));
  }

  return (
    <div className="settings-modal-backdrop">
      <button
        type="button"
        className="settings-modal-backdrop-close"
        onClick={onClose}
        aria-label={t("common.close")}
        title={t("common.close")}
        disabled={busy}
      />
      <div
        className={`settings-modal settings-modal-provider-editor${candidatesPanelOpen ? " is-candidates-open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-modal-title"
      >
        <header className="settings-modal-header">
          <h2 id="provider-modal-title" className="settings-modal-title">
            {title}
          </h2>
          <div className="settings-modal-header-actions">
            {form.id ? (
              <button
                type="button"
                className={`candidate-panel-toggle${candidatesPanelOpen ? " is-open" : ""}`}
                onClick={() => setCandidatesPanelOpen((v) => !v)}
                aria-expanded={candidatesPanelOpen}
                title={
                  candidatesPanelOpen
                    ? t("settings.models.provider.collapseCandidates")
                    : t("settings.models.provider.expandCandidates")
                }
              >
                <ChevronRight size={14} className="candidate-panel-toggle-icon" aria-hidden />
                {t("settings.models.candidateModels")}
              </button>
            ) : null}
            <button
              type="button"
              className="mcp-icon-button"
              onClick={onClose}
              aria-label={t("common.close")}
              title={t("common.close")}
              disabled={busy}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="provider-modal-layout">
          <div className="provider-modal-form-main settings-modal-body mcp-editor-form models-editor-form">
            <section className="provider-form-section">
              <h3 className="provider-form-section-title">{t("settings.models.provider.basicInfo")}</h3>
              <div className="mcp-field models-provider-preset-field">
                <span className="mcp-field-label">{t("settings.models.provider.preset")}</span>
                <ProviderPresetTabs
                  presets={visiblePresets}
                  {...(selectedPresetId === null ? {} : { activePresetId: selectedPresetId })}
                  {...(busy === undefined ? {} : { disabled: busy })}
                  onSelectManual={() => setSelectedPresetId(null)}
                  onSelectPreset={(preset) => {
                    setSelectedPresetId(preset.id);
                    setForm((current) => applyProviderPreset(current, preset));
                  }}
                />
              </div>

              <label className="mcp-field">
                <span className="mcp-field-label">{t("settings.models.provider.name")}</span>
                <input
                  className="mcp-field-input"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                />
              </label>

              <label className="mcp-field models-toggle-field provider-enable-row">
                <span className="mcp-field-label">{t("settings.models.provider.enable")}</span>
                <label
                  className="mcp-toggle mcp-toggle-sm"
                  title={form.enabled ? t("common.enabled") : t("common.disabled")}
                >
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    disabled={busy}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, enabled: event.target.checked }))
                    }
                  />
                  <span className="mcp-toggle-track" aria-hidden />
                </label>
              </label>
            </section>

            <section className="provider-form-section">
              <h3 className="provider-form-section-title">{t("settings.models.provider.authMethod")}</h3>
              {form.authMethod === "chatgpt_subscription" ? (
                <p className="mcp-field-hint">
                  这是系统自动管理的 ChatGPT 账号连接。请在“ChatGPT 账号”页完成登录；这里不填写 API Key。
                </p>
              ) : (
                <label className="mcp-field">
                <span className="models-provider-label-row">
                  <span className="mcp-field-label">{t("settings.models.provider.apiKey")}</span>
                  {activePreset ? (
                    <a
                      className="models-provider-inline-link"
                      href={activePreset.apiKeyUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <LinkIcon size={12} />
                      {t("settings.models.provider.createKey")}
                    </a>
                  ) : null}
                </span>
                <input
                  className="mcp-field-input"
                  type="password"
                  value={form.apiKey ?? ""}
                  placeholder={hasExistingApiKey ? "••••••" : undefined}
                  onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                />
                {hasExistingApiKey && !(form.apiKey ?? "").trim() ? (
                  <span className="mcp-field-hint">{t("settings.models.provider.keepKey")}</span>
                ) : null}
                </label>
              )}
            </section>

            <section className="provider-form-section">
              <h3 className="provider-form-section-title">{t("settings.models.provider.connection")}</h3>
              {form.authMethod === "chatgpt_subscription" ? (
                <div className="provider-fixed-connection">
                  <div><span>官方 Responses API</span><strong>https://api.openai.com/v1/responses</strong></div>
                  <p>连接地址由系统固定管理。账号代理在 ChatGPT 账号页单独配置。</p>
                </div>
              ) : (
                <>
                <label className="mcp-field">
                  <span className="mcp-field-label">baseURL</span>
                  <input
                    className="mcp-field-input"
                    value={form.baseUrl}
                    placeholder="https://api.deepseek.com"
                    onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                  />
                </label>

                <div className="mcp-field models-provider-endpoint-row">
                  <span className="mcp-field-label">{t("settings.models.provider.endpoint")}</span>
                  <div className="models-provider-endpoint-stack">
                    <EndpointCompatSelect
                      options={endpointOptions}
                      activeApiCompat={apiCompat}
                      onChange={handleApiCompatChange}
                      disabled={endpointDisabled}
                    />
                    <input
                      className="mcp-field-input models-provider-request-path-input"
                      value={form.requestPath ?? ""}
                      placeholder={requestPathPlaceholderForApiCompat(apiCompat)}
                      disabled={busy}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, requestPath: event.target.value }))
                      }
                    />
                  </div>
                </div>

                <label className="mcp-field">
                  <span className="mcp-field-label">{t("settings.models.provider.version")}</span>
                  <input
                    className="mcp-field-input"
                    value={form.version ?? "v1"}
                    placeholder="v1"
                    disabled={busy}
                    onChange={(event) => setForm((current) => ({ ...current, version: event.target.value }))}
                  />
                  <span className="mcp-field-hint">{t("settings.models.provider.versionHint")}</span>
                </label>
                </>
              )}
            </section>

            <section className="provider-form-section provider-advanced-section">
              <button
                type="button"
                className="provider-advanced-toggle"
                aria-expanded={advancedOpen}
                aria-controls="provider-advanced-body"
                onClick={() => setAdvancedOpen((v) => !v)}
              >
                <span>{t("settings.models.provider.advanced")}</span>
                <ChevronDown size={15} className="provider-advanced-toggle-icon" aria-hidden />
              </button>
              <AnimatePresence initial={false}>
                {advancedOpen ? (
                  <motion.div
                    key="provider-advanced-body"
                    id="provider-advanced-body"
                    className="provider-advanced-body"
                    initial={prefersReducedMotion ? false : { height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={
                      prefersReducedMotion ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.34 }
                    }
                  >
                    {form.authMethod === "chatgpt_subscription" ? (
                      <div className="provider-account-proxy-note">
                        <Network size={15} />
                        <span>ChatGPT 使用账号级代理。请到 ChatGPT 账号页为每个账号分别设置。</span>
                      </div>
                    ) : (
                      <label className="mcp-field">
                        <span className="mcp-field-label">{t("settings.models.provider.upstreamProxy")}</span>
                        <input
                          className="mcp-field-input"
                          value={form.upstreamProxyUrl ?? ""}
                          placeholder="socks5://127.0.0.1:7890"
                          disabled={busy}
                          onChange={(event) =>
                            setForm((current) => ({ ...current, upstreamProxyUrl: event.target.value }))
                          }
                        />
                        <span className="mcp-field-hint">
                          {t("settings.models.provider.upstreamProxyHint")}
                        </span>
                      </label>
                    )}
                    <label className="mcp-field">
                      <span className="mcp-field-label">{t("settings.models.provider.tokenCountMode")}</span>
                      <select
                        className="mcp-field-input"
                        value={form.tokenCountMode ?? "local_heuristic"}
                        disabled={busy}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            tokenCountMode: event.target.value as NonNullable<
                              ProviderConfigInput["tokenCountMode"]
                            >,
                          }))
                        }
                      >
                        <option value="local_heuristic">
                          {t("settings.models.provider.localHeuristic")}
                        </option>
                        <option value="anthropic_messages">
                          {t("settings.models.provider.anthropicCount")}
                        </option>
                        <option value="openai_responses">OpenAI /v1/responses/input_tokens</option>
                        <option value="llama_tokenize">llama.cpp /apply-template + /tokenize</option>
                      </select>
                      <span className="mcp-field-hint">{t("settings.models.provider.tokenCountHint")}</span>
                    </label>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </section>

            {formError ? (
              <div className="provider-form-error" role="alert">
                {formError}
              </div>
            ) : null}
          </div>

          {/* Keep the panel mounted once a provider exists: collapsing only hides it,
              so in-progress candidate edits survive and save on submit. */}
          {form.id ? (
            <CandidateModelPanel
              ref={candidatePanelRef}
              providerId={form.id}
              models={models}
              modelsLoading={modelsLoading}
              modelsDevOptions={modelsDevOptions}
              modelsDevLoading={modelsDevLoading}
              busy={busy}
              testingModelKey={testingModelKey}
              onRefreshModels={onRefreshModels}
              onTestModel={onTestCandidate}
            />
          ) : null}
        </div>

        <footer className="settings-modal-footer settings-modal-footer-split">
          {isEditing ? (
            <button type="button" className="mcp-uninstall-button" onClick={onDelete} disabled={busy}>
              <Trash2 size={16} />
              {t("common.delete")}
            </button>
          ) : (
            <span />
          )}
          <div className="settings-modal-footer-actions">
            <button type="button" className="settings-modal-cancel" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="mcp-save-button"
              disabled={busy}
              onClick={() => void handleSaveProvider()}
            >
              {isEditing ? t("common.save") : t("settings.models.provider.saveAndAdd")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function formatModelPreview(modelId: string): string {
  const normalized = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  if (normalized.length <= 22) {
    return normalized;
  }
  return `${normalized.slice(0, 10)}…${normalized.slice(-10)}`;
}

function formatProviderDeleteReference(
  reference: ProviderDeleteReference,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const key = {
    route_profile: "settings.models.providerDeleteReference.routeProfile",
    main_agent_config: "settings.models.providerDeleteReference.mainAgentConfig",
    subagent_orchestration: "settings.models.providerDeleteReference.subagentOrchestration",
    active_thread: "settings.models.providerDeleteReference.activeThread",
  }[reference.kind];
  return t(key, { name: reference.name });
}

function localizeProviderRequestError(
  error: ProviderRequestError,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (error.errorCode) {
    case "provider_not_found":
      return t("settings.models.providerNotFound", {
        id: error.providerId || t("settings.models.providerFallback"),
      });
    case "provider_base_url_missing":
      return t("settings.models.providerBaseUrlMissing", {
        name: error.providerName || t("settings.models.providerFallback"),
      });
    case "base_url_missing":
      return t("settings.models.baseUrlRequired");
    default:
      return error.error || t("settings.models.testFailed");
  }
}

function providerToForm(provider?: ProviderConfigView): ProviderConfigInput {
  const form: ProviderConfigInput = {
    name: provider?.name ?? "Anthropic compatible",
    baseUrl: provider?.baseUrl ?? "https://api.anthropic.com",
    requestPath: provider?.requestPath ?? "",
    version: provider?.version ?? "v1",
    apiCompat: provider?.apiCompat ?? "anthropic",
    tokenCountMode: provider?.tokenCountMode ?? "local_heuristic",
    apiKey: "",
    ...(provider?.authMethod ? { authMethod: provider.authMethod } : {}),
    ...(provider?.credentialPoolId ? { credentialPoolId: provider.credentialPoolId } : {}),
    upstreamProxyUrl: provider?.upstreamProxyUrl ?? "",
    defaultModel: provider?.defaultModel ?? "",
    enabled: provider?.enabled ?? true,
  };
  if (provider) {
    form.id = provider.id;
  }
  return form;
}
