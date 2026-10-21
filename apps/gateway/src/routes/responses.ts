import {
  normalizeCodexIntegerToolSchemas,
  type ResponsesRequest,
  type ResponsesUsage,
} from "@eco/openai-anthropic-bridge";
import { validateChatGptResponsesRequest } from "../chatgpt-responses-policy.js";
import {
  CODEX_TURN_METADATA_HEADER,
  enrichResolvedRouteWithCodexTurnIdentity,
  parseCodexTurnMetadataHeader,
} from "../codex-turn-metadata.js";
import { resolveEcoMcpHubNamespace } from "../eco-mcp-hub-fixup.js";
import { rejectDisabledModelImageInput } from "../image-input-policy.js";
import { applyModelOutputLimit, withDynamicOutputBudget } from "../model-output-limit.js";
import {
  buildResolveProviderRouteOptions,
  buildUpstreamCompactUrl,
  buildUpstreamUrl,
  IncompatibleUpstreamKindError,
  MissingProviderIdError,
  ProviderNotFoundError,
  resolveProviderRoute,
  UnsupportedUpstreamKindError,
} from "../provider-router.js";
import {
  buildRequestLifecycleContext,
  type RequestLifecycleContext,
  reportLogicalUpstreamFailure,
  tryEmitLogicalCompleted,
} from "../request-lifecycle.js";
import { credentialResolutionErrorResponse, resolveRouteCredential } from "../route-credentials.js";
import type { GatewayLogFn } from "../server.js";
import {
  codexToolArgumentFailureCircuitBreaker,
  normalizeResponsesToolArgumentResponse,
  toolArgumentCircuitBreakResponse,
} from "../tool-argument-guard.js";
import type {
  GatewayCodexTurnMetadata,
  GatewayConfig,
  GatewayRequestLifecycleObserver,
  GatewayToolWriteObserver,
  GatewayUsageEvent,
  GatewayUsageObserver,
  ResolvedProviderRoute,
} from "../types.js";
import { forwardAnthropicMessages } from "../upstream/anthropic-messages.js";
import { fetchUpstreamWithRetry } from "../upstream/fetch-with-retry.js";
import { forwardOpenAIChat } from "../upstream/openai-chat.js";
import { readUpstreamRequestId } from "../upstream/request-id-headers.js";
import { forwardResponsesPassthrough } from "../upstream/responses-passthrough.js";
import { responsesFailedSse } from "../upstream/responses-stream-errors.js";
import {
  extractUpstreamErrorInfo,
  extractUpstreamErrorMessage,
  formatUpstreamHttpError,
  upstreamErrorResponse,
} from "../upstream/upstream-error.js";
import { applyUpstreamUserAgent, resolveUpstreamUserAgent } from "../upstream/user-agent.js";
import { normalizeResponsesUsage } from "../usage-normalize.js";

let compactUsageEventSeq = 0;

