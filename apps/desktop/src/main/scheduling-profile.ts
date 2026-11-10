import { isCoreKind } from "@eco/runtime/core-runtime";
import type { ModelSettingsSnapshot, RuntimeRoleRouteConfig } from "../shared/ipc";
import type { ScheduleExecutionProfile } from "../shared/scheduling";
import type { ModelRef } from "../shared/agent-orchestration";
import { pruneThreadRuntimeSubagentReferences } from "../shared/thread-runtime-config-references";
import { normalizeThreadRuntimeConfig, resolveThreadOrchestrationSnapshot, type ThreadRuntimeConfig } from "../shared/thread-runtime-config";

export function freezeSchedulingProfile(
  profile: ScheduleExecutionProfile,
  settings: ModelSettingsSnapshot,
  resolveRoutes: (config: ThreadRuntimeConfig) => RuntimeRoleRouteConfig[],
  isModelAvailable: (model: ModelRef) => boolean,
): ScheduleExecutionProfile {
  if (!profile || !isCoreKind(profile.coreKind)) throw new Error("请选择有效的 Harness。");
  if (!profile.runtimeConfig || typeof profile.runtimeConfig !== "object") throw new Error("任务缺少运行配置。");
  let config = normalizeThreadRuntimeConfig(profile.runtimeConfig);
  if (profile.coreKind === "acp") {
    if (!config.cursorModelId?.trim()) throw new Error("请为 Cursor 定时任务选择明确的模型。");
    return { coreKind: profile.coreKind, runtimeConfig: config };
  }
  const existingSnapshot = resolveThreadOrchestrationSnapshot(settings, config);
  if (!existingSnapshot) throw new Error("请选择完整的运行配置。");
  // Share the model picker's deleted-subagent cleanup before stale routes can
  // fail resolution, while retaining the task's frozen main model and prompt.
  config = pruneThreadRuntimeSubagentReferences(settings, {
    ...config, orchestrationSelection: structuredClone(existingSnapshot.selection),
    resolvedOrchestrationSnapshot: existingSnapshot,
  }, isModelAvailable);
  const snapshot = config.resolvedOrchestrationSnapshot;
  if (!snapshot) throw new Error("请选择完整的运行配置。");
  // Resolve candidate defaults now and remove soft references so later defaults cannot change a task's model.
  const routes = resolveRoutes(config);
  const main = routes.find(route => route.role === "main");
  if (!main) throw new Error("任务缺少主模型。");
  const pinModel = (route: RuntimeRoleRouteConfig) => {
    const { candidateModelId: _candidate, role: _role, ...modelRef } = route;
    return modelRef;
  };
  const { mainAgentModelOverride: _override, ...base } = config;
  return { coreKind: profile.coreKind, runtimeConfig: {
    ...base, resolvedOrchestrationSnapshot: {
      ...structuredClone(snapshot), mainAgent: { ...snapshot.mainAgent, modelRef: pinModel(main) },
      agents: snapshot.agents.map(agent => {
        const route = routes.find(item => item.role === agent.agentKey);
        return route ? { ...agent, modelRef: pinModel(route) } : agent;
      }),
    },
  } };
}
