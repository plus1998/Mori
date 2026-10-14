import {
  type AgentConfigSource,
  type AgentInstanceConfig,
  type AgentTemplate,
  CODING_AGENT_TEMPLATE_IDS,
  isV4aTeachingEnabled,
  type MainAgentConfigResource,
  type MainAgentPromptResource,
  resolveAgentTemplateCatalog,
  type SubagentOrchestrationResource,
} from "../shared/agent-orchestration";
import type { ModelRef, ProviderConfigView, ThinkingEffort, UpstreamApiCompat } from "../shared/ipc";
import { defaultThemeColorForAgentKey, normalizeThemeColorHex } from "../shared/subagent-theme";
import { i18n } from "./i18n";
import {
  capabilityFieldsToToolPolicy,
  createDefaultToolCapabilityFields,
  type ToolCapabilityFieldValues,
  toolPolicyToCapabilityFields,
} from "./tool-capability-groups";

export type AgentResourceAgentCapabilityFields = Omit<ToolCapabilityFieldValues, "allowDelegation">;

export interface AgentResourceAgentFormState extends AgentResourceAgentCapabilityFields {
  agentKey: string;
  templateId: string;
  displayName: string;
  themeColor: string;
  providerId: string;
  modelId: string;
  thinkingEffort: string;
  apiCompat: string;
  enabled: boolean;
  candidateModelId: string;
  /** Optional Codex apply_patch V4A teaching in agent instructions. Default false. */
  v4aTeachingEnabled: boolean;
}

export interface AgentResourceFormState {
  id: string;
  name: string;
  source: Extract<AgentConfigSource, "user" | "project">;
  mainName: string;
  mainProviderId: string;
  mainModelId: string;
  mainThinkingEffort: string;
  mainApiCompat: string;
  mainCandidateModelId: string;
  mainSystemPromptPreset: "core_native" | "custom_append";
  mainPrompt: string;
  /** Optional Codex apply_patch V4A teaching in main-agent instructions. Default false. */
  mainV4aTeachingEnabled: boolean;
  mainReadCodebase: boolean;
  mainReadScope: ToolCapabilityFieldValues["readScope"];
  mainWriteCodebase: boolean;
  mainBash: boolean;
  mainNetwork: boolean;
  mainSkill: boolean;
  mainAskUser: boolean;
  mainTaskProgress: boolean;
  mainAllowDelegation: boolean;
  mainAdvancedDisallowedTools: string;
  mainCodexSandboxOverride: ToolCapabilityFieldValues["codexSandboxOverride"];
  guidancePrompt: string;
  agents: AgentResourceAgentFormState[];
}

interface ResourceFormOptions {
  existingIds?: readonly string[];
  existingNames?: readonly string[];
  providers?: readonly ProviderConfigView[];
  templates?: readonly AgentTemplate[];
}

const RESERVED_AGENT_KEYS = new Set([
  "assistant",
  "eco_explore",
  "explore",
  "general-purpose",
  "main",
  "plan",
  "planner",
  "statusline-setup",
  "system",
  "thinking",
  "tool",
  "user",
]);

export function mainCapabilityFromResourceForm(form: AgentResourceFormState): ToolCapabilityFieldValues {
  return {
    readCodebase: form.mainReadCodebase,
    readScope: form.mainReadScope,
    writeCodebase: form.mainWriteCodebase,
    bash: form.mainBash,
    network: form.mainNetwork,
    skill: form.mainSkill,
    askUser: form.mainAskUser,
    taskProgress: form.mainTaskProgress,
    allowDelegation: form.mainAllowDelegation,
    advancedDisallowedTools: form.mainAdvancedDisallowedTools,
    codexSandboxOverride: form.mainCodexSandboxOverride,
  };
}

export function agentCapabilityFromAgentForm(
  agent: AgentResourceAgentFormState,
): AgentResourceAgentCapabilityFields {
  return {
    readCodebase: agent.readCodebase,
    readScope: agent.readScope,
    writeCodebase: agent.writeCodebase,
    bash: agent.bash,
    network: agent.network,
    skill: agent.skill,
    askUser: agent.askUser,
    taskProgress: agent.taskProgress,
    advancedDisallowedTools: agent.advancedDisallowedTools,
    codexSandboxOverride: agent.codexSandboxOverride,
  };
}