export async function handlePostResponses(
  request: Request,
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  onRequestLifecycle?: GatewayRequestLifecycleObserver,
  resolveEcoThreadIdFromCodex?: (codexThreadId: string) => string | undefined,
  onToolWriteStarted?: GatewayToolWriteObserver,
): Promise<Response> {
  let body: ResponsesRequest;
  try {
    body = (await request.json()) as ResponsesRequest;
  } catch {
    onLog("POST /v1/responses rejected: invalid JSON body");
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  const requestedModel = typeof body.model === "string" ? body.model.trim() : "(missing model)";
  const codexTurnMetadata = parseCodexTurnMetadataHeader(request.headers);
  if (request.headers.has(CODEX_TURN_METADATA_HEADER) && !codexTurnMetadata) {
    onLog(`POST /v1/responses received invalid ${CODEX_TURN_METADATA_HEADER}; usage will not be billed`);
  }
  const hubNamespace = resolveEcoMcpHubNamespace(resolveEcoThreadIdFromCodex, codexTurnMetadata?.threadId);
  if (hubNamespace) {
    onLog(
      `eco mcp hub namespace fixup active codexThread=${codexTurnMetadata?.threadId ?? "(unknown)"} hub=${hubNamespace}`,
    );
  }
  onLog(
    `POST /v1/responses model=${requestedModel} stream=${body.stream === true} providers=${config.providers.map((p) => p.id).join(",")}`,
  );

  const failureObservation = codexToolArgumentFailureCircuitBreaker.observe({
    ...(codexTurnMetadata?.threadId ? { threadId: codexTurnMetadata.threadId } : {}),
    ...(codexTurnMetadata?.turnId ? { turnId: codexTurnMetadata.turnId } : {}),
    responsesInput: body.input,
  });
  if (failureObservation?.tripped) {
    onLog(
      `tool argument parse loop stopped thread=${codexTurnMetadata?.threadId ?? "(unknown)"} ` +
        `turn=${codexTurnMetadata?.turnId ?? "(unknown)"} count=${failureObservation.count}`,
    );
    return toolArgumentCircuitBreakResponse(body.stream === true, failureObservation.count);
  }
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
      onLog(`route miss for model=${requestedModel}: ${error.message}`);
      return Response.json({ error: { message: error.message } }, { status: error.status });
    }
    throw error;
  }
  const imageRejection = rejectDisabledModelImageInput(route, body);
  if (imageRejection) return imageRejection;
  route = enrichResolvedRouteWithCodexTurnIdentity(route, codexTurnMetadata);
  try {
    route = await resolveRouteCredential(route, config, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog(`credential resolution failed provider=${route.provider.id}: ${message}`);
    return credentialResolutionErrorResponse(error);
  }
  applyModelOutputLimit(body as unknown as Record<string, unknown>, route, "max_output_tokens");
  fetchImpl = withDynamicOutputBudget(fetchImpl, route, config, request.signal, onLog);
  // The ChatGPT subscription Responses preview rejects max_output_tokens.
  // Pi/Codex send native Responses requests with this field, so remove it
  // after routing (where authMethod is known) before applying the preview
  // policy and forwarding upstream.
  if (route.provider.authMethod === "chatgpt_subscription") {
    delete (body as unknown as Record<string, unknown>).max_output_tokens;
  }
  const policyError = validateChatGptResponsesRequest(route.provider, body);
  if (policyError) {
    onLog(`ChatGPT subscription request rejected provider=${route.provider.id}: ${policyError}`);
    return Response.json({ error: { message: policyError, type: "unsupported_request" } }, { status: 400 });
  }
  // Native Responses providers can require reserved tool schemas to match exactly.
  if (route.upstreamKind !== "responses" && route.upstreamKind !== "gateway-delegated") {
    body = normalizeCodexIntegerToolSchemas(body);
  }

  if (
    hasCompactionTrigger(body.input) &&
    (route.upstreamKind === "openai-chat" || route.upstreamKind === "anthropic-messages")
  ) {
    onLog(
      `responses compaction trigger unsupported provider=${route.provider.id} kind=${route.upstreamKind}`,
    );
    return unsupportedCompactionResponse(
      route,
      `uses ${route.upstreamKind} and does not support Responses compaction triggers.`,
    );
  }

  const upstreamUrl = buildUpstreamUrl(route.provider, route.upstreamKind);
  onLog(
    `route hit provider=${route.provider.id} kind=${route.upstreamKind} upstreamModel=${route.upstreamModelId} → ${upstreamUrl}`,
  );

  const lifecycle = buildRequestLifecycleContext(
    route,
    "responses",
    onLog,
    onRequestLifecycle,
    config.reportCredentialResult,
  );

  // UA: per Harness override → global override → SDK UA → Eco fallback.
  const upstreamUserAgent = resolveUpstreamUserAgent(request.headers, {
    override: config.upstreamUserAgent,
    byCore: config.upstreamUserAgents,
    fallback: config.userAgentDefault,
  });

  let upstreamResponse: Response;
  switch (route.upstreamKind) {
    case "anthropic-messages":
      upstreamResponse = await forwardAnthropicMessages(
        route,
        body,
        request.headers,
        fetchImpl,
        onLog,
        onUsage,
        codexTurnMetadata,
        upstreamUserAgent,
        lifecycle,
        onToolWriteStarted,
      );
      break;
    case "responses":
    case "gateway-delegated":
      upstreamResponse = await forwardResponsesPassthrough(
        route,
        body,
        request.headers,
        fetchImpl,
        onLog,
        onUsage,
        codexTurnMetadata,
        upstreamUserAgent,
        lifecycle,
        onToolWriteStarted,
      );
      break;
    case "openai-chat":
      upstreamResponse = await forwardOpenAIChat(
        route,
        body,
        request.headers,
        fetchImpl,
        onLog,
        onUsage,
        codexTurnMetadata,
        upstreamUserAgent,
        lifecycle,
      );
      break;
    default: {
      const _exhaustive: never = route.upstreamKind;
      return _exhaustive;
    }
  }
  // Codex classifies a JSON HTTP 400 as an opaque transport failure, even when
  // its body carries context_length_exceeded. A failed Responses event reaches
  // native compaction's input-reduction path; keep the original failed lifecycle.
  if (
    body.stream === true &&
    upstreamResponse.status === 400 &&
    upstreamResponse.headers.get("x-eco-upstream-error-code") === "context_length_exceeded"
  ) {
    const message = extractUpstreamErrorMessage(await upstreamResponse.text());
    const headers = new Headers(upstreamResponse.headers);
    headers.set("content-type", "text/event-stream");
    headers.set("cache-control", "no-cache");
    headers.delete("content-length");
    onLog(`responses context overflow delivered as response.failed provider=${route.provider.id}`);
    return new Response(responsesFailedSse(message, "context_length_exceeded"), {
      status: 200,
      headers,
    });
  }
  return normalizeResponsesToolArgumentResponse(upstreamResponse, hubNamespace);
}

