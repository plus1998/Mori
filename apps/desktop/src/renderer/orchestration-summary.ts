import type { ModelRef } from "../shared/agent-orchestration";
import type {
  AgentInstanceConfig,
  AgentTemplate,
  ModelSettingsSnapshot,
  OrchestrationSelection,
  ResolvedOrchestrationSnapshot,
  SubagentRole,
  ThreadRuntimeConfig,
  ToolPolicy,
} from "../shared/ipc";
import { SUBAGENT_ROLES } from "../shared/ipc";
import { resolveThreadOrchestrationSnapshot } from "../shared/thread-runtime-config";
import { type AgentTemplatePermissionChip, buildAgentTemplatePermissionChips } from "./agent-template-form";
import { i18n } from "./i18n";
import { localizeMainAgentConfigName } from "./main-agent-config-display";

export interface OrchestrationMainSummary {
  name: string;
  modelLabel: string;
  modelId: string;
  thinkingEffort?: ModelRef["thinkingEffort"];
  riskLabels: string[];
  permissionChips: AgentTemplatePermissionChip[];
}

export interface OrchestrationAgentSummary {
  agentKey: string;
  name: string;
  templateName?: string | undefined;
  modelLabel: string;
  modelId: string;
  thinkingEffort?: ModelRef["thinkingEffort"];
  enabled: boolean;
  riskLabels: string[];
  permissionChips: AgentTemplatePermissionChip[];
}

export interface OrchestrationSummary {
  selection: OrchestrationSelection;
  name: string;
  main: OrchestrationMainSummary;
  agents: OrchestrationAgentSummary[];
  enabledAgents: OrchestrationAgentSummary[];
  disabledAgentCount: number;
  highRiskLabels: string[];
}

const SUBAGENT_ROLE_SET = new Set<string>(SUBAGENT_ROLES);

export function resolveThreadOrchestrationSummary(
  settings: ModelSettingsSnapshot,
  runtimeConfig: ThreadRuntimeConfig | undefined,
): OrchestrationSummary | undefined {
  if (!runtimeConfig) {
    return undefined;
  }
  const snapshot = resolveThreadOrchestrationSnapshot(settings, runtimeConfig);
  if (!snapshot) {
    return undefined;
  }
  return buildOrchestrationSummary(settings, snapshot, runtimeConfig);
}

export function buildOrchestrationSummary(
  settings: ModelSettingsSnapshot,
  snapshot: ResolvedOrchestrationSnapshot,
  runtimeConfig?: ThreadRuntimeConfig | undefined,
): OrchestrationSummary {
  const templatesById = new Map(settings.agentTemplates.map((template) => [template.id, template]));
  const mainRiskLabels = summarizeToolRiskLabels(snapshot.mainAgent.tools);
  const mainModelRef = snapshot.mainAgent.modelRef;
  const main: OrchestrationMainSummary = {
    name:
      localizeMainAgentConfigName(snapshot.selection.mainAgentConfigId, snapshot.mainAgent.name) ||
      i18n.t("settings.models.mainAgent"),
    modelLabel: formatModelLabel(mainModelRef.providerId, mainModelRef.modelId, mainModelRef),
    modelId: mainModelRef.modelId,
    ...(mainModelRef.thinkingEffort ? { thinkingEffort: mainModelRef.thinkingEffort } : {}),
    riskLabels: mainRiskLabels,
    permissionChips: buildAgentTemplatePermissionChips({
      defaultTools: snapshot.mainAgent.tools,
      allowDelegation: false,
    }),
  };
  const agents = snapshot.agents.map((agent) =>
    buildAgentSummary(agent, templatesById.get(agent.templateId), runtimeConfig),
  );
  const enabledAgents = agents.filter((agent) => agent.enabled);
  return {
    selection: snapshot.selection,
    name: formatOrchestrationDisplayName(snapshot),
    main,
    agents,
    enabledAgents,
    disabledAgentCount: agents.length - enabledAgents.length,
    highRiskLabels: dedupeRiskLabels([
      ...mainRiskLabels,
      ...enabledAgents.flatMap((agent) => agent.riskLabels),
    ]),
  };
}

