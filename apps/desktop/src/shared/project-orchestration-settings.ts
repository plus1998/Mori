import { isOrchestrationSelection, type OrchestrationSelection } from "./agent-orchestration";

export interface ProjectOrchestrationSettingsSnapshot {
  workspacePath: string;
  orchestrationSelection?: OrchestrationSelection;
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
