import type { ModelSettingsSnapshot, ProviderDeleteReference, ThreadSummary } from "../shared/ipc";

const ACTIVE_THREAD_STATUSES = new Set<ThreadSummary["status"]>(["queued", "running"]);

export function collectProviderDeleteReferences(
  providerId: string,
  settings: ModelSettingsSnapshot,
  threads: readonly ThreadSummary[],
): ProviderDeleteReference[] {
  const targetId = providerId.trim();
  const references: ProviderDeleteReference[] = [];

  for (const orchestration of settings.subagentOrchestrations) {
    if (orchestration.agents.some((agent) => agent.modelRef.providerId === targetId)) {
      references.push({
        kind: "subagent_orchestration",
        id: orchestration.id,
        name: orchestration.name,
      });
    }
  }

  for (const thread of threads) {
    if (!ACTIVE_THREAD_STATUSES.has(thread.status) || !threadReferencesProvider(thread, targetId)) {
      continue;
    }
    references.push({
      kind: "active_thread",
      id: thread.id,
      name: thread.title,
    });
  }

  return references;
}

/** Active threads block deletion; subagent orchestrations are cascaded away. */
export function partitionProviderDeleteReferences(references: readonly ProviderDeleteReference[]): {
  blocking: ProviderDeleteReference[];
  cascadeSubagentOrchestrations: ProviderDeleteReference[];
} {
  const blocking: ProviderDeleteReference[] = [];
  const cascadeSubagentOrchestrations: ProviderDeleteReference[] = [];

  for (const reference of references) {
    if (reference.kind === "active_thread") {
      blocking.push(reference);
      continue;
    }
    if (reference.kind === "subagent_orchestration") {
      cascadeSubagentOrchestrations.push(reference);
    }
  }

  return { blocking, cascadeSubagentOrchestrations };
}

function threadReferencesProvider(thread: ThreadSummary, providerId: string): boolean {
  const runtimeConfig = thread.runtimeConfig;
  if (!runtimeConfig) {
    return false;
  }
  if (runtimeConfig.mainAgentModelOverride?.providerId === providerId) {
    return true;
  }
  const snapshot = runtimeConfig.resolvedOrchestrationSnapshot;
  return Boolean(
    snapshot &&
      (snapshot.mainAgent.modelRef.providerId === providerId ||
        snapshot.agents.some((agent) => agent.modelRef.providerId === providerId)),
  );
}