export function formatOrchestrationDisplayName(snapshot: ResolvedOrchestrationSnapshot): string {
  const parts = [
    localizeMainAgentConfigName(snapshot.selection.mainAgentConfigId, snapshot.mainAgentConfigName),
    snapshot.mainPromptDisplayName.trim(),
  ].filter(Boolean);
  if (snapshot.subagentOrchestrationDisplayName?.trim()) {
    parts.push(snapshot.subagentOrchestrationDisplayName.trim());
  }
  return parts.join(" · ") || i18n.t("composer.route.selectOrchestration");
}

function buildAgentSummary(
  agent: AgentInstanceConfig,
  template: AgentTemplate | undefined,
  runtimeConfig: ThreadRuntimeConfig | undefined,
): OrchestrationAgentSummary {
  const enabled = resolveAgentEnabled(agent, runtimeConfig);
  return {
    agentKey: agent.agentKey,
    name: agent.displayName?.trim() || template?.name || agent.agentKey,
    ...(template?.name ? { templateName: template.name } : {}),
    modelLabel: formatModelLabel(agent.modelRef.providerId, agent.modelRef.modelId, agent.modelRef),
    modelId: agent.modelRef.modelId,
    ...(agent.modelRef.thinkingEffort ? { thinkingEffort: agent.modelRef.thinkingEffort } : {}),
    enabled,
    riskLabels: summarizeToolRiskLabels(agent.tools),
    permissionChips: buildAgentTemplatePermissionChips({
      defaultTools: agent.tools,
      allowDelegation: false,
    }),
  };
}

function resolveAgentEnabled(
  agent: AgentInstanceConfig,
  runtimeConfig: ThreadRuntimeConfig | undefined,
): boolean {
  if (!agent.enabled) {
    return false;
  }
  if (!runtimeConfig || !SUBAGENT_ROLE_SET.has(agent.agentKey)) {
    return agent.enabled;
  }
  return runtimeConfig.subagentEnabled[agent.agentKey as SubagentRole];
}

function summarizeToolRiskLabels(policy: ToolPolicy): string[] {
  const disallowed = new Set(policy.disallowed);
  const labels: string[] = [];
  if (policy.bash?.enabled && !disallowed.has("Bash")) {
    labels.push("Bash");
  }
  if (policy.filesystem?.write === "workspace") {
    labels.push(i18n.t("orchestrationResource.risk.writeFiles"));
  }
  const networkEnabled = policy.network?.webSearch || policy.network?.webFetch;
  if (networkEnabled) {
    labels.push(i18n.t("orchestrationResource.risk.network"));
  }
  if ((policy.mcp?.allowedServers.length ?? 0) > 0 || (policy.mcp?.allowedTools.length ?? 0) > 0) {
    labels.push("连接器");
  }
  return dedupeRiskLabels(labels);
}

function dedupeRiskLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of labels) {
    if (!seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }
  return result;
}

function formatModelLabel(_providerId: string, modelId: string, modelRef?: ModelRef): string {
  const model = modelId.trim();
  const base = model ? shortenModelId(model) : i18n.t("common.notConfigured");
  const suffixes: string[] = [];
  if (modelRef?.thinkingEffort && modelRef.thinkingEffort !== "off") {
    suffixes.push(modelRef.thinkingEffort);
  }
  if (modelRef?.modelsDevMapping) {
    suffixes.push(shortenModelId(modelRef.modelsDevMapping.modelId));
  }
  return suffixes.length > 0 ? `${base} · ${suffixes.join(" · ")}` : base;
}

function shortenModelId(modelId: string): string {
  const normalized = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
  if (normalized.length <= 24) {
    return normalized;
  }
  return `${normalized.slice(0, 11)}…${normalized.slice(-10)}`;
}