/**
 * Native Responses compact endpoint.
 * Protocol-level: forward when upstream is Responses-capable; otherwise 501 unsupported.
 * Eco product compact is owned by Desktop Bridge (intercept before calling gateway).
 */
export async function handlePostResponsesCompact(
  request: Request,
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  onRequestLifecycle?: GatewayRequestLifecycleObserver,
): Promise<Response> {
  let body: ResponsesRequest & Record<string, unknown>;
  try {
    body = (await request.json()) as ResponsesRequest & Record<string, unknown>;
  } catch {
    onLog("POST /v1/responses/compact rejected: invalid JSON body");
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  const requestedModel = typeof body.model === "string" ? body.model.trim() : "(missing model)";
  const codexTurnMetadata = parseCodexTurnMetadataHeader(request.headers);
  if (request.headers.has(CODEX_TURN_METADATA_HEADER) && !codexTurnMetadata) {
    onLog(
      `POST /v1/responses/compact received invalid ${CODEX_TURN_METADATA_HEADER}; usage will not be billed`,
    );
  }

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
      onLog(`compact route miss for model=${requestedModel}: ${error.message}`);
      return Response.json({ error: { message: error.message } }, { status: error.status });
    }
    throw error;
  }
  const imageRejection = rejectDisabledModelImageInput(route, body);
  if (imageRejection) return imageRejection;
  route = enrichResolvedRouteWithCodexTurnIdentity(route, codexTurnMetadata);
  try {
    route = await resolveRouteCredential(route, config, request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return credentialResolutionErrorResponse(error);
  }

  if (route.upstreamKind !== "responses" && route.upstreamKind !== "gateway-delegated") {
    onLog(`POST /v1/responses/compact unsupported provider=${route.provider.id} kind=${route.upstreamKind}`);
    return unsupportedCompactionResponse(
      route,
      `uses ${route.upstreamKind} and does not support native Responses /v1/responses/compact.`,
    );
  }

  const upstreamUrl = buildUpstreamCompactUrl(route.provider);
  const upstreamBody = {
    ...body,
    model: route.upstreamModelId,
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${route.provider.apiKey}`,
  };
  const openAiOrg = request.headers.get("openai-organization");
  if (openAiOrg) {
    headers["openai-organization"] = openAiOrg;
  }
  const openAiProject = request.headers.get("openai-project");
  if (openAiProject) {
    headers["openai-project"] = openAiProject;
  }
  applyUpstreamUserAgent(
    headers,
    request.headers,
    resolveUpstreamUserAgent(request.headers, {
      override: config.upstreamUserAgent,
      byCore: config.upstreamUserAgents,
      fallback: config.userAgentDefault,
    }),
  );

  const lifecycle = buildRequestLifecycleContext(
    route,
    "responses",
    onLog,
    onRequestLifecycle,
    config.reportCredentialResult,
  );

  onLog(
    `POST /v1/responses/compact provider=${route.provider.id} model=${route.upstreamModelId} → ${upstreamUrl}`,
  );

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchUpstreamWithRetry({
      fetchImpl,
      url: upstreamUrl,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      },
      lifecycle,
      onLog,
      httpFailureContext: { route, upstreamUrl },
      ...(route.provider.upstreamProxyUrl ? { upstreamProxyUrl: route.provider.upstreamProxyUrl } : {}),
    });
  } catch (error) {
    const message = errorMessage(error);
    onLog(`compact upstream fetch failed ${upstreamUrl}: ${message}`);
    return invalidCompactResponse(route, upstreamUrl, message);
  }

  onLog(`compact upstream ${upstreamUrl} status=${upstreamResponse.status}`);

  const responseText = await upstreamResponse.text();
  const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
  const errorInfo = extractUpstreamErrorInfo(responseText, "http");
  if (!upstreamResponse.ok) {
    if (lifecycle) {
      reportLogicalUpstreamFailure(lifecycle, {
        stage: "http",
        error: formatUpstreamHttpError({
          route,
          upstreamUrl,
          status: upstreamResponse.status,
          bodyText: responseText,
        }),
        statusCode: upstreamResponse.status,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...(errorInfo ? { errorInfo } : {}),
      });
    }
    return recreateResponse(upstreamResponse, responseText);
  }

  const validationError = validateCompactJson(responseText);
  if (validationError) {
    onLog(`compact response invalid: ${validationError}`);
    if (lifecycle) {
      reportLogicalUpstreamFailure(lifecycle, {
        stage: "protocol",
        error: validationError,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    }
    return invalidCompactResponse(route, upstreamUrl, validationError);
  }

  if (onUsage && codexTurnMetadata) {
    observeNativeCompactUsage({
      text: responseText,
      responseHeaders: upstreamResponse.headers,
      route,
      codexTurnMetadata,
      onUsage,
      onLog,
    });
  }

  if (lifecycle) {
    tryEmitLogicalCompleted(lifecycle, providerRequestId);
  }

  return recreateResponse(upstreamResponse, responseText);
}

function observeNativeCompactUsage(input: {
  text: string;
  responseHeaders: Headers;
  route: ResolvedProviderRoute;
  codexTurnMetadata: GatewayCodexTurnMetadata;
  onUsage: GatewayUsageObserver;
  onLog: GatewayLogFn;
}): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input.text) as Record<string, unknown>;
  } catch {
    return;
  }
  const responseId = readString(parsed, "id");
  const usage = normalizeResponsesUsage(
    parsed.usage as ResponsesUsage | undefined,
    input.route.upstreamModelId,
  );
  if (!usage) {
    input.onLog(`compact usage skipped provider=${input.route.provider.id} reason=missing_or_invalid_usage`);
    return;
  }
  const providerRequestId = readUpstreamRequestId(input.responseHeaders);
  const event: GatewayUsageEvent = {
    source: "responses",
    sourceEventId: buildCompactUsageSourceEventId({
      route: input.route,
      ...(responseId ? { responseId } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
    }),
    providerId: input.route.provider.id,
    requestedModel: input.route.requestedModel,
    upstreamModelId: input.route.upstreamModelId,
    usage,
    stream: false,
    observedAt: new Date().toISOString(),
    codexTurnMetadata: input.codexTurnMetadata,
    ...(responseId ? { responseId } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(input.route.logicalRequestId?.trim()
      ? { logicalRequestId: input.route.logicalRequestId.trim() }
      : {}),
  };
  try {
    void Promise.resolve(input.onUsage(event)).catch((error) => {
      input.onLog(`usage observer failed: ${errorMessage(error)}`);
    });
  } catch (error) {
    input.onLog(`usage observer failed: ${errorMessage(error)}`);
  }
}

function buildCompactUsageSourceEventId(input: {
  route: ResolvedProviderRoute;
  responseId?: string;
  providerRequestId?: string;
}): string {
  if (input.responseId) {
    return `responses:${input.route.provider.id}:response:${input.responseId}`;
  }
  if (input.providerRequestId) {
    return `responses:${input.route.provider.id}:request:${input.providerRequestId}`;
  }
  compactUsageEventSeq += 1;
  return [
    "responses",
    input.route.provider.id,
    input.route.requestedModel,
    "compaction",
    Date.now(),
    compactUsageEventSeq,
  ].join(":");
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateCompactJson(text: string): string | undefined {
  if (!text.trim()) {
    return "upstream returned an empty compact response body";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "upstream compact response is not valid JSON";
  }
  if (!isRecord(parsed)) {
    return "upstream compact response root is not an object";
  }
  if (!Array.isArray(parsed.output) || parsed.output.length === 0) {
    return "upstream compact response output is missing or empty";
  }
  if (parsed.output.some((item) => !isRecord(item) || typeof item.type !== "string" || !item.type.trim())) {
    return "upstream compact response contains an invalid output item";
  }
  const compactionItems = parsed.output.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === "compaction",
  );
  if (compactionItems.length !== 1) {
    return "upstream compact response output must contain exactly one compaction item";
  }
  const encryptedContent = compactionItems[0]?.encrypted_content;
  if (typeof encryptedContent !== "string" || encryptedContent.trim().length === 0) {
    return "upstream compact response compaction item encrypted_content is missing or empty";
  }
  return undefined;
}

function hasCompactionTrigger(input: unknown): boolean {
  let parsedInput = input;
  if (typeof parsedInput === "string") {
    try {
      parsedInput = JSON.parse(parsedInput) as unknown;
    } catch {
      return false;
    }
  }
  return (
    Array.isArray(parsedInput) &&
    parsedInput.some((item) => isRecord(item) && item.type === "compaction_trigger")
  );
}

function unsupportedCompactionResponse(route: ResolvedProviderRoute, reason: string): Response {
  return Response.json(
    {
      error: {
        message: `Provider ${route.provider.id} ${reason}`,
        type: "unsupported_error",
        providerId: route.provider.id,
        model: route.upstreamModelId,
      },
    },
    { status: 501 },
  );
}

function invalidCompactResponse(route: ResolvedProviderRoute, upstreamUrl: string, detail: string): Response {
  return upstreamErrorResponse({
    route,
    upstreamUrl,
    status: 502,
    bodyText: detail,
  });
}

function recreateResponse(source: Response, text: string): Response {
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(text, {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function handleHealth(config: GatewayConfig): Response {
  return Response.json({
    ok: true,
    service: "eco-gateway",
    providers: config.providers.map((provider) => ({
      id: provider.id,
      upstreamKind: provider.upstreamKind,
      models: provider.models,
    })),
  });
}
