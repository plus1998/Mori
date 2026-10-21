import { listEnabledGlobalMcpServerKeys } from "./composer-mcp";
import type {
  McpServerConfigView,
  ModelSettingsSnapshot,
  ProviderConfigView,
  ResolvedOrchestrationSnapshot,
} from "./ipc";
import {
  resolveMainAgentModelOverrideForProvider,
  resolveMainAgentSystemPromptPreset,
  resolveThreadOrchestrationSnapshot,
  resolveThreadRuntimeMcpServerKeys,
  runtimeRoleRoutesFromOrchestrationSnapshot,
  type ThreadRuntimeConfig,
} from "./thread-runtime-config";

export interface PromptCacheOrchestrationLabel {
  modelStack: string;
  orchestrationName: string;
}

export type PromptCacheConfigDriftKind = "orchestration" | "main_model" | "system_prompt" | "mcp" | "skills";

export interface PromptCacheRuntimeSignature {
  orchestrationKey: string;
  mainAgentModelKey: string;
  mainAgentSystemPromptPreset: ResolvedOrchestrationSnapshot["mainAgent"]["systemPromptPreset"] | "";
  mcpServerKeys: string[];
  skillKeys: string[];
}

interface MainAgentModelIdentity {
  providerId: string;
  modelId: string;
  thinkingEffort?: string;
}

/** Stable identity for request-affecting main-agent model settings. */
export function buildMainAgentModelKey(model: MainAgentModelIdentity | undefined): string {
  return JSON.stringify([
    model?.providerId.trim() ?? "",
    model?.modelId.trim() ?? "",
    model?.thinkingEffort?.trim() ?? "",
  ]);
}

export function buildOrchestrationRuntimeKey(
  snapshot: ResolvedOrchestrationSnapshot | undefined,
  selection: ResolvedOrchestrationSnapshot["selection"] | undefined,
): string {
  const resolvedSelection = snapshot?.selection ?? selection;
  if (!resolvedSelection) {
    return "";
  }
  const normalizedSelection = {
    mainAgentConfigId: resolvedSelection.mainAgentConfigId.trim(),
    mainPrompt:
      resolvedSelection.mainPrompt.mode === "builtin"
        ? { mode: "builtin" as const }
        : {
            mode: "custom_append" as const,
            promptId: resolvedSelection.mainPrompt.promptId.trim(),
          },
    subagents:
      resolvedSelection.subagents.mode === "none"
        ? { mode: "none" as const }
        : {
            mode: "orchestration" as const,
            orchestrationId: resolvedSelection.subagents.orchestrationId.trim(),
          },
  };
  if (!snapshot) {
    return JSON.stringify({ selection: normalizedSelection });
  }
  const { resolvedAt: _resolvedAt, selection: _selection, ...snapshotContent } = snapshot;
  return JSON.stringify({ selection: normalizedSelection, snapshot: snapshotContent });
}

export function resolveMainAgentModelKey(
  settings: ModelSettingsSnapshot,
  runtimeConfig: ThreadRuntimeConfig,
): string {
  const snapshot = resolveThreadOrchestrationSnapshot(settings, runtimeConfig);
  return buildMainAgentModelKey(resolveEffectiveMainAgentModel(snapshot, runtimeConfig));
}

