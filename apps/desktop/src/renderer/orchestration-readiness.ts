import type {
  MainAgentModelOverride,
  ModelSettingsSnapshot,
  ResolvedOrchestrationSnapshot,
  RuntimeRoleRouteConfig,
} from "../shared/ipc";
import { resolveMainAgentModelOverrideForProvider } from "../shared/thread-runtime-config";
import { localizeMainAgentConfigName } from "./main-agent-config-display";

type ProviderView = ModelSettingsSnapshot["providers"][number];

export type OrchestrationFieldKey = "mainAgent" | "subagentOrchestration";

export type OrchestrationIssueKind = "provider_disabled" | "provider_missing" | "model_empty";

export interface OrchestrationFieldIssue {
  field: OrchestrationFieldKey;
  kind: OrchestrationIssueKind;
  providerId: string;
  providerName: string;
  modelId: string;
  agentKey?: string;
  orchestrationName?: string;
  mainAgentConfigName?: string;
}

export function isModelRefReady(
  modelRef: ResolvedOrchestrationSnapshot["mainAgent"]["modelRef"],
  providersById: ReadonlyMap<string, ProviderView>,
): boolean {
  const provider = providersById.get(modelRef.providerId);
  return Boolean(modelRef.modelId.trim() && provider?.enabled);
}

function diagnoseModelRef(
  modelRef: ResolvedOrchestrationSnapshot["mainAgent"]["modelRef"],
  providersById: ReadonlyMap<string, ProviderView>,
): Pick<OrchestrationFieldIssue, "kind" | "providerId" | "providerName" | "modelId"> | undefined {
  const providerId = modelRef.providerId.trim();
  const modelId = modelRef.modelId.trim();
  const provider = providersById.get(providerId);
  if (!modelId) {
    return {
      kind: "model_empty",
      providerId,
      providerName: provider?.name.trim() || providerId,
      modelId: modelRef.modelId,
    };
  }
  if (!provider) {
    return {
      kind: "provider_missing",
      providerId,
      providerName: providerId,
      modelId,
    };
  }
  if (!provider.enabled) {
    return {
      kind: "provider_disabled",
      providerId,
      providerName: provider.name.trim() || providerId,
      modelId,
    };
  }
  return undefined;
}

export function diagnoseOrchestrationSnapshotReadiness(
  snapshot: ResolvedOrchestrationSnapshot,
  providersById: ReadonlyMap<string, ProviderView>,
  mainAgentModelOverride?: MainAgentModelOverride,
): OrchestrationFieldIssue[] {
  const issues: OrchestrationFieldIssue[] = [];
  const effectiveMainModel =
    resolveMainAgentModelOverrideForProvider(
      snapshot.mainAgent.modelRef.providerId,
      mainAgentModelOverride,
    ) ?? snapshot.mainAgent.modelRef;
  const mainIssue = diagnoseModelRef(effectiveMainModel, providersById);
  if (mainIssue) {
    const mainAgentConfigName = localizeMainAgentConfigName(
      snapshot.selection.mainAgentConfigId,
      snapshot.mainAgentConfigName,
    );
    issues.push({
      field: "mainAgent",
      ...mainIssue,
      ...(mainAgentConfigName ? { mainAgentConfigName } : {}),
    });
  }

  const orchestrationName = snapshot.subagentOrchestrationDisplayName?.trim() || undefined;
  for (const agent of snapshot.agents) {
    if (!agent.enabled) {
      continue;
    }
    const agentIssue = diagnoseModelRef(agent.modelRef, providersById);
    if (!agentIssue) {
      continue;
    }
    issues.push({
      field: "subagentOrchestration",
      ...agentIssue,
      agentKey: agent.agentKey,
      ...(orchestrationName ? { orchestrationName } : {}),
    });
  }
  return issues;
}

export function invalidOrchestrationFieldsFromIssues(
  issues: readonly OrchestrationFieldIssue[],
): OrchestrationFieldKey[] {
  const fields: OrchestrationFieldKey[] = [];
  for (const issue of issues) {
    if (!fields.includes(issue.field)) {
      fields.push(issue.field);
    }
  }
  return fields;
}

/** i18n key for the first readiness issue detail suffix. */
export function orchestrationIssueDetailKey(
  issue: OrchestrationFieldIssue,
): `composer.hint.issue.${"main" | "subagent"}.${OrchestrationIssueKind}` {
  const scope = issue.field === "mainAgent" ? "main" : "subagent";
  return `composer.hint.issue.${scope}.${issue.kind}`;
}

export function isOrchestrationSnapshotReady(
  snapshot: ResolvedOrchestrationSnapshot,
  providersById: ReadonlyMap<string, ProviderView>,
  mainAgentModelOverride?: MainAgentModelOverride,
): boolean {
  return diagnoseOrchestrationSnapshotReadiness(snapshot, providersById, mainAgentModelOverride).length === 0;
}

export function areCodingRoutesReady(
  routes: readonly RuntimeRoleRouteConfig[],
  providersById: ReadonlyMap<string, ProviderView>,
): boolean {
  if (!routes.some((route) => route.role === "main")) {
    return false;
  }
  return routes.every((route) => {
    const provider = route ? providersById.get(route.providerId) : undefined;
    return Boolean(route?.modelId.trim() && provider?.enabled);
  });
}
