import type { ModelRef } from "./agent-orchestration";
import { stableHash } from "@eco/shared";
import type { ModelSettingsSnapshot, WorkflowSettingsSnapshot } from "./ipc";
import {
  deriveSubagentEnabledFromSnapshot,
  hasCompleteOrchestrationSelection,
  materializeThreadOrchestrationSnapshot,
  normalizeThreadRuntimeConfig,
  resolveThreadRuntimeConfigUpdate,
  type ThreadRuntimeConfig,
} from "./thread-runtime-config";

type ThreadRuntimeConfigFallbacks = Pick<
  WorkflowSettingsSnapshot,
  "defaultOrchestrationSelection" | "defaultAuxiliaryModel" | "defaultApprovalModel" | "defaultVisionModel"
>;

/** Repair deleted selections from the current global defaults when those defaults are usable. */
export function pruneThreadRuntimeConfigReferences(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
  isModelAvailable: (model: ModelRef) => boolean = () => true,
  fallbacks?: ThreadRuntimeConfigFallbacks,
): ThreadRuntimeConfig {
  const next = structuredClone(config);
  let selection = next.orchestrationSelection;
  const hadMainModel = Boolean(selection?.mainModel);
  const hadMainAgentConfig = Boolean(selection?.mainAgentConfigId);
  let mainModelAvailable = !hadMainModel;
  let mainAgentConfigAvailable = !hadMainAgentConfig;
  const mainOverrideUnavailable = Boolean(
    next.mainAgentModelOverride && !isModelAvailable(next.mainAgentModelOverride),
  );
  let snapshotMatchesSelection = !next.resolvedOrchestrationSnapshot || !selection ||
    stableHash(next.resolvedOrchestrationSnapshot.selection) === stableHash(selection);
  if (selection) {
    if (selection.mainModel) {
      mainModelAvailable = isModelAvailable(selection.mainModel);
      if (!mainModelAvailable) delete selection.mainModel;
    }
    if (selection.mainAgentConfigId) {
      const mainAgentConfigId = selection.mainAgentConfigId;
      const main = settings.mainAgentConfigs.find(entry => entry.id === mainAgentConfigId);
      mainAgentConfigAvailable = Boolean(main && isModelAvailable(main.modelRef));
      if (!mainAgentConfigAvailable) delete selection.mainAgentConfigId;
    }
    const prompt = selection.mainPrompt;
    if (prompt.mode === "custom_append" &&
      !settings.mainAgentPrompts.some(entry => entry.id === prompt.promptId)) {
      selection.mainPrompt = { mode: "builtin" };
    }
    pruneSubagentSelection(settings, next, isModelAvailable);
  }
  const hasAvailableMainSource = (hadMainModel && mainModelAvailable) ||
    (hadMainAgentConfig && mainAgentConfigAvailable);
  if (((hadMainModel || hadMainAgentConfig) && !hasAvailableMainSource) || mainOverrideUnavailable) {
    const fallback = resolveAvailableGlobalOrchestrationSelection(settings, fallbacks, isModelAvailable);
    if (fallback) {
      const materialized = materializeThreadOrchestrationSnapshot(settings, fallback);
      next.orchestrationSelection = fallback;
      next.resolvedOrchestrationSnapshot = materialized.resolvedOrchestrationSnapshot;
      delete next.mainAgentModelOverride;
      selection = fallback;
      snapshotMatchesSelection = true;
    }
  }
  if (next.mainAgentModelOverride && !isModelAvailable(next.mainAgentModelOverride)) {
    delete next.mainAgentModelOverride;
  }
  for (const key of ["auxiliaryModel", "approvalModel", "visionModel"] as const) {
    const current = next[key];
    if (!current || isModelAvailable(current)) continue;
    const fallback = fallbackForStatelessModel(key, fallbacks);
    if (fallback && isModelAvailable(fallback)) {
      next[key] = structuredClone(fallback);
    } else {
      delete next[key];
    }
  }
  if (!snapshotMatchesSelection) {
    delete next.resolvedOrchestrationSnapshot;
  }
  const snapshot = next.resolvedOrchestrationSnapshot;
  if (snapshot && selection) {
    snapshot.selection = structuredClone(selection);
  }
  pruneSubagentSnapshot(next, isModelAvailable);
  if (snapshot && selection &&
    (!hasCompleteOrchestrationSelection(selection) || !isModelAvailable(snapshot.mainAgent.modelRef))) {
    delete next.resolvedOrchestrationSnapshot;
  }
  return normalizeThreadRuntimeConfig(next);
}

