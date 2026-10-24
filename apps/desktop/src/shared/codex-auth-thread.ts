import type { ThreadSummary } from "./ipc";

export function isCodexAuthThread(thread: ThreadSummary): boolean {
  if (thread.coreKind !== "codex") return false;
  const config = thread.runtimeConfig;
  const providerId =
    config?.mainAgentModelOverride?.providerId ??
    config?.resolvedOrchestrationSnapshot?.mainAgent.modelRef.providerId;
  return (
    providerId === "openai" ||
    (providerId === undefined && config?.orchestrationSelection?.mainAgentConfigId === "__openai_official__")
  );
}