export function mainCapabilityPatchToResourceForm(
  patch: Partial<ToolCapabilityFieldValues>,
): Partial<AgentResourceFormState> {
  const result: Partial<AgentResourceFormState> = {};
  if (patch.readCodebase !== undefined) result.mainReadCodebase = patch.readCodebase;
  if (patch.readScope !== undefined) result.mainReadScope = patch.readScope;
  if (patch.writeCodebase !== undefined) result.mainWriteCodebase = patch.writeCodebase;
  if (patch.bash !== undefined) result.mainBash = patch.bash;
  if (patch.network !== undefined) result.mainNetwork = patch.network;
  if (patch.skill !== undefined) result.mainSkill = patch.skill;
  if (patch.askUser !== undefined) result.mainAskUser = patch.askUser;
  if (patch.taskProgress !== undefined) result.mainTaskProgress = patch.taskProgress;
  if (patch.allowDelegation !== undefined) result.mainAllowDelegation = patch.allowDelegation;
  if (patch.advancedDisallowedTools !== undefined) {
    result.mainAdvancedDisallowedTools = patch.advancedDisallowedTools;
  }
  if (patch.codexSandboxOverride !== undefined) {
    result.mainCodexSandboxOverride = patch.codexSandboxOverride;
  }
  return result;
}

export function agentCapabilityPatchToAgentForm(
  patch: Partial<AgentResourceAgentCapabilityFields>,
): Partial<AgentResourceAgentFormState> {
  return patch;
}

export function createBlankAgentResourceForm(options: ResourceFormOptions = {}): AgentResourceFormState {
  const provider = selectDefaultProvider(options.providers ?? []);
  const templates = resolveAgentTemplateCatalog(options.templates ?? []);
  const exploreTemplate = templates.find((template) => template.id === CODING_AGENT_TEMPLATE_IDS.explore);
  const mainCapability = createDefaultToolCapabilityFields({
    writeCodebase: true,
    bash: true,
    network: true,
    taskProgress: true,
    allowDelegation: true,
    askUser: true,
  });
  return {
    id: createUniqueResourceId("user.custom.main", options.existingIds ?? []),
    name: createUniqueResourceName(
      i18n.t("orchestrationResource.customResourceName"),
      options.existingNames ?? [],
    ),
    source: "user",
    mainName: i18n.t("settings.models.mainAgent"),
    mainProviderId: provider?.id ?? "",
    mainModelId: provider?.defaultModel ?? "",
    mainThinkingEffort: "",
    mainApiCompat: "",
    mainCandidateModelId: "",
    mainSystemPromptPreset: "core_native",
    mainPrompt:
      "Coordinate the task and call specialized agents only when they materially improve the result.",
    mainV4aTeachingEnabled: false,
    ...mainCapabilityToResourceFormFields(mainCapability),
    guidancePrompt: "Choose agents autonomously based on the user's task and the available agent roster.",
    agents: exploreTemplate
      ? [createResourceAgentFormFromTemplate(exploreTemplate, { ...(provider && { provider }) })]
      : [],
  };
}

export function createBlankMainAgentConfigForm(options: ResourceFormOptions = {}): AgentResourceFormState {
  const form = createBlankAgentResourceForm(options);
  return {
    ...form,
    id: createUniqueResourceId("user.custom.main", options.existingIds ?? []),
    name: createUniqueResourceName("主代理配置", options.existingNames ?? []),
    agents: [],
    guidancePrompt: "",
    mainSystemPromptPreset: "core_native",
    mainPrompt: "",
  };
}

export function createBlankMainAgentPromptForm(options: ResourceFormOptions = {}): AgentResourceFormState {
  const form = createBlankAgentResourceForm(options);
  return {
    ...form,
    id: createUniqueResourceId("user.custom.prompt", options.existingIds ?? []),
    name: createUniqueResourceName("自定义提示词", options.existingNames ?? []),
    agents: [],
    guidancePrompt: "",
    mainSystemPromptPreset: "custom_append",
    mainPrompt: "",
  };
}

