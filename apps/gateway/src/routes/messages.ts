/**
 * Anthropic Messages client face for @eco/gateway.
 * Bridge injects x-gateway-provider-id + concrete model before calling gateway.
 */
import {
  type AnthropicRequest,
  anthropicToResponses,
  extractAnthropicRequestToolNames,
  finalizeResponsesAnthropicStream,
  newResponsesEventToAnthropicState,
  type ResponsesRequest,
  type ResponsesResponse,
  type ResponsesStreamEvent,
  responsesAnthropicEventToSse,
  responsesEventToAnthropicEvents,
  responsesToAnthropic,
} from "@eco/openai-anthropic-bridge";
import {
  type AnthropicStreamUsageTracker,
  newAnthropicStreamUsageTracker,
  resolveAnthropicStreamUsage,
  trackAnthropicStreamUsage,
} from "../anthropic-stream-usage.js";
import { rejectDisabledModelImageInput } from "../image-input-policy.js";
import { applyModelOutputLimit, withDynamicOutputBudget } from "../model-output-limit.js";
import {
  applyGatewayResponsesPromptCacheHints,
  buildResolveProviderRouteOptions,
  buildUpstreamCountTokensUrl,
  buildUpstreamUrl,
  IncompatibleUpstreamKindError,
  MissingProviderIdError,
  ProviderNotFoundError,
  readThreadIdFromHeaders,
  resolveProviderRoute,
  UnsupportedUpstreamKindError,
} from "../provider-router.js";
import {
  buildRequestLifecycleContext,
  type RequestLifecycleContext,
  reportLogicalUpstreamFailure,
  tryEmitLogicalCancelled,
  tryEmitLogicalCompleted,
} from "../request-lifecycle.js";
import {
  credentialResolutionErrorResponse,
  reportRouteCredentialResult,
  resolveRouteCredential,
} from "../route-credentials.js";
import type { GatewayLogFn } from "../server.js";
import {
  appendStreamUtf8Chunk,
  createStreamUtf8Decoder,
  finalizeStreamUtf8Decoder,
  parseAnthropicStreamEventBlock,
  parseResponsesStreamEventBlock,
  splitSseBlocks,
} from "../sse.js";
import type {
  GatewayConfig,
  GatewayRequestLifecycleObserver,
  GatewayUsageEvent,
  GatewayUsageObserver,
  ResolvedProviderRoute,
} from "../types.js";
import { fetchWithThinkingRectifiers } from "../upstream/anthropic-messages.js";
import { collectResponsesStream, ResponsesStreamError } from "../upstream/collect-responses-stream.js";
import { fetchUpstreamWithRetry } from "../upstream/fetch-with-retry.js";
import { forwardOpenAIChat } from "../upstream/openai-chat.js";
import { headersWithLogicalRequestIdentity, readUpstreamRequestId } from "../upstream/request-id-headers.js";
import {
  isDeepSeekResponsesUpstreamModel,
  sanitizeDeepSeekResponsesCustomTools,
} from "../upstream/responses-passthrough.js";
import {
  extractUpstreamErrorCode,
  extractUpstreamErrorMessage,
  formatUpstreamHttpError,
} from "../upstream/upstream-error.js";
import { applyUpstreamUserAgent, resolveUpstreamUserAgent } from "../upstream/user-agent.js";
import {
  extractUsageFromResponsesStreamEvent,
  normalizeAnthropicUsage,
  normalizeResponsesUsage,
  type ParsedUsage,
} from "../usage-normalize.js";

const ANTHROPIC_VERSION = "2023-06-01";

/** Top-level Responses fields some OpenAI-compat hosts reject (DeepSeek/etc.). */
const DROPPABLE_RESPONSES_PARAMS = new Set([
  "cache_control",
  "context_management",
  "include",
  "parallel_tool_calls",
  "store",
  "text",
  "service_tier",
  "prompt_cache_key",
  "prompt_cache_retention",
  "previous_response_id",
  "temperature",
  "top_p",
  "reasoning",
]);

const MAX_UNSUPPORTED_PARAM_DROPS = 8;

/** Abort hang when upstream SSE sends headers but never emits a framed event. */
const RESPONSES_STREAM_FIRST_EVENT_TIMEOUT_MS = 45_000;

export async function handlePostMessages(
  request: Request,
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  onRequestLifecycle?: GatewayRequestLifecycleObserver,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  let route: ResolvedProviderRoute;
  try {
    route = resolveProviderRoute(
      body.model as string | undefined,
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

  body.model = route.upstreamModelId;
  const stream = body.stream === true;
  const upstreamUrl = buildUpstreamUrl(route.provider, route.upstreamKind);
  onLog(
    `POST /v1/messages provider=${route.provider.id} kind=${route.upstreamKind} model=${route.upstreamModelId} downstreamStream=${stream}`,
  );

  applyModelOutputLimit(body, route, "max_tokens");
  fetchImpl = withDynamicOutputBudget(fetchImpl, route, config, request.signal, onLog);
  const lifecycle = buildRequestLifecycleContext(route, "messages", onLog, onRequestLifecycle);

  let response: Response;
  // UA: per agent core override → global override → SDK UA → Eco fallback.
  const upstreamUserAgent = resolveUpstreamUserAgent(request.headers, {
    override: config.upstreamUserAgent,
    byCore: config.upstreamUserAgents,
    fallback: config.userAgentDefault,
  });
  switch (route.upstreamKind) {
    case "anthropic-messages":
      response = await forwardMessagesNative(
        route,
        body,
        request.headers,
        upstreamUrl,
        fetchImpl,
        onLog,
        onUsage,
        upstreamUserAgent,
        lifecycle,
      );
      break;
    case "responses":
    case "gateway-delegated":
      response = await forwardMessagesViaResponses(
        route,
        body,
        request.headers,
        upstreamUrl,
        fetchImpl,
        onLog,
        onUsage,
        upstreamUserAgent,
        lifecycle,
        request.signal,
      );
      break;
    case "openai-chat":
      response = await forwardMessagesViaOpenAIChat(
        route,
        body,
        request.headers,
        fetchImpl,
        onLog,
        onUsage,
        upstreamUserAgent,
        lifecycle,
      );
      break;
    default: {
      const _exhaustive: never = route.upstreamKind;
      return _exhaustive;
    }
  }
  await reportRouteCredentialResult(route, config, response);
  return response;
}

export async function handleGetModels(config: GatewayConfig): Promise<Response> {
  const data = config.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model,
      object: "model",
      created: 0,
      owned_by: provider.id,
    })),
  );
  return Response.json({ object: "list", data });
}

