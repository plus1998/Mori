import { resolveSupportsNativeWebSearch, resolveWebSearchContext, type WebSearchBackend } from "@eco/runtime";
import type {
  IntegratedWebSearchProvider,
  IntegratedWebSearchSettingsSnapshot,
  RouteManualSpec,
} from "../shared/ipc";

export interface ThreadWebSearchPlan {
  backend: WebSearchBackend;
  integratedApiKey?: string;
  provider?: IntegratedWebSearchProvider;
}

interface ThreadWebSearchPlanInput {
  networkWebSearch: boolean | undefined;
  plannerManualSpec?: RouteManualSpec;
  integratedSettings: IntegratedWebSearchSettingsSnapshot;
  integratedApiKey?: string;
}

/** The built-in Codex account route can search without an Integrated Search API key. */
export function resolveCodexThreadWebSearchPlan(
  input: ThreadWebSearchPlanInput & { mainProviderId: string | undefined },
): ThreadWebSearchPlan {
  if (
    input.mainProviderId === "openai" &&
    input.networkWebSearch !== false &&
    resolveSupportsNativeWebSearch(input.plannerManualSpec)
  ) {
    return { backend: "native" };
  }
  return resolveThreadWebSearchPlan(input);
}

export function resolveThreadWebSearchPlan(input: ThreadWebSearchPlanInput): ThreadWebSearchPlan {
  const context = resolveWebSearchContext({
    networkWebSearch: input.networkWebSearch,
    supportsNativeWebSearch: resolveSupportsNativeWebSearch(input.plannerManualSpec),
    integratedEnabled: input.integratedSettings.enabled,
    ...(input.integratedApiKey === undefined ? {} : { integratedApiKey: input.integratedApiKey }),
  });
  if (context.backend === "integrated") {
    return {
      backend: "integrated",
      ...(context.integratedApiKey ? { integratedApiKey: context.integratedApiKey } : {}),
      provider: input.integratedSettings.provider,
    };
  }
  return { backend: context.backend };
}