export function createBlankSubagentOrchestrationForm(
  options: ResourceFormOptions = {},
): AgentResourceFormState {
  const form = createBlankAgentResourceForm(options);
  return {
    ...form,
    id: createUniqueResourceId("user.custom.orchestration", options.existingIds ?? []),
    name: createUniqueResourceName("子代理编排", options.existingNames ?? []),
    mainProviderId: "",
    mainModelId: "",
    mainCandidateModelId: "",
  };
}

export function mainAgentConfigToForm(config: MainAgentConfigResource): AgentResourceFormState {
  const mainCapability = toolPolicyToCapabilityFields(config.tools, {
    allowDelegation: true,
  });
  return {
    id: config.id,
    name: config.name,
    source: config.source === "project" ? "project" : "user",
    mainName: config.name,
    mainProviderId: config.modelRef.providerId,
    mainModelId: config.modelRef.modelId,
    mainThinkingEffort: config.modelRef.thinkingEffort ?? "",
    mainApiCompat: config.modelRef.apiCompat ?? "",
    mainCandidateModelId: config.modelRef.candidateModelId ?? "",
    mainSystemPromptPreset: "core_native",
    mainPrompt: "",
    mainV4aTeachingEnabled: isV4aTeachingEnabled(config),
    ...mainCapabilityToResourceFormFields(mainCapability),
    guidancePrompt: "",
    agents: [],
  };
}

export function mainAgentPromptToForm(prompt: MainAgentPromptResource): AgentResourceFormState {
  const blank = createBlankMainAgentPromptForm();
  return {
    ...blank,
    id: prompt.id,
    name: prompt.name,
    source: prompt.source === "project" ? "project" : "user",
    mainSystemPromptPreset: "custom_append",
    mainPrompt: prompt.prompt,
  };
}

export function subagentOrchestrationToForm(
  orchestration: SubagentOrchestrationResource,
  templates: readonly AgentTemplate[] = [],
): AgentResourceFormState {
  const blank = createBlankSubagentOrchestrationForm({ templates });
  return {
    ...blank,
    id: orchestration.id,
    name: orchestration.name,
    source: orchestration.source === "project" ? "project" : "user",
    guidancePrompt: orchestration.strategy.guidancePrompt ?? "",
    agents: orchestration.agents.map((agent) => agentInstanceToForm(agent)),
  };
}

export function createCopiedMainAgentConfigForm(
  config: MainAgentConfigResource,
  options: ResourceFormOptions = {},
): AgentResourceFormState {
  const form = mainAgentConfigToForm(config);
  return {
    ...form,
    id: createUniqueResourceId(userResourceIdFrom(config.id), options.existingIds ?? []),
    name: createUniqueResourceName(`${config.name} Copy`, options.existingNames ?? []),
    source: "user",
  };
}

export function createCopiedMainAgentPromptForm(
  prompt: MainAgentPromptResource,
  options: ResourceFormOptions = {},
): AgentResourceFormState {
  const form = mainAgentPromptToForm(prompt);
  return {
    ...form,
    id: createUniqueResourceId(userResourceIdFrom(prompt.id), options.existingIds ?? []),
    name: createUniqueResourceName(`${prompt.name} Copy`, options.existingNames ?? []),
    source: "user",
  };
}

export function createCopiedSubagentOrchestrationForm(
  orchestration: SubagentOrchestrationResource,
  options: ResourceFormOptions = {},
): AgentResourceFormState {
  const form = subagentOrchestrationToForm(orchestration, options.templates);
  return {
    ...form,
    id: createUniqueResourceId(userResourceIdFrom(orchestration.id), options.existingIds ?? []),
    name: createUniqueResourceName(`${orchestration.name} Copy`, options.existingNames ?? []),
    source: "user",
  };
}

