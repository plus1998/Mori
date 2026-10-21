import {
  CHATGPT_SUBSCRIPTION_MAIN_AGENT_CONFIG_ID,
  OPENAI_OFFICIAL_MAIN_AGENT_CONFIG_ID,
} from "../shared/agent-orchestration";
import type {
  AgentTemplate,
  MainAgentConfigResource,
  MainAgentPromptResource,
  ModelSettingsSnapshot,
  ProviderConfigView,
  SubagentOrchestrationResource,
} from "../shared/ipc";
import type { MainAgentModelOverride } from "../shared/thread-runtime-config";

export interface AgentRegistrySettingsSource {
  listAgentTemplates(): AgentTemplate[];
  listMainAgentConfigs(): MainAgentConfigResource[];
  listMainAgentPrompts(): MainAgentPromptResource[];
  listSubagentOrchestrations(): SubagentOrchestrationResource[];
}

/** Virtual built-in main agent config for Codex Auth (CODEX_HOME/auth.json). */
const OPENAI_OFFICIAL_MAIN_AGENT_CONFIG: MainAgentConfigResource = {
  id: OPENAI_OFFICIAL_MAIN_AGENT_CONFIG_ID,
  name: "Codex 登录",
  agentKey: "openai-official",
  modelRef: { providerId: "openai", modelId: "gpt-5.6-luna", thinkingEffort: "medium" },
  tools: { allowed: [], disallowed: [] },
  skills: [],
  v4aTeachingEnabled: false,
  updatedAt: "",
  source: "built_in",
};

/** Virtual built-in provider for Codex Auth (auth.json). */
const OPENAI_OFFICIAL_PROVIDER: ProviderConfigView = {
  id: "openai",
  name: "OpenAI",
  baseUrl: "",
  requestPath: "/v1",
  version: "v1",
  apiCompat: "openai_responses",
  defaultModel: "gpt-5.6-luna",
  enabled: true,
  hasApiKey: false,
  authMethod: "auth_json",
  createdAt: "",
  updatedAt: "",
};

function createChatGptSubscriptionMainAgentConfig(modelId: string): MainAgentConfigResource {
  return {
    id: CHATGPT_SUBSCRIPTION_MAIN_AGENT_CONFIG_ID,
    name: "ChatGPT 订阅",
    agentKey: "chatgpt-subscription",
    modelRef: { providerId: "eco-coding-chatgpt", modelId, thinkingEffort: "medium" },
    tools: { allowed: [], disallowed: [] },
    skills: [],
    v4aTeachingEnabled: false,
    updatedAt: "",
    source: "built_in",
  };
}

export function mergeAgentRegistrySettings(
  base: ModelSettingsSnapshot,
  registry: AgentRegistrySettingsSource,
  options?: {
    openAiAccountActive?: boolean;
    chatGptSubscriptionModelId?: string;
    codexAuthModel?: MainAgentModelOverride;
  },
): ModelSettingsSnapshot {
  const mainAgentConfigs = registry.listMainAgentConfigs();
  const codexAuthConfig = options?.codexAuthModel
    ? { ...OPENAI_OFFICIAL_MAIN_AGENT_CONFIG, modelRef: options.codexAuthModel }
    : OPENAI_OFFICIAL_MAIN_AGENT_CONFIG;
  const withBuiltInConfigs = options?.openAiAccountActive
    ? [codexAuthConfig, ...mainAgentConfigs]
    : mainAgentConfigs;
  const chatGptModelId = options?.chatGptSubscriptionModelId?.trim();
  const withChatGptSubscription = chatGptModelId
    ? [createChatGptSubscriptionMainAgentConfig(chatGptModelId), ...withBuiltInConfigs]
    : withBuiltInConfigs;
  const providersWithOpenAi = options?.openAiAccountActive && !base.providers.some((p) => p.id === "openai")
    ? [OPENAI_OFFICIAL_PROVIDER, ...base.providers]
    : base.providers;
  return {
    ...base,
    providers: providersWithOpenAi,
    agentTemplates: mergeUniqueById(base.agentTemplates, registry.listAgentTemplates()),
    mainAgentConfigs: withChatGptSubscription,
    mainAgentPrompts: registry.listMainAgentPrompts(),
    subagentOrchestrations: registry.listSubagentOrchestrations(),
  };
}

function mergeUniqueById<T extends { id: string }>(protectedItems: T[], extensionItems: T[]): T[] {
  const protectedIds = new Set(protectedItems.map((item) => item.id));
  return [...protectedItems, ...extensionItems.filter((item) => !protectedIds.has(item.id))];
}
