import type { ModelRef } from "./agent-orchestration";
import { stableHash } from "@eco/shared";
import type { ModelSettingsSnapshot } from "./ipc";
import {
  deriveSubagentEnabledFromSnapshot,
  hasCompleteOrchestrationSelection,
  normalizeThreadRuntimeConfig,
  resolveThreadRuntimeConfigUpdate,
  type ThreadRuntimeConfig,
} from "./thread-runtime-config";

/** Remove deleted selections rather than making unrelated edits depend on them. */
export function pruneThreadRuntimeConfigReferences(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
  isModelAvailable: (model: ModelRef) => boolean = () => true,
): ThreadRuntimeConfig {
  const next = structuredClone(config);
  const selection = next.orchestrationSelection;
  const snapshotMatchesSelection = !next.resolvedOrchestrationSnapshot || !selection ||
    stableHash(next.resolvedOrchestrationSnapshot.selection) === stableHash(selection);
  if (selection) {
    if (selection.mainModel && !isModelAvailable(selection.mainModel)) delete selection.mainModel;
    if (selection.mainAgentConfigId) {
      const main = settings.mainAgentConfigs.find(entry => entry.id === selection.mainAgentConfigId);
      if (!main || !isModelAvailable(main.modelRef)) delete selection.mainAgentConfigId;
    }
    const prompt = selection.mainPrompt;
    if (prompt.mode === "custom_append" &&
      !settings.mainAgentPrompts.some(entry => entry.id === prompt.promptId)) {
      selection.mainPrompt = { mode: "builtin" };
    }
    const subagents = selection.subagents;
    if (subagents.mode === "orchestration") {
      const resource = settings.subagentOrchestrations.find(entry => entry.id === subagents.orchestrationId);
      const savedRoster = next.resolvedOrchestrationSnapshot?.selection.subagents;
      const agents = savedRoster?.mode === "orchestration" && savedRoster.orchestrationId === subagents.orchestrationId
        ? next.resolvedOrchestrationSnapshot!.agents : resource?.agents;
      if (!resource || !agents?.some(agent => isModelAvailable(agent.modelRef))) {
        selection.subagents = { mode: "none" };
      }
    }
  }
  if (next.mainAgentModelOverride && !isModelAvailable(next.mainAgentModelOverride)) {
    delete next.mainAgentModelOverride;
  }
  for (const key of ["auxiliaryModel", "approvalModel", "visionModel"] as const) {
    if (next[key] && !isModelAvailable(next[key])) delete next[key];
  }
  if (!snapshotMatchesSelection) {
    delete next.resolvedOrchestrationSnapshot;
  }
  const snapshot = next.resolvedOrchestrationSnapshot;
  if (snapshot && selection) {
    snapshot.selection = structuredClone(selection);
    snapshot.agents = selection.subagents.mode === "none"
      ? [] : snapshot.agents.filter(agent => isModelAvailable(agent.modelRef));
    if (snapshot.agents.length === 0) {
      selection.subagents = { mode: "none" };
      snapshot.selection.subagents = { mode: "none" };
      delete snapshot.subagentOrchestrationDisplayName;
      snapshot.strategy = { kind: "autonomous" };
    }
    next.subagentEnabled = deriveSubagentEnabledFromSnapshot(snapshot, next.subagentEnabled);
    if (!hasCompleteOrchestrationSelection(selection) || !isModelAvailable(snapshot.mainAgent.modelRef)) {
      delete next.resolvedOrchestrationSnapshot;
    }
  }
  if (selection?.subagents.mode === "none") {
    for (const role of Object.keys(next.subagentEnabled) as Array<keyof typeof next.subagentEnabled>) {
      next.subagentEnabled[role] = false;
    }
  }
  return normalizeThreadRuntimeConfig(next);
}

/** Editing can persist an incomplete draft; starting a run still requires a main model. */
export function resolveThreadRuntimeConfigEdit(
  settings: ModelSettingsSnapshot,
  existing: ThreadRuntimeConfig | undefined,
  incoming: ThreadRuntimeConfig,
  isModelAvailable: (model: ModelRef) => boolean,
  options: { refreshSnapshot?: boolean } = {},
): ThreadRuntimeConfig {
  const cleaned = pruneThreadRuntimeConfigReferences(settings, incoming, isModelAvailable);
  if (!hasCompleteOrchestrationSelection(cleaned.orchestrationSelection)) return cleaned;
  const resolved = resolveThreadRuntimeConfigUpdate(settings, existing, cleaned, options);
  return pruneThreadRuntimeConfigReferences(settings, resolved, isModelAvailable);
}