export function createResourceAgentFormFromTemplate(
  template: AgentTemplate,
  options: { provider?: ProviderConfigView; existingAgentKeys?: readonly string[] } = {},
): AgentResourceAgentFormState {
  const capability = toolPolicyToCapabilityFields(template.defaultTools);
  return {
    agentKey: createUniqueAgentKey(defaultAgentKeyFromTemplate(template), options.existingAgentKeys ?? []),
    templateId: template.id,
    displayName: template.name,
    themeColor: defaultThemeColorForAgentKey(defaultAgentKeyFromTemplate(template)),
    providerId: options.provider?.id ?? "",
    modelId: options.provider?.defaultModel ?? "",
    thinkingEffort: "",
    apiCompat: "",
    enabled: true,
    candidateModelId: "",
    v4aTeachingEnabled: false,
    ...agentCapabilityToAgentForm(capability),
  };
}

export function buildMainAgentConfigFromForm(
  form: AgentResourceFormState,
  options: {
    existing?: MainAgentConfigResource;
    nowIso?: string;
  } = {},
): MainAgentConfigResource {
  const id = form.id.trim();
  const name = form.mainName.trim() || form.name.trim();
  if (!id) {
    throw new Error(i18n.t("orchestrationResource.validation.idRequired"));
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(i18n.t("orchestrationResource.validation.idFormat"));
  }
  if (id.startsWith("builtin.")) {
    throw new Error(i18n.t("orchestrationResource.validation.reservedId"));
  }
  if (!name) {
    throw new Error(i18n.t("orchestrationResource.validation.nameRequired"));
  }
  assertCandidateModelSelected(i18n.t("settings.models.mainAgent"), form.mainCandidateModelId);
  return {
    id,
    name,
    agentKey: "main",
    modelRef: buildModelRef(form.mainProviderId, form.mainModelId, {
      thinkingEffort: form.mainThinkingEffort,
      apiCompat: form.mainApiCompat,
      candidateModelId: form.mainCandidateModelId,
    }),
    tools: capabilityFieldsToToolPolicy(mainCapabilityFromResourceForm(form)),
    skills: options.existing ? [...options.existing.skills] : [],
    ...(form.mainV4aTeachingEnabled ? { v4aTeachingEnabled: true } : {}),
    updatedAt: options.nowIso ?? new Date().toISOString(),
    source: form.source,
  };
}

export function buildMainAgentPromptFromForm(
  form: AgentResourceFormState,
  options: {
    existing?: MainAgentPromptResource;
    nowIso?: string;
  } = {},
): MainAgentPromptResource {
  const id = form.id.trim();
  const name = form.name.trim();
  const prompt = form.mainPrompt.trim();
  if (!id) {
    throw new Error(i18n.t("orchestrationResource.validation.idRequired"));
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(i18n.t("orchestrationResource.validation.idFormat"));
  }
  if (!name) {
    throw new Error(i18n.t("orchestrationResource.validation.nameRequired"));
  }
  if (!prompt) {
    throw new Error("自定义提示词正文不能为空。");
  }
  return {
    id,
    name,
    mode: "custom_append",
    prompt,
    updatedAt: options.nowIso ?? new Date().toISOString(),
    source: form.source,
  };
}

export function buildSubagentOrchestrationFromForm(
  form: AgentResourceFormState,
  options: {
    existing?: SubagentOrchestrationResource;
    templates: readonly AgentTemplate[];
    nowIso?: string;
  },
): SubagentOrchestrationResource {
  const id = form.id.trim();
  const name = form.name.trim();
  if (!id) {
    throw new Error(i18n.t("orchestrationResource.validation.idRequired"));
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(i18n.t("orchestrationResource.validation.idFormat"));
  }
  if (!name) {
    throw new Error(i18n.t("orchestrationResource.validation.nameRequired"));
  }
  const agents = buildAgentsFromForm(form, options);
  return {
    id,
    name,
    agents,
    strategy: buildStrategyFromForm(form),
    updatedAt: options.nowIso ?? new Date().toISOString(),
    source: form.source,
  };
}

export function canEditStoredCompositionResource(
  source: AgentConfigSource,
): source is Extract<AgentConfigSource, "user" | "project"> {
  return source === "user" || source === "project";
}

export { tryFormToManualSpec } from "./agent-resource-manual-spec-form";

