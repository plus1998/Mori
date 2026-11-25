import { CORE_KINDS, isCoreKind, type CoreKind } from "@eco/runtime/core-runtime";
import { isCodexLoginProvider, supportsMainModelProvider } from "./codex-login-subagent-policy";
import type { ModelSettingsSnapshot } from "./ipc";
import { isOrchestrationSelection, type OrchestrationSelection } from "./agent-orchestration";

export interface ProjectOrchestrationSettingsSnapshot {
  workspacePath: string;
  orchestrationSelection?: OrchestrationSelection;
  harnessSelections?: HarnessSelections;
  cursorModelId?: string | null;
}

export function normalizeProjectOrchestrationSelection(value: unknown): OrchestrationSelection | undefined {
  if (!isOrchestrationSelection(value)) {
    return undefined;
  }
  return {
    ...(value.mainAgentConfigId?.trim()
      ? { mainAgentConfigId: value.mainAgentConfigId.trim() } : {}),
    ...(value.mainModel ? { mainModel: { ...value.mainModel } } : {}),
    mainPrompt:
      value.mainPrompt.mode === "builtin"
        ? { mode: "builtin" }
        : { mode: "custom_append", promptId: value.mainPrompt.promptId.trim() },
    subagents:
      value.subagents.mode === "none"
        ? { mode: "none" }
        : { mode: "orchestration", orchestrationId: value.subagents.orchestrationId.trim() },
  };
}

export type OrchestrationHarness = Exclude<CoreKind, "acp">;
export type HarnessSelections = Partial<Record<OrchestrationHarness, OrchestrationSelection | null>>;

export function isOrchestrationHarness(value: unknown): value is OrchestrationHarness {
  return isCoreKind(value) && value !== "acp";
}

export function isHarnessSelections(value: unknown): value is HarnessSelections {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([kind, selection]) =>
      isOrchestrationHarness(kind) && (selection === null || isOrchestrationSelection(selection))));
}

export function normalizeHarnessSelections(value: unknown): HarnessSelections | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = value as Record<string, unknown>;
  const selections: HarnessSelections = {};
  for (const kind of CORE_KINDS) {
    if (kind === "acp") continue;
    const entry = entries[kind];
    const selection = entry === null ? null : normalizeProjectOrchestrationSelection(entry);
    if (selection !== undefined) selections[kind] = selection;
  }
  return Object.keys(selections).length ? selections : undefined;
}

export type ProjectHarnessSelection =
  | { coreKind?: OrchestrationHarness; orchestrationSelection: OrchestrationSelection }
  | { coreKind: "acp"; cursorModelId: string | null };

export type ProjectOrchestrationSettingsUpdate = { workspacePath: string } & ProjectHarnessSelection;

export function resolveHarnessOrchestrationSelection(
  coreKind: string | undefined,
  settings: Pick<ModelSettingsSnapshot, "providers" | "mainAgentConfigs">,
  defaults: { harnessSelections?: HarnessSelections | undefined; orchestrationSelection?: OrchestrationSelection | undefined },
): OrchestrationSelection | undefined {
  if (!isOrchestrationHarness(coreKind)) return undefined;
  const remembered = defaults.harnessSelections?.[coreKind];
  const selection = remembered === undefined ? defaults.orchestrationSelection : remembered;
  if (!selection) return undefined;
  const model = selection.mainModel ??
    settings.mainAgentConfigs.find((config) => config.id === selection.mainAgentConfigId)?.modelRef;
  return model && supportsMainModelProvider(coreKind, model.providerId, (id) => isCodexLoginProvider(id, settings.providers))
    ? selection
    : undefined;
}
