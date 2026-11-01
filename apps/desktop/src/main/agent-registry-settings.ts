import type {
  AgentTemplate,
  MainAgentPromptResource,
  ModelSettingsSnapshot,
  ProviderConfigView,
  SubagentOrchestrationResource,
} from "../shared/ipc";

export interface AgentRegistrySettingsSource {
  listAgentTemplates(): AgentTemplate[];
  listMainAgentPrompts(): MainAgentPromptResource[];
  listSubagentOrchestrations(): SubagentOrchestrationResource[];
}

/** Virtual built-in provider for Codex Auth (auth.json). */
const OPENAI_OFFICIAL_PROVIDER: ProviderConfigView = {
  id: "openai",
  name: "ChatGPT Login",
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

export function mergeAgentRegistrySettings(
  base: ModelSettingsSnapshot,
  registry: AgentRegistrySettingsSource,
): ModelSettingsSnapshot {
  const providersWithOpenAi = !base.providers.some((p) => p.id === "openai")
    ? [OPENAI_OFFICIAL_PROVIDER, ...base.providers]
    : base.providers;
  return {
    ...base,
    providers: providersWithOpenAi,
    agentTemplates: mergeUniqueById(base.agentTemplates, registry.listAgentTemplates()),
    mainAgentConfigs: [],
    mainAgentPrompts: registry.listMainAgentPrompts(),
    subagentOrchestrations: registry.listSubagentOrchestrations(),
  };
}

function mergeUniqueById<T extends { id: string }>(protectedItems: T[], extensionItems: T[]): T[] {
  const protectedIds = new Set(protectedItems.map((item) => item.id));
  return [...protectedItems, ...extensionItems.filter((item) => !protectedIds.has(item.id))];
}
