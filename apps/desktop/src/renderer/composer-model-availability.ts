import type { CoreKind } from "@eco/runtime/core-runtime";
import type { ProviderConfigView } from "../shared/ipc";

export interface ComposerModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  candidateModelId?: string;
  thinkingEffort?: import("../shared/ipc").ThinkingEffort;
}

export type ComposerModelAvailabilityState = "ready" | "no-provider" | "no-orchestration" | "acp";

export function composerRequiresOrchestration(coreKind: CoreKind): boolean {
  return coreKind !== "acp";
}

/** ACP keeps the route popover for auxiliary/vision models; Eco cores also need orchestration. */
export function composerShowsRouteConfig(_coreKind: CoreKind): boolean {
  return true;
}

/** Built-in OpenAI subscription provider (auth.json) — only usable with the Codex kernel. */
export function isBuiltInOpenAiProvider(provider: Pick<ProviderConfigView, "id" | "authMethod">): boolean {
  return provider.id === "openai" && provider.authMethod === "auth_json";
}

export function resolveComposerModelAvailability(
  providers: readonly Pick<ProviderConfigView, "enabled">[],
  templateMainModel: ComposerModelOption | undefined,
  coreKind?: CoreKind,
): ComposerModelAvailabilityState {
  if (coreKind === "acp") {
    return "acp";
  }
  const hasEnabledProvider = providers.some((provider) => provider.enabled);
  if (!hasEnabledProvider) {
    return "no-provider";
  }
  if (!templateMainModel) {
    return "no-orchestration";
  }
  return "ready";
}
