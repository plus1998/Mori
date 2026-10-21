import { formatRoleModelLabel } from "@eco/runtime/usage";
import type { ModelSettingsSnapshot, ThreadRuntimeConfig } from "../shared/ipc";
import { resolveThreadOrchestrationSummary } from "./orchestration-summary";

export type RuntimeAgentDisplayNames = Record<string, string>;

export function buildRuntimeAgentDisplayNames(
  settings: ModelSettingsSnapshot,
  runtimeConfig: ThreadRuntimeConfig | undefined,
): RuntimeAgentDisplayNames {
  const summary = resolveThreadOrchestrationSummary(settings, runtimeConfig);
  if (!summary) {
    return {};
  }
  const names: RuntimeAgentDisplayNames = {};
  addAgentDisplayName(names, "main", summary.main.name);
  addAgentDisplayName(names, "main", summary.main.name);
  for (const agent of summary.agents) {
    addAgentDisplayName(names, agent.agentKey, agent.name);
  }
  return names;
}

export function resolveRuntimeAgentName(
  role: string | undefined,
  displayNames?: RuntimeAgentDisplayNames | undefined,
): string | undefined {
  if (!role?.trim()) {
    return undefined;
  }
  const key = role.trim();
  return displayNames?.[key] ?? displayNames?.[stripEcoPrefix(key)] ?? displayNames?.[`eco_${key}`];
}

export function formatRuntimeRoleModelLabel(
  role: string,
  modelId: string | undefined,
  displayNames?: RuntimeAgentDisplayNames | undefined,
): string {
  const name = resolveRuntimeAgentName(role, displayNames);
  if (!name) {
    return formatRoleModelLabel(role, modelId);
  }
  const model = modelId?.trim();
  return model ? `${name} · ${model}` : name;
}

function addAgentDisplayName(names: RuntimeAgentDisplayNames, key: string, name: string): void {
  const cleanKey = key.trim();
  const cleanName = name.trim();
  if (!cleanKey || !cleanName) {
    return;
  }
  names[cleanKey] = cleanName;
  names[stripEcoPrefix(cleanKey)] = cleanName;
  names[`eco_${stripEcoPrefix(cleanKey)}`] = cleanName;
}

function stripEcoPrefix(value: string): string {
  return value.startsWith("eco_") ? value.slice(4) : value;
}
