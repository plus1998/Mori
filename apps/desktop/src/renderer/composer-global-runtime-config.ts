import type { CoreKind } from "@eco/runtime/core-runtime";
import { withDefaultBrowserIntegration } from "../shared/integrations";
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

export function buildComposerGlobalRuntimeConfig(input: {
  coreKind: CoreKind;
  settings: ModelSettingsSnapshot;
  workflowDefaults: WorkflowSettingsSnapshot;
  mcpServers: readonly McpServerConfigView[];
}): ThreadRuntimeConfig | undefined {
  const { workflowDefaults } = input;
  const integrationsEnabled = withDefaultBrowserIntegration(workflowDefaults.integrationsEnabled);

  if (input.coreKind === "acp") {
    return buildAcpThreadRuntimeConfig({
      ...(workflowDefaults.acpCursorModelId ? { cursorModelId: workflowDefaults.acpCursorModelId } : {}),
      sessionMode: "agent",
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

  return buildThreadRuntimeConfigFromDefaults({
    settings: input.settings,
    workflowDefaults: { ...workflowDefaults, sessionMode: "agent", integrationsEnabled },
    orchestrationSelection: selection,
    mcpServers: input.mcpServers,
  });
}
