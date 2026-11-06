import type { ThreadRuntimeConfig } from "./thread-runtime-config";

export function usesChatGptLogin(input: {
  coreKind?: string;
  runtimeConfig?: ThreadRuntimeConfig;
}): boolean {
  if (input.coreKind !== "codex") return false;
  const config = input.runtimeConfig;
  const model = config?.resolvedOrchestrationSnapshot?.mainAgent.modelRef
    ?? config?.orchestrationSelection?.mainModel;
  return model?.providerId === "openai";
}

export function usesCodexNativeTitle(input: {
  coreKind?: string;
  runtimeConfig?: ThreadRuntimeConfig;
}): boolean {
  return usesChatGptLogin(input) && !input.runtimeConfig?.auxiliaryModel;
}