function agentInstanceToForm(agent: AgentInstanceConfig): AgentResourceAgentFormState {
  const capability = toolPolicyToCapabilityFields(agent.tools);
  return {
    agentKey: agent.agentKey,
    templateId: agent.templateId,
    displayName: agent.displayName ?? "",
    themeColor: agent.themeColor ?? defaultThemeColorForAgentKey(agent.agentKey),
    providerId: agent.modelRef.providerId,
    modelId: agent.modelRef.modelId,
    thinkingEffort: agent.modelRef.thinkingEffort ?? "",
    apiCompat: agent.modelRef.apiCompat ?? "",
    enabled: agent.enabled,
    candidateModelId: agent.modelRef.candidateModelId ?? "",
    v4aTeachingEnabled: isV4aTeachingEnabled(agent),
    ...agentCapabilityToAgentForm(capability),
  };
}

function buildAgentsFromForm(
  form: AgentResourceFormState,
  options: {
    existing?: SubagentOrchestrationResource;
    templates: readonly AgentTemplate[];
  },
): AgentInstanceConfig[] {
  const templateById = new Map(
    resolveAgentTemplateCatalog(options.templates).map((template) => [template.id, template]),
  );
  const existingAgentByKey = new Map(
    (options.existing?.agents ?? []).map((agent) => [agent.agentKey, agent]),
  );
  const agentKeys = new Set<string>();
  return form.agents.map((agentForm) => {
    const agentKey = normalizeAgentKey(
      agentForm.agentKey,
      agentForm.templateId === CODING_AGENT_TEMPLATE_IDS.explore,
    );
    if (agentKeys.has(agentKey)) {
      throw new Error(i18n.t("orchestrationResource.validation.duplicateKey", { key: agentKey }));
    }
    agentKeys.add(agentKey);
    const template = templateById.get(agentForm.templateId);
    if (!template) {
      throw new Error(
        i18n.t("orchestrationResource.validation.templateNotFound", { id: agentForm.templateId }),
      );
    }
    const existingAgent = existingAgentByKey.get(agentForm.agentKey.trim());
    const displayName = agentForm.displayName.trim() || existingAgent?.displayName || template.name;
    if (agentForm.enabled) {
      assertCandidateModelSelected(displayName, agentForm.candidateModelId);
    }
    const themeColor = resolveStoredThemeColor(
      displayName,
      agentForm.themeColor,
      defaultThemeColorForAgentKey(agentKey),
    );
    const tools = capabilityFieldsToToolPolicy({
      ...agentCapabilityFromAgentForm(agentForm),
      allowDelegation: template.allowDelegation,
    });
    return {
      agentKey,
      templateId: template.id,
      displayName,
      ...(themeColor && { themeColor }),
      modelRef: buildModelRef(agentForm.providerId, agentForm.modelId, {
        thinkingEffort: agentForm.thinkingEffort,
        apiCompat: agentForm.apiCompat,
        candidateModelId: agentForm.candidateModelId,
      }),
      tools,
      mcpServers: [],
      skills: existingAgent ? [...existingAgent.skills] : [],
      enabled: agentForm.enabled,
      ...(agentForm.v4aTeachingEnabled ? { v4aTeachingEnabled: true } : {}),
    };
  });
}

function buildStrategyFromForm(form: AgentResourceFormState) {
  return {
    kind: "autonomous" as const,
    ...(form.guidancePrompt.trim() ? { guidancePrompt: form.guidancePrompt.trim() } : {}),
  };
}

function agentCapabilityToAgentForm(
  capability: ToolCapabilityFieldValues,
): AgentResourceAgentCapabilityFields {
  return {
    readCodebase: capability.readCodebase,
    readScope: capability.readScope,
    writeCodebase: capability.writeCodebase,
    bash: capability.bash,
    network: capability.network,
    skill: capability.skill,
    askUser: capability.askUser,
    taskProgress: capability.taskProgress,
    advancedDisallowedTools: capability.advancedDisallowedTools,
    codexSandboxOverride: capability.codexSandboxOverride,
  };
}

function mainCapabilityToResourceFormFields(
  capability: ToolCapabilityFieldValues,
): Pick<
  AgentResourceFormState,
  | "mainReadCodebase"
  | "mainReadScope"
  | "mainWriteCodebase"
  | "mainBash"
  | "mainNetwork"
  | "mainSkill"
  | "mainAskUser"
  | "mainTaskProgress"
  | "mainAllowDelegation"
  | "mainAdvancedDisallowedTools"
  | "mainCodexSandboxOverride"
