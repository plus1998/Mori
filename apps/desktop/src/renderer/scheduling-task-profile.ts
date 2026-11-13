import type { ModelRef, ModelSettingsSnapshot } from "../shared/ipc";
import type { ScheduleExecutionProfile } from "../shared/scheduling";
import { resolveThreadOrchestrationSnapshot } from "../shared/thread-runtime-config";

export function replaceSchedulingMainModel(
  profile: ScheduleExecutionProfile,
  settings: ModelSettingsSnapshot,
  model: ModelRef,
): ScheduleExecutionProfile {
  const snapshot = resolveThreadOrchestrationSnapshot(settings, profile.runtimeConfig);
  if (!snapshot) throw new Error("请选择完整的运行配置。");
  const mainModel = structuredClone(model);
  // A task owns its saved prompt and subagents. Re-materializing the global
  // orchestration here can reintroduce deleted candidate references.
  const selection = { mainModel, mainPrompt: snapshot.selection.mainPrompt, subagents: snapshot.selection.subagents };
  const { mainAgentModelOverride: _override, ...base } = profile.runtimeConfig;
  return {
    ...profile,
    runtimeConfig: {
      ...base,
      orchestrationSelection: structuredClone(selection),
      resolvedOrchestrationSnapshot: {
        ...structuredClone(snapshot),
        selection: structuredClone(selection),
        mainAgentConfigName: model.modelId,
        mainAgent: { ...structuredClone(snapshot.mainAgent), modelRef: mainModel },
      },
    },
  };
}
