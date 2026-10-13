import type { CoreKind } from "@eco/runtime/core-runtime";
import type {
  McpServerConfigView,
  ModelSettingsSnapshot,
  ThreadRuntimeConfig,
  WorkflowSettingsSnapshot,
} from "../shared/ipc";
import {
  buildAcpThreadRuntimeConfig,
  buildThreadRuntimeConfigFromDefaults,
  hasCompleteOrchestrationSelection,
} from "../shared/thread-runtime-config";

const disabledGlobalIntegrations = {
  browser: false,
  imageGeneration: false,
  tts: false,
};

export function buildComposerGlobalRuntimeConfig(input: {
  coreKind: CoreKind;
  settings: ModelSettingsSnapshot;
  workflowDefaults: WorkflowSettingsSnapshot;
  mcpServers: readonly McpServerConfigView[];
}): ThreadRuntimeConfig | undefined {
  const { workflowDefaults } = input;
  const integrationsEnabled = workflowDefaults.integrationsEnabled ?? disabledGlobalIntegrations;

  if (input.coreKind === "acp") {
    return buildAcpThreadRuntimeConfig({
      ...(workflowDefaults.acpCursorModelId ? { cursorModelId: workflowDefaults.acpCursorModelId } : {}),
      sessionMode: workflowDefaults.sessionMode,
      ...(workflowDefaults.defaultAuxiliaryModel
        ? { auxiliaryModel: workflowDefaults.defaultAuxiliaryModel }
        : {}),
      ...(workflowDefaults.defaultApprovalModel
        ? { approvalModel: workflowDefaults.defaultApprovalModel }
        : {}),
      ...(workflowDefaults.defaultVisionModel ? { visionModel: workflowDefaults.defaultVisionModel } : {}),
      ...(workflowDefaults.mcpServersEnabled
        ? { mcpServersEnabled: workflowDefaults.mcpServersEnabled }
        : {}),
      integrationsEnabled,
    });
  }

  const selection = workflowDefaults.defaultOrchestrationSelection;
  if (!hasCompleteOrchestrationSelection(selection)) {
    return undefined;
  }

  return {
    ...buildThreadRuntimeConfigFromDefaults({
      settings: input.settings,
      workflowDefaults,
      orchestrationSelection: selection,
      mcpServers: input.mcpServers,
    }),
    integrationsEnabled,
  };
}