/** Scheduled tasks keep their frozen main model and prompt, sharing only subagent cleanup. */
export function pruneThreadRuntimeSubagentReferences(
  settings: ModelSettingsSnapshot,
  config: ThreadRuntimeConfig,
  isModelAvailable: (model: ModelRef) => boolean,
): ThreadRuntimeConfig {
  const next = structuredClone(config);
  pruneSubagentSelection(settings, next, isModelAvailable);
  pruneSubagentSnapshot(next, isModelAvailable);
  return normalizeThreadRuntimeConfig(next);
}

function pruneSubagentSelection(
  settings: ModelSettingsSnapshot,
  next: ThreadRuntimeConfig,
  isModelAvailable: (model: ModelRef) => boolean,
): void {
  const selection = next.orchestrationSelection;
  if (!selection) return;
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

function pruneSubagentSnapshot(
  next: ThreadRuntimeConfig,
  isModelAvailable: (model: ModelRef) => boolean,
): void {
  const selection = next.orchestrationSelection;
  const snapshot = next.resolvedOrchestrationSnapshot;
  if (snapshot && selection) {
    snapshot.selection.subagents = structuredClone(selection.subagents);
    snapshot.agents = selection.subagents.mode === "none"
      ? [] : snapshot.agents.filter(agent => isModelAvailable(agent.modelRef));
    if (snapshot.agents.length === 0) {
      selection.subagents = { mode: "none" };
      snapshot.selection.subagents = { mode: "none" };
      delete snapshot.subagentOrchestrationDisplayName;
      snapshot.strategy = { kind: "autonomous" };
    }
    next.subagentEnabled = deriveSubagentEnabledFromSnapshot(snapshot, next.subagentEnabled);
  }
  if (selection?.subagents.mode === "none") {
    for (const role of Object.keys(next.subagentEnabled) as Array<keyof typeof next.subagentEnabled>) {
      next.subagentEnabled[role] = false;
    }
  }
}

/** Editing can persist an incomplete draft; starting a run still requires a main model. */
export function resolveThreadRuntimeConfigEdit(
  settings: ModelSettingsSnapshot,
  existing: ThreadRuntimeConfig | undefined,
  incoming: ThreadRuntimeConfig,
  isModelAvailable: (model: ModelRef) => boolean,
  options: { refreshSnapshot?: boolean } = {},
  fallbacks?: ThreadRuntimeConfigFallbacks,
): ThreadRuntimeConfig {
  const cleaned = pruneThreadRuntimeConfigReferences(settings, incoming, isModelAvailable, fallbacks);
  if (!hasCompleteOrchestrationSelection(cleaned.orchestrationSelection)) return cleaned;
  const resolved = resolveThreadRuntimeConfigUpdate(settings, existing, cleaned, options);
  return pruneThreadRuntimeConfigReferences(settings, resolved, isModelAvailable, fallbacks);
}

function fallbackForStatelessModel(
  key: "auxiliaryModel" | "approvalModel" | "visionModel",
  fallbacks: ThreadRuntimeConfigFallbacks | undefined,
) {
  if (key === "auxiliaryModel") return fallbacks?.defaultAuxiliaryModel;
  if (key === "approvalModel") return fallbacks?.defaultApprovalModel;
  return fallbacks?.defaultVisionModel;
}

function resolveAvailableGlobalOrchestrationSelection(
  settings: ModelSettingsSnapshot,
  fallbacks: ThreadRuntimeConfigFallbacks | undefined,
  isModelAvailable: (model: ModelRef) => boolean,
) {
  const selection = fallbacks?.defaultOrchestrationSelection;
  if (!hasCompleteOrchestrationSelection(selection)) return undefined;
  const mainModel = selection.mainModel;
  if (mainModel && !isModelAvailable(mainModel)) return undefined;
  if (!mainModel && selection.mainAgentConfigId) {
    const main = settings.mainAgentConfigs.find(entry => entry.id === selection.mainAgentConfigId);
    if (!main || !isModelAvailable(main.modelRef)) return undefined;
  }
  const candidateSelection = structuredClone(selection);
  if (candidateSelection.subagents.mode === "orchestration") {
    const orchestrationId = candidateSelection.subagents.orchestrationId;
    const resource = settings.subagentOrchestrations.find(
      (entry) => entry.id === orchestrationId,
    );
    if (!resource || !resource.agents.some((agent) => isModelAvailable(agent.modelRef))) {
      candidateSelection.subagents = { mode: "none" };
    }
  }
  try {
    return materializeThreadOrchestrationSnapshot(settings, candidateSelection).orchestrationSelection;
  } catch {
    return undefined;
  }
}
