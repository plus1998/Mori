import type {
  AgentRole,
  ModelSettingsSnapshot,
  ResolvedOrchestrationSnapshot,
  RuntimeAgentRole,
  RuntimeRoleRouteConfig,
  SubagentRole,
} from "../shared/ipc";
import { AGENT_ROLES, SUBAGENT_ROLES } from "../shared/ipc";
import { pickDisplayModelId } from "../shared/model-id";
import { i18n } from "./i18n";
import { localizeMainAgentConfigName } from "./main-agent-config-display";

const LEGACY_ROLE_LABEL_KEYS: Record<AgentRole, Parameters<typeof i18n.t>[0]> = {
  main: "agent.role.main",
  explore: "agent.role.explore",
  architect: "agent.role.architect",
  coder: "agent.role.coder",
  reviewer: "agent.role.reviewer",
  tester: "agent.role.tester",
};

export interface ComposerAgentModelLabel {
  role: RuntimeAgentRole;
  displayName: string;
  modelId?: string | undefined;
  title: string;
  main: boolean;
  subagentRole?: SubagentRole | undefined;
}

export function buildComposerAgentModelLabels(input: {
  routes: readonly RuntimeRoleRouteConfig[];
  threadModelByRole?: Record<string, string> | undefined;
  snapshot?: ResolvedOrchestrationSnapshot | undefined;
  templates?: ModelSettingsSnapshot["agentTemplates"] | undefined;
}): ComposerAgentModelLabel[] {
  if (input.snapshot) {
    return buildSnapshotAgentModelLabels({ ...input, snapshot: input.snapshot });
  }
  return AGENT_ROLES.map((role) =>
    buildLabelForRoute({
      role,
      displayName: i18n.t(LEGACY_ROLE_LABEL_KEYS[role]),
      configuredModelId: input.routes.find((route) => route.role === role)?.modelId,
      liveModelId: input.threadModelByRole?.[role],
      main: role === "main",
      subagentRole: isSubagentRole(role) ? role : undefined,
    }),
  );
}

function buildSnapshotAgentModelLabels(input: {
  routes: readonly RuntimeRoleRouteConfig[];
  threadModelByRole?: Record<string, string> | undefined;
  snapshot: ResolvedOrchestrationSnapshot;
  templates?: ModelSettingsSnapshot["agentTemplates"] | undefined;
}): ComposerAgentModelLabel[] {
  const displayNames = snapshotDisplayNames(input.snapshot, input.templates ?? []);
  return input.routes.map((route) =>
    buildLabelForRoute({
      role: route.role,
      displayName: displayNames.get(route.role) ?? formatRuntimeRoleLabel(route.role),
      configuredModelId: route.modelId,
      liveModelId: input.threadModelByRole?.[route.role],
      main: route.role === "main",
      subagentRole: isSubagentRole(route.role) ? route.role : undefined,
    }),
  );
}

function buildLabelForRoute(input: {
  role: RuntimeAgentRole;
  displayName: string;
  configuredModelId?: string | undefined;
  liveModelId?: string | undefined;
  main: boolean;
  subagentRole?: SubagentRole | undefined;
}): ComposerAgentModelLabel {
  const configured = input.configuredModelId?.trim() || undefined;
  const modelId = pickDisplayModelId(input.liveModelId, configured);
  return {
    role: input.role,
    displayName: input.displayName,
    modelId,
    title: modelId ? `${input.displayName} · ${modelId}` : input.displayName,
    main: input.main,
    ...(input.subagentRole && { subagentRole: input.subagentRole }),
  };
}

function snapshotDisplayNames(
  snapshot: ResolvedOrchestrationSnapshot,
  templates: ModelSettingsSnapshot["agentTemplates"],
): Map<string, string> {
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const names = new Map<string, string>();
  names.set(
    "main",
    localizeMainAgentConfigName(snapshot.selection.mainAgentConfigId, snapshot.mainAgent.name) ||
      i18n.t("agent.role.mainAgent"),
  );
  for (const agent of snapshot.agents) {
    const template = templateById.get(agent.templateId);
    names.set(agent.agentKey, agent.displayName?.trim() || template?.name || agent.agentKey);
  }
  return names;
}

function isSubagentRole(role: RuntimeAgentRole): role is SubagentRole {
  return (SUBAGENT_ROLES as readonly string[]).includes(role);
}

function formatRuntimeRoleLabel(role: RuntimeAgentRole): string {
  return role
    .replace(/^eco_/, "")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
