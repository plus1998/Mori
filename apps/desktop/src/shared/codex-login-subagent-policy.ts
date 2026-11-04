import type { ResolvedOrchestrationSnapshot } from "./agent-orchestration";
import type { ProviderConfigView, RuntimeRoleRouteConfig } from "./ipc";

export function isCodexLoginProvider(providerId: string, providers: readonly ProviderConfigView[]): boolean {
  if (providerId !== "openai") return false;
  const stored = providers.find((provider) => provider.id === providerId);
  return !stored || (stored.authMethod === "auth_json" && !stored.hasApiKey);
}

/** Validate the actual per-thread combination, not reusable orchestration resources. */
export function assertCodexLoginSubagentPolicy(input: {
  coreKind: string | undefined;
  snapshot: Pick<ResolvedOrchestrationSnapshot, "agents">;
  routes: readonly RuntimeRoleRouteConfig[];
  isCodexLoginProvider: (providerId: string) => boolean;
}): void {
  const main = input.routes.find((route) => route.role === "main");
  if (input.coreKind === "codex" && main && input.isCodexLoginProvider(main.providerId)) return;
  const conflict = input.snapshot.agents.find((agent) => {
    if (!agent.enabled || agent.agentKey === "main") return false;
    const route = input.routes.find((entry) => entry.role === agent.agentKey);
    return input.isCodexLoginProvider(route?.providerId ?? agent.modelRef.providerId);
  });
  if (conflict) {
    throw new Error(`子代理「${conflict.displayName?.trim() || conflict.agentKey}」使用 Codex Login，只有 Codex Login 主代理可以使用该子代理。请切换主模型，或在子代理编排中更换模型或禁用该子代理。`);
  }
}
