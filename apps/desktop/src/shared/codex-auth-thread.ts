import type { ThreadSummary } from "./ipc";

export function isCodexAuthThread(thread: Pick<ThreadSummary, "coreKind" | "runtimeConfig">): boolean {
  if (thread.coreKind !== "codex") return false;
  const config = thread.runtimeConfig;
  const providerId =
    config?.orchestrationSelection?.mainModel?.providerId ??
    config?.mainAgentModelOverride?.providerId ??
    config?.resolvedOrchestrationSnapshot?.mainAgent.modelRef.providerId;
  return (
    providerId === "openai" ||
    (providerId === undefined && config?.orchestrationSelection?.mainAgentConfigId === "__openai_official__")
  );
}

/** The selected account belongs to this conversation, never to the application. */
export function codexAccountIdForThread(thread: Pick<ThreadSummary, "coreKind" | "runtimeConfig">): string | undefined {
  if (!isCodexAuthThread(thread)) return undefined;
  const config = thread.runtimeConfig;
  return config?.orchestrationSelection?.mainModel?.accountId ??
    config?.resolvedOrchestrationSnapshot?.mainAgent.modelRef.accountId;
}