export async function handlePostMessagesCountTokens(
  request: Request,
  config: GatewayConfig,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  let route: ResolvedProviderRoute;
  try {
    route = resolveProviderRoute(
      body.model as string | undefined,
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
      return Response.json({ error: { message: error.message } }, { status: error.status });
    }
    throw error;
  }

  const imageRejection = rejectDisabledModelImageInput(route, body);
  if (imageRejection) return imageRejection;
  if (route.upstreamKind !== "anthropic-messages") {
    onLog(`count_tokens unsupported for kind=${route.upstreamKind}; missing exact token count`);
    return Response.json(
      {
        error: {
          message: `count_tokens only supported for anthropic-messages upstream (got ${route.upstreamKind})`,
        },
      },
      { status: 501 },
    );
  }

  body.model = route.upstreamModelId;
  const upstreamUrl = buildUpstreamCountTokensUrl(route.provider);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": route.provider.apiKey,
    "anthropic-version": request.headers.get("anthropic-version") ?? ANTHROPIC_VERSION,
  };
  applyUpstreamUserAgent(
    headers,
    request.headers,
    resolveUpstreamUserAgent(request.headers, {
      override: config.upstreamUserAgent,
      byCore: config.upstreamUserAgents,
      fallback: config.userAgentDefault,
    }),
  );
  try {
    return await fetchUpstreamWithRetry({
      fetchImpl,
      url: upstreamUrl,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
      onLog,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: { message } }, { status: 502 });
  }
}

async function forwardMessagesViaOpenAIChat(
  route: ResolvedProviderRoute,
  body: Record<string, unknown>,
  clientHeaders: Headers,
  fetchImpl: typeof fetch,
  onLog: GatewayLogFn,
  onUsage: GatewayUsageObserver | undefined,
  upstreamUserAgent: string | undefined,
  lifecycle?: RequestLifecycleContext,
): Promise<Response> {
  const anthropicBody = {
    ...body,
    model: route.upstreamModelId,
  } as unknown as AnthropicRequest;
  const requestToolNames = extractAnthropicRequestToolNames(anthropicBody);
  const responsesBody = anthropicToResponses(anthropicBody) as ResponsesRequest;
  responsesBody.model = route.upstreamModelId;
  const chatThreadId = readThreadIdFromHeaders(clientHeaders);
  applyGatewayResponsesPromptCacheHints(responsesBody as unknown as Record<string, unknown>, {
    providerBaseUrl: route.provider.baseUrl,
    ...(chatThreadId ? { threadId: chatThreadId } : {}),
  });
  const wantStream = body.stream === true;
  const startedAt = Date.now();

  // Reuse Responses→Chat conversion but bill only via Messages face (source=messages).
  // Passing onUsage into forwardOpenAIChat would emit source=responses without codex turn metadata.
  const responsesResponse = await forwardOpenAIChat(
    route,
    responsesBody,
    clientHeaders,
    fetchImpl,
    onLog,
    undefined,
    undefined,
    upstreamUserAgent,
    lifecycle,
  );

  if (!responsesResponse.ok) {
    const text = await responsesResponse.text();
    const message =
      extractUpstreamErrorMessage(text) || `Upstream chat conversion failed (${responsesResponse.status})`;
    onLog(`messages→chat upstream error status=${responsesResponse.status}: ${message.slice(0, 300)}`);
    if (wantStream) {
      return anthropicErrorSseResponse(responsesResponse.status, message);
    }
    return anthropicErrorResponse(responsesResponse.status, message);
  }

  if (!wantStream) {
    const json = (await responsesResponse.json()) as ResponsesResponse;
    const anthropic = responsesToAnthropic(json, route.upstreamModelId, requestToolNames);
    if (onUsage) {
      const usage =
        normalizeAnthropicUsage((anthropic as { usage?: unknown }).usage, route.upstreamModelId) ??
        normalizeResponsesUsage(json.usage, route.upstreamModelId);
      if (usage) {
        emitMessagesUsage(
          onUsage,
          route,
          usage,
          false,
          (anthropic as { id?: string }).id ?? (json as { id?: string }).id,
          onLog,
        );
      }
    }
    return Response.json(anthropic, {
      status: 200,
      headers: headersWithLogicalRequestIdentity(responsesResponse.headers, route.logicalRequestId, {
        "content-type": "application/json",
      }),
    });
  }

  if (!responsesResponse.body) {
    return anthropicErrorSseResponse(502, "Empty stream body after chat conversion");
  }

  // Same Responses SSE → Anthropic path as messages→responses (eager pump + tool names).
  return mapResponsesSseBodyToAnthropic({
    upstreamBody: responsesResponse.body,
    upstreamHeaders: responsesResponse.headers,
    requestToolNames,
    providerId: route.provider.id,
    startedAt,
    onLog,
    faceLabel: "messages→chat",
    route,
    ...(onUsage ? { onUsage } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  });
}

async function forwardMessagesNative(
  route: ResolvedProviderRoute,
  body: Record<string, unknown>,
  clientHeaders: Headers,
  upstreamUrl: string,
  fetchImpl: typeof fetch,
  onLog: GatewayLogFn,
  onUsage: GatewayUsageObserver | undefined,
  upstreamUserAgent: string | undefined,
  lifecycle?: RequestLifecycleContext,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": route.provider.apiKey,
    "anthropic-version": clientHeaders.get("anthropic-version") ?? ANTHROPIC_VERSION,
  };
  const beta = clientHeaders.get("anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;
  applyUpstreamUserAgent(headers, clientHeaders, upstreamUserAgent);

  const anthropicBody = {
    ...body,
    model: route.upstreamModelId,
  } as unknown as AnthropicRequest;

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchWithThinkingRectifiers(
      route,
      upstreamUrl,
      headers,
      anthropicBody,
      fetchImpl,
      onLog,
      lifecycle,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog(`messages native upstream failed: ${message}`);
    reportLogicalUpstreamFailure(lifecycle, { stage: "transport", error: message });
    return Response.json({ error: { message } }, { status: 502 });
  }

  if (!upstreamResponse.ok) {
    return upstreamResponse;
  }

  if (body.stream !== true) {
    const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
    tryEmitLogicalCompleted(lifecycle, providerRequestId);
    if (onUsage) {
      try {
        const cloned = upstreamResponse.clone();
        const json = (await cloned.json()) as { usage?: unknown; id?: string };
        const usage = normalizeAnthropicUsage(json.usage as never, route.upstreamModelId);
        if (usage) {
          emitMessagesUsage(onUsage, route, usage, false, json.id, onLog);
        }
      } catch {
        // ignore usage parse
      }
    }
    const logicalRequestId = route.logicalRequestId;
    if (!logicalRequestId?.trim()) {
      return upstreamResponse;
    }
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, logicalRequestId),
    });
  }

  return passThroughAnthropicSseWithUsage(upstreamResponse, route, onUsage, onLog, lifecycle);
}