export function resolvePromptCacheRuntimeSignature(input: {
  runtimeConfig: ThreadRuntimeConfig;
  settings: ModelSettingsSnapshot;
  availableMcpServerKeys: readonly string[];
}): PromptCacheRuntimeSignature {
  const snapshot = resolveThreadOrchestrationSnapshot(input.settings, input.runtimeConfig);
  const orchestrationKey = buildOrchestrationRuntimeKey(snapshot, input.runtimeConfig.orchestrationSelection);
  const mainAgentModelKey = buildMainAgentModelKey(
    resolveEffectiveMainAgentModel(snapshot, input.runtimeConfig),
  );
  const mainAgentSystemPromptPreset = snapshot
    ? resolveMainAgentSystemPromptPreset(snapshot, input.runtimeConfig)
    : "";
  const mcpServerKeys = resolveThreadRuntimeMcpServerKeys({
    runtimeConfig: input.runtimeConfig,
    settings: input.settings,
    availableMcpServerKeys: input.availableMcpServerKeys,
  })
    .slice()
    .sort();
  const skillKeys = Object.entries(input.runtimeConfig.skillsEnabled ?? {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .sort();
  return { orchestrationKey, mainAgentModelKey, mainAgentSystemPromptPreset, mcpServerKeys, skillKeys };
}

function resolveEffectiveMainAgentModel(
  snapshot: ResolvedOrchestrationSnapshot | undefined,
  runtimeConfig: ThreadRuntimeConfig,
): MainAgentModelIdentity | undefined {
  if (!snapshot) {
    return undefined;
  }
  const override = resolveMainAgentModelOverrideForProvider(
    snapshot.mainAgent.modelRef.providerId,
    runtimeConfig.mainAgentModelOverride,
  );
  return runtimeRoleRoutesFromOrchestrationSnapshot(snapshot, override).find(
    (route) => route.role === "main",
  );
}

export function diffPromptCacheRuntimeSignatures(
  baseline: PromptCacheRuntimeSignature,
  current: PromptCacheRuntimeSignature,
): PromptCacheConfigDriftKind[] {
  const kinds: PromptCacheConfigDriftKind[] = [];
  if (baseline.orchestrationKey !== current.orchestrationKey) {
    kinds.push("orchestration");
  }
  if (baseline.mainAgentModelKey !== current.mainAgentModelKey) {
    kinds.push("main_model");
  }
  if (baseline.mainAgentSystemPromptPreset !== current.mainAgentSystemPromptPreset) {
    kinds.push("system_prompt");
  }
  if (!stringArraysEqual(baseline.mcpServerKeys, current.mcpServerKeys)) {
    kinds.push("mcp");
  }
  if (!stringArraysEqual(baseline.skillKeys, current.skillKeys)) {
    kinds.push("skills");
  }
  return kinds;
}

export function resolvePromptCacheOrchestrationLabel(
  settings: ModelSettingsSnapshot,
  runtimeConfig: ThreadRuntimeConfig,
): PromptCacheOrchestrationLabel | undefined {
  const snapshot = resolveThreadOrchestrationSnapshot(settings, runtimeConfig);
  if (!snapshot) {
    return undefined;
  }
  const modelStack = formatSnapshotModelStack(snapshot, settings.providers);
  const orchestrationName = [
    snapshot.mainAgentConfigName,
    snapshot.mainPromptDisplayName,
    snapshot.subagentOrchestrationDisplayName ?? "无子代理",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" / ");
  if (!orchestrationName) {
    return undefined;
  }
  return { modelStack, orchestrationName };
}

export function formatSnapshotModelStack(
  snapshot: ResolvedOrchestrationSnapshot,
  providers: readonly ProviderConfigView[],
): string {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const names: string[] = [];

  const addProvider = (providerId: string) => {
    const id = providerId.trim();
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    const provider = providerById.get(id);
    names.push(provider?.name.trim() || id);
  };

  addProvider(snapshot.mainAgent.modelRef.providerId);
  for (const agent of snapshot.agents) {
    if (agent.enabled) {
      addProvider(agent.modelRef.providerId);
    }
  }

  return names.length > 0 ? names.join("+") : "未配置";
}

export function formatPromptCacheOrchestrationSwitchPhrase(label: PromptCacheOrchestrationLabel): string {
  return `已经变更为 ${label.modelStack}（${label.orchestrationName}）`;
}

function formatPromptCacheDriftChangeParts(
  kinds: readonly PromptCacheConfigDriftKind[],
  orchestrationLabel?: PromptCacheOrchestrationLabel,
): string[] {
  const parts: string[] = [];
  if (kinds.includes("orchestration")) {
    parts.push(
      orchestrationLabel ? formatPromptCacheOrchestrationSwitchPhrase(orchestrationLabel) : "编排组合已变更",
    );
  }
  if (kinds.includes("main_model")) {
    parts.push("主代理模型或思考强度已变更");
  }
  if (kinds.includes("system_prompt")) {
    parts.push("主代理提示词已变更");
  }
  if (kinds.includes("mcp")) {
    parts.push("MCP 配置已变更");
  }
  if (kinds.includes("skills")) {
    parts.push("Skills 配置已变更");
  }
  return parts;
}

export function formatPromptCacheConfigDriftHint(
  kinds: readonly PromptCacheConfigDriftKind[],
  options?: { orchestrationLabel?: PromptCacheOrchestrationLabel },
): string {
  if (kinds.length === 0) {
    return "";
  }
  const parts = formatPromptCacheDriftChangeParts(kinds, options?.orchestrationLabel);
  return `${parts.join("，")}，可能导致本会话 prompt cache 失效（费用或延迟或上升）。仍可继续使用，或新开 thread 以获得稳定缓存。`;
}

export function formatPromptCacheConfigDriftMessage(
  kinds: readonly PromptCacheConfigDriftKind[],
  options?: { orchestrationLabel?: PromptCacheOrchestrationLabel },
): string {
  const parts = formatPromptCacheDriftChangeParts(kinds, options?.orchestrationLabel);
  if (parts.length === 0) {
    return "Composer 配置已变更";
  }
  return parts.join("，");
}

export function resolvePromptCacheConfigDrift(input: {
  baseline?: ThreadRuntimeConfig;
  current?: ThreadRuntimeConfig;
  settings: ModelSettingsSnapshot;
  mcpServers: readonly McpServerConfigView[];
}): PromptCacheConfigDriftKind[] {
  if (!input.baseline || !input.current) {
    return [];
  }
  const availableMcpServerKeys = listEnabledGlobalMcpServerKeys(input.mcpServers);
  return diffPromptCacheRuntimeSignatures(
    resolvePromptCacheRuntimeSignature({
      runtimeConfig: input.baseline,
      settings: input.settings,
      availableMcpServerKeys,
    }),
    resolvePromptCacheRuntimeSignature({
      runtimeConfig: input.current,
      settings: input.settings,
      availableMcpServerKeys,
    }),
  );
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}