> {
  return {
    mainReadCodebase: capability.readCodebase,
    mainReadScope: capability.readScope,
    mainWriteCodebase: capability.writeCodebase,
    mainBash: capability.bash,
    mainNetwork: capability.network,
    mainSkill: capability.skill,
    mainAskUser: capability.askUser,
    mainTaskProgress: capability.taskProgress,
    mainAllowDelegation: capability.allowDelegation,
    mainAdvancedDisallowedTools: capability.advancedDisallowedTools,
    mainCodexSandboxOverride: capability.codexSandboxOverride,
  };
}

function assertCandidateModelSelected(label: string, candidateModelId: string): void {
  if (!candidateModelId.trim()) {
    throw new Error(i18n.t("orchestrationResource.validation.candidateRequired", { label }));
  }
}

function resolveStoredThemeColor(label: string, value: string, defaultColor: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === defaultColor.toUpperCase()) {
    return undefined;
  }
  try {
    return normalizeThemeColorHex(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} ${message}`);
  }
}

function buildModelRef(
  providerId: string,
  modelId: string,
  options?: {
    thinkingEffort?: string;
    apiCompat?: string;
    candidateModelId?: string;
  },
): ModelRef {
  const provider = providerId.trim();
  const model = modelId.trim();
  if (!provider || !model) {
    throw new Error(i18n.t("orchestrationResource.validation.providerAndModelRequired"));
  }
  const thinkingEffort = options?.thinkingEffort?.trim();
  const apiCompat = options?.apiCompat?.trim();
  const candidateModelId = options?.candidateModelId?.trim();
  const modelRef: ModelRef = {
    providerId: provider,
    modelId: model,
  };
  if (thinkingEffort) {
    modelRef.thinkingEffort = thinkingEffort as ThinkingEffort;
  }
  if (apiCompat) {
    modelRef.apiCompat = apiCompat as UpstreamApiCompat;
  }
  if (candidateModelId) {
    modelRef.candidateModelId = candidateModelId;
  }
  return modelRef;
}

function normalizeAgentKey(raw: string, allowExplore = false): string {
  const agentKey = raw.trim();
  if (!agentKey) {
    throw new Error(i18n.t("orchestrationResource.validation.keyRequired"));
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(agentKey)) {
    throw new Error(i18n.t("orchestrationResource.validation.keyFormat"));
  }
  if (RESERVED_AGENT_KEYS.has(agentKey.toLowerCase()) && !(allowExplore && agentKey === "explore")) {
    throw new Error(i18n.t("orchestrationResource.validation.keyReserved", { key: agentKey }));
  }
  return agentKey;
}

function defaultAgentKeyFromTemplate(template: AgentTemplate): string {
  const last = template.id.split(".").pop() ?? template.name;
  return sanitizeAgentKey(last) || "agent";
}

function sanitizeAgentKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function createUniqueAgentKey(base: string, existing: readonly string[]): string {
  const normalizedBase = sanitizeAgentKey(base) || "agent";
  const used = new Set(existing);
  if (!used.has(normalizedBase)) {
    return normalizedBase;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${normalizedBase}_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function createUniqueResourceId(base: string, existing: readonly string[]): string {
  const used = new Set(existing);
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function createUniqueResourceName(base: string, existing: readonly string[]): string {
  const used = new Set(existing);
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

function userResourceIdFrom(id: string): string {
  const cleaned = id
    .trim()
    .replace(/^builtin\./, "user.")
    .replace(/^derived\./, "user.")
    .replace(/[^a-zA-Z0-9._-]+/g, "_");
  return cleaned.startsWith("user.") ? cleaned : `user.${cleaned || "resource"}`;
}

function selectDefaultProvider(providers: readonly ProviderConfigView[]): ProviderConfigView | undefined {
  providers = providers.filter((provider) => provider.apiCompat !== "system_one");
  return (
    providers.find((provider) => provider.enabled && provider.defaultModel.trim()) ??
    providers.find((provider) => provider.defaultModel.trim())
  );
}