async function forwardMessagesViaResponses(
  route: ResolvedProviderRoute,
  body: Record<string, unknown>,
  clientHeaders: Headers,
  upstreamUrl: string,
  fetchImpl: typeof fetch,
  onLog: GatewayLogFn,
  onUsage: GatewayUsageObserver | undefined,
  upstreamUserAgent: string | undefined,
  lifecycle?: RequestLifecycleContext,
  signal?: AbortSignal,
): Promise<Response> {
  const anthropicBody = {
    ...body,
    model: route.upstreamModelId,
  } as unknown as AnthropicRequest;
  const requestToolNames = extractAnthropicRequestToolNames(anthropicBody);
  let responsesBody = sanitizeDeepSeekResponsesCustomTools(
    anthropicToResponses(anthropicBody) as ResponsesRequest,
    route.upstreamModelId,
  );
  responsesBody.model = route.upstreamModelId;

  // Subscription upstream requires SSE regardless of the Messages client's
  // response mode. Non-streaming clients receive the collected terminal JSON.
  if (route.provider.authMethod === "chatgpt_subscription") {
    responsesBody.stream = true;
    delete (responsesBody as unknown as Record<string, unknown>).max_output_tokens;
  }

  // PI/Claude Messages face never passes through desktop applyResponsesRoutingHints.
  // Inject the same eco_thread_* key so Responses prefix cache can stick across tool turns.
  const responsesThreadId = readThreadIdFromHeaders(clientHeaders);
  const promptCacheKey = applyGatewayResponsesPromptCacheHints(
    responsesBody as unknown as Record<string, unknown>,
    {
      providerBaseUrl: route.provider.baseUrl,
      ...(responsesThreadId ? { threadId: responsesThreadId } : {}),
    },
  );
  if (promptCacheKey) {
    onLog(`messages→responses prompt_cache_key=${promptCacheKey}`);
  }

  // Preempt soft-fail fields that DeepSeek (and peers) often accept in headers but
  // stall on encrypted-content / verbosity while streaming.
  if (isDeepSeekResponsesUpstreamModel(route.upstreamModelId)) {
    const rec = responsesBody as unknown as Record<string, unknown>;
    for (const key of ["include", "store", "parallel_tool_calls"] as const) {
      if (key in rec) {
        delete rec[key];
      }
    }
    if (rec.text && typeof rec.text === "object") {
      // Keep json_schema formats if present; drop style-only verbosity.
      const text = rec.text as Record<string, unknown>;
      if (text.format === undefined && text.verbosity !== undefined) {
        delete rec.text;
      }
    }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${route.provider.apiKey}`,
  };
  applyUpstreamUserAgent(headers, clientHeaders, upstreamUserAgent);

  const wantStream = body.stream === true;
  const startedAt = Date.now();
  let upstreamResponse: Response;
  let droppedParams: string[] = [];
  try {
    const posted = await postResponsesWithUnsupportedParamRetry({
      fetchImpl,
      url: upstreamUrl,
      headers,
      body: responsesBody as unknown as Record<string, unknown>,
      onLog,
      route,
      ...(lifecycle ? { lifecycle } : {}),
      ...(signal ? { signal } : {}),
    });
    upstreamResponse = posted.response;
    responsesBody = posted.body as unknown as ResponsesRequest;
    droppedParams = posted.droppedParams;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog(`messages→responses upstream failed: ${message}`);
    return anthropicErrorResponse(502, message);
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  // OAuth's stream:true contract is authoritative. Its successful SSE replies
  // can omit Content-Type; parsing them as JSON triggers SDK non-stream retries.
  const isEventStream =
    contentType.includes("text/event-stream") ||
    (route.provider.authMethod === "chatgpt_subscription" && responsesBody.stream === true);
  onLog(
    `messages→responses upstream status=${upstreamResponse.status} ct=${contentType} downstreamStream=${wantStream} upstreamStream=${responsesBody.stream === true} tools=${requestToolNames.length} dropped=${droppedParams.join(",") || "(none)"} ttfb=${Date.now() - startedAt}ms`,
  );

  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    onLog(`messages→responses error body: ${text.slice(0, 300)}`);
    const detailed = formatUpstreamHttpError({
      route,
      upstreamUrl,
      status: upstreamResponse.status,
      bodyText: text,
    });
    const upstreamErrorCode = extractUpstreamErrorCode(text);
    const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
    reportLogicalUpstreamFailure(lifecycle, {
      stage: "http",
      error: detailed,
      statusCode: upstreamResponse.status,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
    if (wantStream) {
      return anthropicErrorSseResponse(upstreamResponse.status, detailed, {
        preserveHttpStatus: route.provider.authMethod === "chatgpt_subscription",
        ...(upstreamErrorCode ? { errorCode: upstreamErrorCode } : {}),
      });
    }
    return anthropicErrorResponse(upstreamResponse.status, detailed, upstreamErrorCode);
  }

  // Stream requested but upstream replied with JSON (or missing body): convert non-SSE.
  if (wantStream && (!isEventStream || !upstreamResponse.body)) {
    const text = await upstreamResponse.text();
    onLog(
      `messages→responses non-SSE while stream=true len=${text.length} head=${text.slice(0, 120).replace(/\s+/g, " ")}`,
    );
    try {
      const json = JSON.parse(text) as ResponsesResponse;
      const anthropic = responsesToAnthropic(json, route.upstreamModelId, requestToolNames);
      if (onUsage) {
        const usage =
          normalizeAnthropicUsage((anthropic as { usage?: unknown }).usage, route.upstreamModelId) ??
          normalizeResponsesUsage(json.usage, route.upstreamModelId);
        if (usage) {
          emitMessagesUsage(
            onUsage,
            route,
            usage,
            true,
            (anthropic as { id?: string }).id ?? (json as { id?: string }).id,
            onLog,
          );
        }
      }
      tryEmitLogicalCompleted(lifecycle, readUpstreamRequestId(upstreamResponse.headers));
      // Flatten non-stream result into a minimal Anthropic SSE so the Claude SDK keeps the stream path.
      return anthropicJsonAsSse(anthropic, upstreamResponse.headers, route.logicalRequestId);
    } catch {
      const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
      reportLogicalUpstreamFailure(lifecycle, {
        stage: "protocol",
        error: `Upstream returned non-SSE body for stream request: ${extractUpstreamErrorMessage(text)}`,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      return anthropicErrorSseResponse(
        502,
        `Upstream returned non-SSE body for stream request: ${extractUpstreamErrorMessage(text)}`,
      );
    }
  }

  if (!wantStream) {
    let json: ResponsesResponse;
    let anthropic: ReturnType<typeof responsesToAnthropic>;
    try {
      if (isEventStream) {
        if (!upstreamResponse.body) throw new ResponsesStreamError("Empty upstream Responses stream");
        json = await collectResponsesStream(upstreamResponse.body, { ...(signal ? { signal } : {}) });
      } else {
        json = (await upstreamResponse.json()) as ResponsesResponse;
      }
      anthropic = responsesToAnthropic(json, route.upstreamModelId, requestToolNames);
      // The bridge retains serialized tool arguments; Messages JSON consumers
      // require tool_use.input to be an object, as the streaming SDK produces.
      for (const block of anthropic.content) {
        if (block.type === "tool_use" && typeof block.input === "string") {
          const input: unknown = JSON.parse(block.input);
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new ResponsesStreamError(
              "Invalid upstream tool arguments: expected a JSON object",
              "invalid_tool_arguments",
            );
          }
          block.input = input;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
      onLog(`messages→responses non-stream collection failed: ${message}`);
      if (signal?.aborted) {
        tryEmitLogicalCancelled(lifecycle, { reason: message });
      } else {
        reportLogicalUpstreamFailure(lifecycle, {
          stage: "stream",
          error: message,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
      }
      return anthropicErrorResponse(
        502,
        message,
        error instanceof ResponsesStreamError ? error.code : undefined,
      );
    }
    if (onUsage) {
      const usage = normalizeResponsesUsage(json.usage, route.upstreamModelId);
      if (usage) {
        emitMessagesUsage(onUsage, route, usage, false, (json as { id?: string }).id, onLog);
      }
    }
    tryEmitLogicalCompleted(lifecycle, readUpstreamRequestId(upstreamResponse.headers));
    return Response.json(anthropic, {
      status: 200,
      headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
        "content-type": "application/json",
      }),
    });
  }

  if (!upstreamResponse.body) {
    return anthropicErrorSseResponse(502, "Empty stream body");
  }

  return mapResponsesSseBodyToAnthropic({
    upstreamBody: upstreamResponse.body,
    upstreamHeaders: upstreamResponse.headers,
    requestToolNames,
    providerId: route.provider.id,
    startedAt,
    onLog,
    faceLabel: "messages→responses",
    route,
    ...(onUsage ? { onUsage } : {}),
    ...(lifecycle ? { lifecycle } : {}),
  });
}

function passThroughAnthropicSseWithUsage(
  upstreamResponse: Response,
  route: ResolvedProviderRoute,
  onUsage: GatewayUsageObserver | undefined,
  onLog: GatewayLogFn,
  lifecycle?: RequestLifecycleContext,
): Response {
  if (!upstreamResponse.body) {
    return upstreamResponse;
  }

  const reader = upstreamResponse.body.getReader();
  const tracker = newAnthropicStreamUsageTracker();
  const utf8Decoder = createStreamUtf8Decoder();
  const encoder = new TextEncoder();
  let sseBuffer = "";
  let usageSettled = false;
  const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
  let streamFailed = false;
  let sawMessageStop = false;
  let cancelled = false;
  let terminalSettled = false;

  const settleUsage = () => {
    if (cancelled || usageSettled || !onUsage) {
      return;
    }
    usageSettled = true;
    settleMessagesStreamUsage(tracker, route, onUsage, onLog, undefined, lifecycle);
  };

  const closeDownstreamAndCancelUpstream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    try {
      controller.close();
    } catch {
      // already closed
    }
    void reader.cancel().catch(() => undefined);
  };

  const enqueueSseBlock = (controller: ReadableStreamDefaultController<Uint8Array>, block: string) => {
    const framed = block.endsWith("\n\n") ? block : `${block}\n\n`;
    controller.enqueue(encoder.encode(framed));
  };

  /** @returns true when terminal froze the stream */
  const observeEnqueuedBlock = (
    block: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    if (terminalSettled || cancelled) {
      return true;
    }
    const event = parseAnthropicStreamEventBlock(block);
    if (!event) {
      return false;
    }
    if (event.type === "error") {
      streamFailed = true;
      const errEvent = event as unknown as { error?: { message?: string } };
      const message =
        typeof errEvent.error?.message === "string"
          ? errEvent.error.message
          : "Upstream Anthropic stream error";
      settleUsage();
      reportLogicalUpstreamFailure(lifecycle, {
        stage: "stream",
        error: message,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      closeDownstreamAndCancelUpstream(controller);
      return true;
    }
    lifecycle?.tracker.noteFirstChunk();
    trackAnthropicStreamUsage(tracker, event);
    if (event.type === "message_stop") {
      sawMessageStop = true;
      settleUsage();
      tryEmitLogicalCompleted(lifecycle, providerRequestId);
      closeDownstreamAndCancelUpstream(controller);
      return true;
    }
    return false;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (!cancelled && !terminalSettled) {
          const { done, value } = await reader.read();
          if (cancelled || terminalSettled) {
            return;
          }
          if (done) {
            sseBuffer = finalizeStreamUtf8Decoder(utf8Decoder, sseBuffer);
            if (sseBuffer.trim()) {
              const { blocks } = splitSseBlocks(`${sseBuffer}\n\n`);
              for (const block of blocks) {
                enqueueSseBlock(controller, block);
                if (observeEnqueuedBlock(block, controller)) {
                  return;
                }
              }
            }
            if (cancelled || terminalSettled) {
              return;
            }
            if (!streamFailed && !sawMessageStop) {
              streamFailed = true;
              settleUsage();
              const message = "Upstream Anthropic stream ended before message_stop.";
              reportLogicalUpstreamFailure(lifecycle, {
                stage: "stream",
                error: message,
                ...(providerRequestId ? { providerRequestId } : {}),
              });
              try {
                controller.enqueue(
                  encoder.encode(
                    responsesAnthropicEventToSse({
                      type: "error",
                      error: { type: "api_error", message },
                    } as never),
                  ),
                );
              } catch {
                // downstream already closed
              }
            }
            closeDownstreamAndCancelUpstream(controller);
            return;
          }
          if (value) {
            sseBuffer = appendStreamUtf8Chunk(utf8Decoder, sseBuffer, value);
            const { blocks, remainder } = splitSseBlocks(sseBuffer);
            sseBuffer = remainder;
            for (const block of blocks) {
              enqueueSseBlock(controller, block);
              if (observeEnqueuedBlock(block, controller)) {
                return;
              }
            }
          }
        }
      } catch (error) {
        if (cancelled || terminalSettled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        reportLogicalUpstreamFailure(lifecycle, {
          stage: "stream",
          error: message,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
        try {
          controller.error(error instanceof Error ? error : new Error(String(error)));
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      cancelled = true;
      tryEmitLogicalCancelled(lifecycle, {
        reason: "downstream cancelled",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      void reader.cancel().catch(() => undefined);
    },
  });

  const headers = headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
    "content-type": upstreamResponse.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
    "cache-control": upstreamResponse.headers.get("cache-control") ?? "no-cache",
  });

  return new Response(stream, {
    status: upstreamResponse.status,
    headers,
  });
}

function mapResponsesSseBodyToAnthropic(input: {
  upstreamBody: ReadableStream<Uint8Array>;
  upstreamHeaders: Headers;
  requestToolNames: readonly string[];
  providerId: string;
  startedAt: number;
  onLog: GatewayLogFn;
  /** Log label for ops (chat vs responses face). */
  faceLabel?: string;
  route?: ResolvedProviderRoute;
  onUsage?: GatewayUsageObserver;
  lifecycle?: RequestLifecycleContext;
}): Response {
  const face = input.faceLabel ?? "messages→responses";
  const providerRequestId = readUpstreamRequestId(input.upstreamHeaders);
  const state = newResponsesEventToAnthropicState(input.requestToolNames);
  const utf8Decoder = createStreamUtf8Decoder();
  let sseBuffer = "";
  const reader = input.upstreamBody.getReader();
  const encoder = new TextEncoder();
  let rawEventCount = 0;
  let anthropicEventCount = 0;
  const rawTypes: Record<string, number> = {};
  let parseFailures = 0;
  let firstByteLogged = false;
  let closed = false;
  const usageTracker = newAnthropicStreamUsageTracker();
  let fallbackResponsesUsage: ParsedUsage | undefined;
  let fallbackResponseId: string | undefined;
  let usageSettled = false;

  const settleUsage = () => {
    if (cancelled || usageSettled || !input.onUsage || !input.route) {
      return;
    }
    usageSettled = true;
    settleMessagesStreamUsage(
      usageTracker,
      input.route,
      input.onUsage,
      input.onLog,
      fallbackResponsesUsage
        ? {
            usage: fallbackResponsesUsage,
            ...(fallbackResponseId ? { responseId: fallbackResponseId } : {}),
          }
        : undefined,
      input.lifecycle,
    );
  };

  let cancelled = false;
  let sawResponseCompleted = false;
  let streamFailed = false;
  let terminalSettled = false;
  let firstEventTimer: ReturnType<typeof setTimeout> | undefined;

  const clearFirstEventTimer = () => {
    if (firstEventTimer !== undefined) {
      clearTimeout(firstEventTimer);
      firstEventTimer = undefined;
    }
  };

  const closeDownstreamAndCancelUpstream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    closed = true;
    clearFirstEventTimer();
    try {
      controller.close();
    } catch {
      // already closed
    }
    void reader.cancel().catch(() => undefined);
  };

  const completeFromResponses = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (terminalSettled || cancelled || streamFailed) {
      return;
    }
    for (const event of finalizeResponsesAnthropicStream(state)) {
      anthropicEventCount += 1;
      trackAnthropicStreamUsage(usageTracker, event as never);
      try {
        controller.enqueue(encoder.encode(responsesAnthropicEventToSse(event)));
      } catch {
        // downstream already closed
      }
    }
    settleUsage();
    if (!state.messageStartSent) {
      const msg =
        `${face} produced no Anthropic stream events ` +
        `(raw=${rawEventCount} parseFail=${parseFailures} types=${JSON.stringify(rawTypes)}).`;
      input.onLog(msg);
      streamFailed = true;
      if (!input.lifecycle?.tracker.hasUpstreamFailed()) {
        reportLogicalUpstreamFailure(input.lifecycle, {
          stage: "stream",
          error: msg,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
      }
      try {
        controller.enqueue(
          encoder.encode(
            responsesAnthropicEventToSse({
              type: "error",
              error: { type: "api_error", message: msg },
            } as never),
          ),
        );
      } catch {
        // already closed
      }
      closeDownstreamAndCancelUpstream(controller);
      return;
    }
    input.onLog(
      `${face} stream done raw=${rawEventCount} anth=${anthropicEventCount} ` +
        `elapsed=${Date.now() - input.startedAt}ms provider=${input.providerId}`,
    );
    tryEmitLogicalCompleted(input.lifecycle, providerRequestId);
    closeDownstreamAndCancelUpstream(controller);
  };

  const failFromResponses = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: string,
    alreadyEmittedAnthropicError: boolean,
  ) => {
    if (terminalSettled || cancelled) {
      return;
    }
    streamFailed = true;
    if (!alreadyEmittedAnthropicError) {
      try {
        controller.enqueue(
          encoder.encode(
            responsesAnthropicEventToSse({
              type: "error",
              error: { type: "api_error", message },
            } as never),
          ),
        );
      } catch {
        // already closed
      }
    }
    if (!input.lifecycle?.tracker.hasUpstreamFailed()) {
      reportLogicalUpstreamFailure(input.lifecycle, {
        stage: "stream",
        error: message,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    }
    closeDownstreamAndCancelUpstream(controller);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      firstEventTimer = setTimeout(() => {
        if (closed || cancelled || terminalSettled || rawEventCount > 0) {
          return;
        }
        const msg =
          `${face} timed out waiting for first converted SSE event ` +
          `after ${RESPONSES_STREAM_FIRST_EVENT_TIMEOUT_MS}ms (provider=${input.providerId}).`;
        input.onLog(msg);
        failFromResponses(controller, msg, false);
      }, RESPONSES_STREAM_FIRST_EVENT_TIMEOUT_MS);

      const processBlocks = (blocks: readonly string[]) => {
        for (const block of blocks) {
          if (terminalSettled || cancelled) {
            return;
          }
          const counts = enqueueAnthropicFromResponsesSse(
            block,
            state,
            controller,
            encoder,
            rawTypes,
            usageTracker,
            (usage, responseId) => {
              fallbackResponsesUsage = usage;
              if (responseId) {
                fallbackResponseId = responseId;
              }
            },
            input.route?.upstreamModelId,
            input.lifecycle,
            providerRequestId,
            {
              onResponseCompleted: () => {
                sawResponseCompleted = true;
              },
              onStreamFailed: () => {
                streamFailed = true;
              },
            },
          );
          rawEventCount += counts.raw;
          anthropicEventCount += counts.anth;
          parseFailures += counts.parseFail;
          if (streamFailed) {
            // emitConverted already reported failure + anthropic error
            closeDownstreamAndCancelUpstream(controller);
            return;
          }
          if (sawResponseCompleted) {
            completeFromResponses(controller);
            return;
          }
        }
      };

      const pump = async () => {
        try {
          while (!closed && !cancelled && !terminalSettled) {
            const { done, value } = await reader.read();
            if (cancelled || terminalSettled) {
              clearFirstEventTimer();
              return;
            }
            if (done) {
              clearFirstEventTimer();
              sseBuffer = finalizeStreamUtf8Decoder(utf8Decoder, sseBuffer);
              if (sseBuffer.trim()) {
                const { blocks } = splitSseBlocks(`${sseBuffer}\n\n`);
                processBlocks(blocks);
              }
              if (cancelled || terminalSettled) {
                return;
              }
              if (!streamFailed && !sawResponseCompleted) {
                failFromResponses(controller, `${face} stream ended before response.completed.`, false);
              }
              return;
            }

            if (!firstByteLogged && value) {
              firstByteLogged = true;
              input.onLog(
                `${face} first byte after ${Date.now() - input.startedAt}ms len=${value.byteLength}`,
              );
            }

            sseBuffer = appendStreamUtf8Chunk(utf8Decoder, sseBuffer, value);
            const { blocks, remainder } = splitSseBlocks(sseBuffer);
            sseBuffer = remainder;
            processBlocks(blocks);
          }
        } catch (error) {
          clearFirstEventTimer();
          if (cancelled || closed || terminalSettled) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          input.onLog(`${face} stream pump failed: ${message}`);
          failFromResponses(controller, message, false);
        }
      };

      void pump();
    },
    cancel() {
      cancelled = true;
      closed = true;
      clearFirstEventTimer();
      tryEmitLogicalCancelled(input.lifecycle, {
        reason: "downstream cancelled",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      void reader.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: headersWithLogicalRequestIdentity(input.upstreamHeaders, input.route?.logicalRequestId, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    }),
  });
}

function enqueueAnthropicFromResponsesSse(
  block: string,
  state: ReturnType<typeof newResponsesEventToAnthropicState>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  rawTypes: Record<string, number>,
  usageTracker: AnthropicStreamUsageTracker,
  onResponsesUsage: (usage: ParsedUsage, responseId?: string) => void,
  modelId: string | undefined,
  lifecycle?: RequestLifecycleContext,
  providerRequestId?: string,
  hooks?: {
    onResponseCompleted?: () => void;
    onStreamFailed?: () => void;
  },
): { raw: number; anth: number; parseFail: number } {
  const parsed = parseResponsesStreamEventBlock(block);
  if (!parsed) {
    // Keep prior fallback for non-standard framing.
    const dataLine = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("data:"));
    if (!dataLine) {
      return { raw: 0, anth: 0, parseFail: 0 };
    }
    const payload = dataLine.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") {
      return { raw: 0, anth: 0, parseFail: 0 };
    }
    try {
      const event = JSON.parse(payload) as ResponsesStreamEvent;
      return emitConverted(
        event,
        state,
        controller,
        encoder,
        rawTypes,
        usageTracker,
        onResponsesUsage,
        modelId,
        lifecycle,
        providerRequestId,
        hooks,
      );
    } catch {
      return { raw: 0, anth: 0, parseFail: 1 };
    }
  }
  return emitConverted(
    parsed,
    state,
    controller,
    encoder,
    rawTypes,
    usageTracker,
    onResponsesUsage,
    modelId,
    lifecycle,
    providerRequestId,
    hooks,
  );
}

function emitConverted(
  event: ResponsesStreamEvent,
  state: ReturnType<typeof newResponsesEventToAnthropicState>,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  rawTypes: Record<string, number>,
  usageTracker: AnthropicStreamUsageTracker,
  onResponsesUsage: (usage: ParsedUsage, responseId?: string) => void,
  modelId: string | undefined,
  lifecycle?: RequestLifecycleContext,
  providerRequestId?: string,
  hooks?: {
    onResponseCompleted?: () => void;
    onStreamFailed?: () => void;
  },
): { raw: number; anth: number; parseFail: number } {
  const type = typeof event.type === "string" ? event.type : "unknown";
  rawTypes[type] = (rawTypes[type] ?? 0) + 1;
  lifecycle?.tracker.noteFirstChunk();

  if (type === "response.completed") {
    hooks?.onResponseCompleted?.();
  }

  const fromResponses = extractUsageFromResponsesStreamEvent(event, modelId);
  if (fromResponses) {
    const responseId =
      typeof (event as { response?: { id?: string } }).response?.id === "string"
        ? (event as { response: { id: string } }).response.id
        : undefined;
    onResponsesUsage(fromResponses, responseId);
  }

  // OpenAI Responses stream terminal / error events.
  if (
    type === "error" ||
    type === "response.failed" ||
    type === "response.incomplete" ||
    (event as { error?: unknown }).error
  ) {
    hooks?.onStreamFailed?.();
    const errObj = (event as { error?: { message?: string } | string }).error;
    const responseObj = (event as { response?: { error?: { message?: string } | string } }).response;
    const responseError = responseObj?.error;
    const message =
      type === "response.incomplete"
        ? "Upstream response incomplete"
        : typeof errObj === "string"
          ? errObj
          : typeof errObj?.message === "string"
            ? errObj.message
            : typeof responseError === "string"
              ? responseError
              : typeof responseError?.message === "string"
                ? responseError.message
                : JSON.stringify(event).slice(0, 400);
    reportLogicalUpstreamFailure(lifecycle, {
      stage: "stream",
      error: message,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
    controller.enqueue(
      encoder.encode(
        responsesAnthropicEventToSse({
          type: "error",
          error: { type: "api_error", message },
        } as never),
      ),
    );
    return { raw: 1, anth: 1, parseFail: 0 };
  }

  const anthEvents = responsesEventToAnthropicEvents(event, state);
  for (const anthropicEvent of anthEvents) {
    trackAnthropicStreamUsage(usageTracker, anthropicEvent);
    controller.enqueue(encoder.encode(responsesAnthropicEventToSse(anthropicEvent)));
  }
  return { raw: 1, anth: anthEvents.length, parseFail: 0 };
}

function settleMessagesStreamUsage(
  tracker: AnthropicStreamUsageTracker,
  route: ResolvedProviderRoute,
  onUsage: GatewayUsageObserver,
  onLog: GatewayLogFn,
  fallback?: { usage: ParsedUsage; responseId?: string },
  lifecycle?: RequestLifecycleContext,
): void {
  const outcome = resolveAnthropicStreamUsage(tracker);
  if (outcome.status === "resolved") {
    emitMessagesUsage(onUsage, route, outcome.usage, true, outcome.responseId, onLog, lifecycle);
    return;
  }
  if (fallback?.usage) {
    onLog(
      `messages stream anthropic tracker rejected (${outcome.reason}); using Responses usage fallback ` +
        `provider=${route.provider.id} model=${route.upstreamModelId}`,
    );
    emitMessagesUsage(onUsage, route, fallback.usage, true, fallback.responseId, onLog, lifecycle);
    return;
  }
  onLog(
    `messages stream usage rejected provider=${route.provider.id} model=${route.upstreamModelId} ` +
      `reason=${outcome.reason}; usage will not be billed`,
  );
}

async function postResponsesWithUnsupportedParamRetry(input: {
  fetchImpl: typeof fetch;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  onLog: GatewayLogFn;
  route: ResolvedProviderRoute;
  lifecycle?: RequestLifecycleContext;
  signal?: AbortSignal;
}): Promise<{
  response: Response;
  body: Record<string, unknown>;
  droppedParams: string[];
}> {
  const body = { ...input.body };
  const droppedParams: string[] = [];
  for (let attempt = 0; attempt <= MAX_UNSUPPORTED_PARAM_DROPS; attempt += 1) {
    const payload = JSON.stringify(body);
    input.onLog(
      `messages→responses POST ${input.url} provider=${input.route.provider.id} ` +
        `model=${input.route.upstreamModelId} upstreamStream=${body.stream === true} bytes=${payload.length} attempt=${attempt}`,
    );
    const response = await fetchUpstreamWithRetry({
      fetchImpl: input.fetchImpl,
      url: input.url,
      init: {
        method: "POST",
        headers: input.headers,
        body: payload,
      },
      lifecycle: input.lifecycle,
      onLog: input.onLog,
      signal: input.signal,
      upstreamProxyUrl: input.route.provider.upstreamProxyUrl,
    });
    if (response.ok || response.status < 400 || response.status >= 500) {
      return { response, body, droppedParams };
    }
    // Need body text to detect unsupported params; clone path via text then rebuild Response.
    const text = await response.text();
    const param = extractUnsupportedResponsesParameter(text);
    if (!param || !DROPPABLE_RESPONSES_PARAMS.has(param) || !(param in body)) {
      return {
        response: new Response(text, {
          status: response.status,
          headers: response.headers,
        }),
        body,
        droppedParams,
      };
    }
    delete body[param];
    droppedParams.push(param);
    input.onLog(
      `messages→responses drop unsupported param=${param} attempt=${attempt} provider=${input.route.provider.id}`,
    );
  }
  const payload = JSON.stringify(body);
  const response = await fetchUpstreamWithRetry({
    fetchImpl: input.fetchImpl,
    url: input.url,
    init: {
      method: "POST",
      headers: input.headers,
      body: payload,
    },
    lifecycle: input.lifecycle,
    onLog: input.onLog,
    signal: input.signal,
    upstreamProxyUrl: input.route.provider.upstreamProxyUrl,
  });
  return { response, body, droppedParams };
}

function extractUnsupportedResponsesParameter(raw: string): string | undefined {
  const patterns = [
    /Unsupported parameter:\s*['"`]?([A-Za-z0-9_.-]+)['"`]?/i,
    /Unknown parameter:\s*['"`]?([A-Za-z0-9_.-]+)['"`]?/i,
    /Unrecognized request argument supplied:\s*['"`]?([A-Za-z0-9_.-]+)['"`]?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    const param = match?.[1]?.trim().split(/[.[\]]/, 1)[0];
    if (param) return param;
  }
  return undefined;
}

function anthropicErrorResponse(status: number, message: string, errorCode?: string): Response {
  return Response.json(
    {
      type: "error",
      error: {
        type: "api_error",
        message,
        ...(errorCode ? { code: errorCode } : {}),
      },
    },
    {
      status: status >= 400 && status < 600 ? status : 502,
      ...(errorCode ? { headers: { "x-eco-upstream-error-code": errorCode } } : {}),
    },
  );
}

function anthropicErrorSseResponse(
  status: number,
  message: string,
  options: { preserveHttpStatus?: boolean; errorCode?: string } = {},
): Response {
  // Claude Agent SDK stream path: emit a single error event then close.
  const payload = responsesAnthropicEventToSse({
    type: "error",
    error: { type: "api_error", message: `[${status}] ${message}` },
  } as never);
  return new Response(payload, {
    status: options.preserveHttpStatus ? status : 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      ...(options.errorCode ? { "x-eco-upstream-error-code": options.errorCode } : {}),
    },
  });
}

function anthropicJsonAsSse(
  anthropic: ReturnType<typeof responsesToAnthropic>,
  upstreamHeaders: Headers,
  logicalRequestId?: string,
): Response {
  // Best-effort non-stream→stream wrap: message_start / content / message_stop via re-serialize of final message.
  // Prefer mapping through a synthetic completed response when full JSON is present.
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  const msg = anthropic as {
    id?: string;
    model?: string;
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  chunks.push(
    responsesAnthropicEventToSse({
      type: "message_start",
      message: {
        id: msg.id ?? "msg_synth",
        type: "message",
        role: "assistant",
        content: [],
        model: msg.model ?? "",
        stop_reason: "",
        usage: {
          input_tokens: msg.usage?.input_tokens ?? 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as never),
  );
  let index = 0;
  for (const block of msg.content ?? []) {
    if (block.type === "text" && block.text) {
      chunks.push(
        responsesAnthropicEventToSse({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        } as never),
      );
      chunks.push(
        responsesAnthropicEventToSse({
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        } as never),
      );
      chunks.push(
        responsesAnthropicEventToSse({
          type: "content_block_stop",
          index,
        } as never),
      );
      index += 1;
    }
  }
  chunks.push(
    responsesAnthropicEventToSse({
      type: "message_delta",
      delta: { stop_reason: msg.stop_reason ?? "end_turn" },
      usage: {
        input_tokens: msg.usage?.input_tokens ?? 0,
        output_tokens: msg.usage?.output_tokens ?? 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as never),
  );
  chunks.push(responsesAnthropicEventToSse({ type: "message_stop" } as never));
  return new Response(encoder.encode(chunks.join("")), {
    status: 200,
    headers: headersWithLogicalRequestIdentity(upstreamHeaders, logicalRequestId, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    }),
  });
}

function emitMessagesUsage(
  onUsage: GatewayUsageObserver,
  route: ResolvedProviderRoute,
  usage: NonNullable<ReturnType<typeof normalizeAnthropicUsage>>,
  stream: boolean,
  responseId: string | undefined,
  onLog: GatewayLogFn,
  lifecycle?: RequestLifecycleContext,
): void {
  const event: GatewayUsageEvent = {
    source: "messages",
    sourceEventId: `messages:${route.provider.id}:${responseId ?? Date.now()}`,
    providerId: route.provider.id,
    requestedModel: route.requestedModel,
    upstreamModelId: route.upstreamModelId,
    usage,
    stream,
    observedAt: new Date().toISOString(),
    ...(responseId ? { responseId } : {}),
    ...(route.bridgeBindingId ? { bridgeBindingId: route.bridgeBindingId } : {}),
    ...(route.threadId ? { threadId: route.threadId } : {}),
    ...(route.runAttemptId ? { runAttemptId: route.runAttemptId } : {}),
    ...(route.logicalRequestId?.trim() ? { logicalRequestId: route.logicalRequestId.trim() } : {}),
    ...(stream && lifecycle ? lifecycle.tracker.generationTiming() : {}),
  };
  try {
    void Promise.resolve(onUsage(event)).catch((error) => {
      onLog(`usage observer failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    onLog(`usage observer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
