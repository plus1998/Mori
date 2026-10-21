import type { ResolvedModelRoute } from "@eco/model-router";
import type { PromptImageAttachment } from "../shared/ipc";
import type { AnthropicProxyResolvedRoute } from "./anthropic-proxy";
import type { RuntimeRoute } from "./billing-resolver";
import type { StartedGatewayRouteBinding } from "./gateway-route-binding";
import type { RequestAttemptResult } from "./request-retry";
import type { RunAttemptContext } from "./thread-run-attempt";
import { buildDriverRoutes, type RuntimeConfigResolution } from "./thread-runtime-routes";

export type ThreadRuntimeProxyResult = RequestAttemptResult & Record<string, unknown>;

export interface ThreadRuntimeProxyAttempt {
  proxy: StartedGatewayRouteBinding;
  routes: ResolvedModelRoute[];
  plannerRoute?: AnthropicProxyResolvedRoute;
}

export interface RunThreadRequestWithRuntimeProxyInput {
  context: RunAttemptContext;
  attachments?: PromptImageAttachment[] | undefined;
  resolveRuntimeConfig: () => RuntimeConfigResolution;
  recordRouteFingerprint: (threadId: string, routes: readonly RuntimeRoute[]) => void;
  startRuntimeProxy: (
    routes: RuntimeRoute[],
    attachments: PromptImageAttachment[] | undefined,
    context: RunAttemptContext,
  ) => Promise<StartedGatewayRouteBinding>;
  onProxyReady?: (attempt: ThreadRuntimeProxyAttempt) => void | Promise<void>;
  /** Called after proxy.close() and usage settle — safe point for attempt-scoped cleanup. */
  onAttemptSettled?: (context: RunAttemptContext) => void;
  run: (attempt: ThreadRuntimeProxyAttempt) => Promise<ThreadRuntimeProxyResult>;
}

/**
 * Start a per-run proxy, execute the driver, then close.
 * Route fingerprint is recorded AFTER the run so resolveResumeOptions still sees the
 * previous fingerprint while deciding Claude resume for this attempt.
 */
export async function runThreadRequestWithRuntimeProxy(
  input: RunThreadRequestWithRuntimeProxyInput,
): Promise<ThreadRuntimeProxyResult> {
  const freshConfig = input.resolveRuntimeConfig();
  if (!freshConfig.ok) {
    return { ok: false, reason: freshConfig.reason };
  }

  const proxy = await input.startRuntimeProxy(freshConfig.routes, input.attachments, input.context);
  try {
    const plannerRoute = proxy.routes.find((route) => route.role === "main");
    const attempt: ThreadRuntimeProxyAttempt = {
      proxy,
      routes: buildDriverRoutes(proxy.routes),
      ...(plannerRoute && { plannerRoute }),
    };
    await input.onProxyReady?.(attempt);
    const result = await input.run(attempt);
    input.recordRouteFingerprint(input.context.threadId, freshConfig.routes);
    return result;
  } finally {
    await proxy.close();
    input.onAttemptSettled?.(input.context);
  }
}
