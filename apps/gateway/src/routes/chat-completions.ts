/**
 * Chat Completions client face for @eco/gateway.
 * Native openai-chat passthrough only — never disguise as Anthropic/Responses.
 */
import type { ChatCompletionsRequest } from "@eco/openai-anthropic-bridge";
import { rejectDisabledModelImageInput } from "../image-input-policy.js";
import { applyModelOutputLimit, withDynamicOutputBudget } from "../model-output-limit.js";
import {
  buildResolveProviderRouteOptions,
  IncompatibleUpstreamKindError,
  MissingProviderIdError,
  ProviderNotFoundError,
  resolveProviderRoute,
  UnsupportedUpstreamKindError,
} from "../provider-router.js";
import { buildRequestLifecycleContext } from "../request-lifecycle.js";
import {
  credentialResolutionErrorResponse,
  reportRouteCredentialResult,
  resolveRouteCredential,
} from "../route-credentials.js";
import type { GatewayLogFn } from "../server.js";
import type {
  GatewayConfig,
  GatewayRequestLifecycleObserver,
  GatewayUsageObserver,
  ResolvedProviderRoute,
} from "../types.js";
import { forwardOpenAIChatPassthrough } from "../upstream/openai-chat-passthrough.js";
import { resolveUpstreamUserAgent } from "../upstream/user-agent.js";

export async function handlePostChatCompletions(
  request: Request,
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  onRequestLifecycle?: GatewayRequestLifecycleObserver,
): Promise<Response> {
  let body: ChatCompletionsRequest;
  try {
    body = (await request.json()) as ChatCompletionsRequest;
  } catch {
    onLog("POST /v1/chat/completions rejected: invalid JSON body");
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  const requestedModel = typeof body.model === "string" ? body.model.trim() : "(missing model)";
  onLog(
    `POST /v1/chat/completions model=${requestedModel} stream=${body.stream === true} providers=${config.providers.map((p) => p.id).join(",")}`,
  );

  let route: ResolvedProviderRoute;
  try {
    route = resolveProviderRoute(
      body.model,
      config.providers,
      buildResolveProviderRouteOptions(request.headers),
    );
  } catch (error) {
    if (
      error instanceof ProviderNotFoundError ||
      error instanceof MissingProviderIdError ||
      error instanceof UnsupportedUpstreamKindError ||
      error instanceof IncompatibleUpstreamKindError
    ) {
      onLog(`POST /v1/chat/completions route error: ${error.message}`);
      return Response.json({ error: { message: error.message } }, { status: error.status });
    }
    throw error;
  }

  const imageRejection = rejectDisabledModelImageInput(route, body);
  if (imageRejection) return imageRejection;
  try {
    route = await resolveRouteCredential(route, config, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return credentialResolutionErrorResponse(error);
  }

  const outputBody = body as unknown as Record<string, unknown>;
  fetchImpl = withDynamicOutputBudget(fetchImpl, route, config, request.signal, onLog);
  applyModelOutputLimit(
    outputBody,
    route,
    body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens",
  );
  if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined) {
    applyModelOutputLimit(outputBody, route, "max_tokens");
  }
  const lifecycle = buildRequestLifecycleContext(route, "chat_completions", onLog, onRequestLifecycle);

  onLog(
    `POST /v1/chat/completions provider=${route.provider.id} kind=${route.upstreamKind} model=${route.upstreamModelId} stream=${body.stream === true}`,
  );

  const response = await forwardOpenAIChatPassthrough(
    route,
    body,
    request.headers,
    fetchImpl,
    onLog,
    onUsage,
    resolveUpstreamUserAgent(request.headers, {
      override: config.upstreamUserAgent,
      byCore: config.upstreamUserAgents,
      fallback: config.userAgentDefault,
    }),
    lifecycle,
  );
  await reportRouteCredentialResult(route, config, response);
  return response;
}
