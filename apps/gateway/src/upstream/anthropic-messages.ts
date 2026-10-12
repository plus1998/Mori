import {
  type AnthropicRequest,
  type AnthropicResponse,
  anthropicEventToResponsesEvents,
  anthropicToResponsesResponse,
  buildCodexToolContextFromRequest,
  type CodexToolContext,
  finalizeAnthropicResponsesStream,
  newAnthropicEventToResponsesState,
  type ResponsesRequest,
  responsesEventToSse,
  responsesToAnthropicRequest,
} from "@eco/openai-anthropic-bridge";
import {
  type AnthropicStreamUsageRejectionReason,
  newAnthropicStreamUsageTracker,
  resolveAnthropicStreamUsage,
  trackAnthropicStreamUsage,
} from "../anthropic-stream-usage.js";
import { applyModelOutputLimit } from "../model-output-limit.js";
import { buildUpstreamUrl } from "../provider-router.js";
import {
  type RequestLifecycleContext,
  reportLogicalUpstreamFailure,
  tryEmitLogicalCancelled,
  tryEmitLogicalCompleted,
} from "../request-lifecycle.js";
import type { GatewayLogFn } from "../server.js";
import {
  appendStreamUtf8Chunk,
  createStreamUtf8Decoder,
  finalizeStreamUtf8Decoder,
  parseAnthropicStreamEventBlock,
  splitSseBlocks,
} from "../sse.js";
import { GatewayToolWriteAnnouncer } from "../tool-write-observation.js";
import type {
  GatewayCodexTurnMetadata,
  GatewayToolWriteObserver,
  GatewayUsageEvent,
  GatewayUsageObserver,
  ResolvedProviderRoute,
} from "../types.js";
import { normalizeAnthropicUsage, type ParsedUsage } from "../usage-normalize.js";
import { fetchUpstreamWithRetry } from "./fetch-with-retry.js";
import { headersWithLogicalRequestIdentity, readUpstreamRequestId } from "./request-id-headers.js";
import { responsesFailedSse } from "./responses-stream-errors.js";
import { rectifyThinkingBudget, shouldRectifyThinkingBudget } from "./thinking-budget-rectifier.js";
import {
  isDeepSeekAnthropicUpstream,
  rectifyAnthropicRequest,
  shouldRectifyThinkingSignature,
  stripRedactedThinkingBlocks,
} from "./thinking-rectifier.js";
import { extractUpstreamErrorMessage, upstreamErrorResponse } from "./upstream-error.js";
import { applyUpstreamUserAgent } from "./user-agent.js";

const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicUsageRejectionReason =
  | AnthropicStreamUsageRejectionReason
  | "missing_response_body"
  | "invalid_non_stream_response"
  | "invalid_non_stream_usage";

function buildAnthropicUpstreamHeaders(
  providerApiKey: string,
  clientHeaders: Headers,
  upstreamUserAgent?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": providerApiKey,
    "anthropic-version": clientHeaders.get("anthropic-version") ?? ANTHROPIC_VERSION,
  };
  const beta = clientHeaders.get("anthropic-beta");
  if (beta) {
    headers["anthropic-beta"] = beta;
  }
  const accept = clientHeaders.get("accept");
  if (accept) {
    headers.accept = accept;
  }
  applyUpstreamUserAgent(headers, clientHeaders, upstreamUserAgent);
  return headers;
}

function cloneAnthropicBody(body: AnthropicRequest): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

function asAnthropicRequest(body: Record<string, unknown>): AnthropicRequest {
  return body as unknown as AnthropicRequest;
}

async function postAnthropicWithRetry(
  upstreamUrl: string,
  upstreamHeaders: Record<string, string>,
  body: AnthropicRequest,
  fetchImpl: typeof fetch,
  onLog: GatewayLogFn,
  lifecycle?: RequestLifecycleContext,
): Promise<Response> {
  return fetchUpstreamWithRetry({
    fetchImpl,
    url: upstreamUrl,
    init: {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    },
    lifecycle,
    onLog,
  });
}

/**
 * On signature/budget validation errors, rectify the Anthropic request and retry once
 * (CC thinking_rectifier / thinking_budget_rectifier).
 */
export async function fetchWithThinkingRectifiers(
  route: ResolvedProviderRoute,
  upstreamUrl: string,
  upstreamHeaders: Record<string, string>,
  anthropicBody: AnthropicRequest,
  fetchImpl: typeof fetch,
  onLog: GatewayLogFn,
  lifecycle?: RequestLifecycleContext,
): Promise<Response> {
  const upstreamBodyRecord = cloneAnthropicBody(anthropicBody);
  applyModelOutputLimit(upstreamBodyRecord, route, "max_tokens");
  if (
    isDeepSeekAnthropicUpstream({
      baseUrl: route.provider.baseUrl,
      upstreamModelId: route.upstreamModelId,
    })
  ) {
    const stripped = stripRedactedThinkingBlocks(upstreamBodyRecord);
    if (stripped.removedRedactedThinkingBlocks > 0) {
      onLog(
        `[eco-gateway] deepseek anthropic: stripped ${stripped.removedRedactedThinkingBlocks} redacted_thinking block(s) before upstream`,
      );
    }
  }
  const bodyForUpstream = asAnthropicRequest(upstreamBodyRecord);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await postAnthropicWithRetry(
      upstreamUrl,
      upstreamHeaders,
      bodyForUpstream,
      fetchImpl,
      onLog,
      lifecycle,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog(`upstream fetch failed ${upstreamUrl}: ${message}`);
    reportLogicalUpstreamFailure(lifecycle, { stage: "transport", error: message });
    return Response.json(
      {
        error: {
          message: `Upstream provider ${route.provider.id} · model=${route.upstreamModelId} · url=${upstreamUrl} · ${message}`,
          type: "upstream_error",
          providerId: route.provider.id,
          model: route.upstreamModelId,
          url: upstreamUrl,
        },
      },
      { status: 502 },
    );
  }

  if (upstreamResponse.ok) {
    return upstreamResponse;
  }

  const text = await upstreamResponse.text();
  onLog(`upstream error body: ${text.slice(0, 300)}`);
  const errorMessage = extractUpstreamErrorMessage(text);

  if (shouldRectifyThinkingSignature(errorMessage)) {
    const rectified = cloneAnthropicBody(bodyForUpstream);
    const result = rectifyAnthropicRequest(rectified);
    if (result.applied) {
      onLog(
        `[eco-gateway] [RECT-001] thinking signature rectifier applied, removed ${result.removedThinkingBlocks} thinking, ${result.removedRedactedThinkingBlocks} redacted_thinking, ${result.removedSignatureFields} signature fields`,
      );
      try {
        const retryResponse = await postAnthropicWithRetry(
          upstreamUrl,
          upstreamHeaders,
          asAnthropicRequest(rectified),
          fetchImpl,
          onLog,
          lifecycle,
        );
        if (retryResponse.ok) {
          onLog(`[eco-gateway] [RECT-002] thinking signature rectifier retry succeeded`);
          return retryResponse;
        }
        const retryText = await retryResponse.text();
        onLog(
          `[eco-gateway] [RECT-003] thinking signature rectifier retry still failed: ${retryText.slice(0, 300)}`,
        );
        const providerRequestId = readUpstreamRequestId(retryResponse.headers);
        reportLogicalUpstreamFailure(lifecycle, {
          stage: "http",
          error: extractUpstreamErrorMessage(retryText),
          statusCode: retryResponse.status,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
        return upstreamErrorResponse({
          route,
          upstreamUrl,
          status: retryResponse.status,
          bodyText: retryText,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onLog(`[eco-gateway] [RECT-003] thinking signature rectifier retry still failed: ${message}`);
        reportLogicalUpstreamFailure(lifecycle, { stage: "transport", error: message });
        return Response.json(
          {
            error: {
              message: `Upstream provider ${route.provider.id} · model=${route.upstreamModelId} · url=${upstreamUrl} · ${message}`,
              type: "upstream_error",
              providerId: route.provider.id,
              model: route.upstreamModelId,
              url: upstreamUrl,
            },
          },
          { status: 502 },
        );
      }
    }
    onLog(
      `[eco-gateway] [RECT-006] thinking signature rectifier triggered but nothing to rectify; checking budget`,
    );
  }

  if (shouldRectifyThinkingBudget(errorMessage)) {
    const rectified = cloneAnthropicBody(bodyForUpstream);
    const result = rectifyThinkingBudget(rectified);
    applyModelOutputLimit(rectified, route, "max_tokens");
    if (result.applied) {
      onLog(
        `[eco-gateway] [RECT-010] thinking budget rectifier applied, before=${JSON.stringify(result.before)}, after=${JSON.stringify(result.after)}`,
      );
      try {
        const retryResponse = await postAnthropicWithRetry(
          upstreamUrl,
          upstreamHeaders,
          asAnthropicRequest(rectified),
          fetchImpl,
          onLog,
          lifecycle,
        );
        if (retryResponse.ok) {
          onLog(`[eco-gateway] [RECT-011] thinking budget rectifier retry succeeded`);
          return retryResponse;
        }
        const retryText = await retryResponse.text();
        onLog(
          `[eco-gateway] [RECT-012] thinking budget rectifier retry still failed: ${retryText.slice(0, 300)}`,
        );
        const providerRequestId = readUpstreamRequestId(retryResponse.headers);
        reportLogicalUpstreamFailure(lifecycle, {
          stage: "http",
          error: extractUpstreamErrorMessage(retryText),
          statusCode: retryResponse.status,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
        return upstreamErrorResponse({
          route,
          upstreamUrl,
          status: retryResponse.status,
          bodyText: retryText,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onLog(`[eco-gateway] [RECT-012] thinking budget rectifier retry still failed: ${message}`);
        reportLogicalUpstreamFailure(lifecycle, { stage: "transport", error: message });
        return Response.json(
          {
            error: {
              message: `Upstream provider ${route.provider.id} · model=${route.upstreamModelId} · url=${upstreamUrl} · ${message}`,
              type: "upstream_error",
              providerId: route.provider.id,
              model: route.upstreamModelId,
              url: upstreamUrl,
            },
          },
          { status: 502 },
        );
      }
    }
    onLog(`[eco-gateway] [RECT-014] thinking budget rectifier triggered but nothing to rectify`);
  }

  finalizeRectifierHttpFailure(lifecycle, upstreamResponse, text);
  return upstreamErrorResponse({
    route,
    upstreamUrl,
    status: upstreamResponse.status,
    bodyText: text,
  });
}

function finalizeRectifierHttpFailure(
  lifecycle: RequestLifecycleContext | undefined,
  response: Response,
  bodyText: string,
): void {
  const providerRequestId = readUpstreamRequestId(response.headers);
  reportLogicalUpstreamFailure(lifecycle, {
    stage: "http",
    error: extractUpstreamErrorMessage(bodyText),
    statusCode: response.status,
    ...(providerRequestId ? { providerRequestId } : {}),
  });
}

export async function forwardAnthropicMessages(
  route: ResolvedProviderRoute,
  responsesBody: ResponsesRequest,
  clientHeaders: Headers,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  codexTurnMetadata?: GatewayCodexTurnMetadata,
  upstreamUserAgent?: string,
  lifecycle?: RequestLifecycleContext,
  onToolWriteStarted?: GatewayToolWriteObserver,
): Promise<Response> {
  const toolContext = buildCodexToolContextFromRequest(responsesBody);
  let anthropicBody: AnthropicRequest;
  try {
    anthropicBody = responsesToAnthropicRequest(responsesBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog(`responses → anthropic conversion failed: ${message}`);
    if (lifecycle) {
      reportLogicalUpstreamFailure(lifecycle, { stage: "protocol", error: message });
    }
    return Response.json(
      {
        error: {
          message: `Unable to convert Responses request for Anthropic upstream: ${message}`,
          type: "invalid_request_error",
        },
      },
      { status: 400 },
    );
  }
  anthropicBody.model = route.upstreamModelId;

  return forwardAnthropicMessagesBody(
    route,
    anthropicBody,
    clientHeaders,
    fetchImpl,
    onLog,
    onUsage,
    codexTurnMetadata,
    toolContext,
    upstreamUserAgent,
    lifecycle,
    onToolWriteStarted,
  );
}

/** Forward a pre-built Anthropic Messages body (used by rectifier tests). */
export async function forwardAnthropicMessagesBody(
  route: ResolvedProviderRoute,
  anthropicBody: AnthropicRequest,
  clientHeaders: Headers,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  codexTurnMetadata?: GatewayCodexTurnMetadata,
  toolContext: CodexToolContext = buildCodexToolContextFromRequest(undefined),
  upstreamUserAgent?: string,
  lifecycle?: RequestLifecycleContext,
  onToolWriteStarted?: GatewayToolWriteObserver,
): Promise<Response> {
  const upstreamUrl = buildUpstreamUrl(route.provider, "anthropic-messages");
  const upstreamHeaders = buildAnthropicUpstreamHeaders(
    route.provider.apiKey,
    clientHeaders,
    upstreamUserAgent,
  );
  const payload = JSON.stringify(anthropicBody);
  onLog(
    `upstream POST ${upstreamUrl} provider=${route.provider.id} model=${route.upstreamModelId} bytes=${payload.length}`,
  );

  const upstreamResponse = await fetchWithThinkingRectifiers(
    route,
    upstreamUrl,
    upstreamHeaders,
    anthropicBody,
    fetchImpl,
    onLog,
    lifecycle,
  );

  // Error responses from rectifier path are already formatted.
  if (!upstreamResponse.ok) {
    onLog(`upstream response ${upstreamUrl} status=${upstreamResponse.status}`);
    return upstreamResponse;
  }

  onLog(`upstream response ${upstreamUrl} status=${upstreamResponse.status}`);

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);

  if (!isEventStream) {
    const text = await upstreamResponse.text();
    try {
      const anthropicMessage = JSON.parse(text) as AnthropicResponse;
      const responsesJson = anthropicToResponsesResponse(anthropicMessage, toolContext);
      const responseId = readNonEmptyString(anthropicMessage.id);
      const responseModelId = readNonEmptyString(anthropicMessage.model);
      const usage = responseModelId ? normalizeAnthropicUsage(anthropicMessage.usage, responseModelId) : null;
      if (!usage) {
        logAnthropicUsageRejection(route, false, "invalid_non_stream_usage", onUsage, onLog);
      } else if (!responseId) {
        logAnthropicUsageRejection(route, false, "missing_response_identity", onUsage, onLog);
      } else {
        emitAnthropicGatewayUsage({
          route,
          usage,
          stream: false,
          responseId,
          ...(providerRequestId && { providerRequestId }),
          ...(codexTurnMetadata && { codexTurnMetadata }),
          onUsage,
          onLog,
          ...(lifecycle && { lifecycle }),
        });
      }
      tryEmitLogicalCompleted(lifecycle, providerRequestId);
      return Response.json(responsesJson, {
        status: 200,
        headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
          "content-type": "application/json",
        }),
      });
    } catch {
      logAnthropicUsageRejection(route, false, "invalid_non_stream_response", onUsage, onLog);
      if (lifecycle) {
        reportLogicalUpstreamFailure(lifecycle, {
          stage: "protocol",
          error: "Unable to parse Anthropic upstream response.",
          ...(providerRequestId ? { providerRequestId } : {}),
        });
      }
      return Response.json(
        { error: { message: "Unable to parse Anthropic upstream response." } },
        { status: 502 },
      );
    }
  }

  if (!upstreamResponse.body) {
    logAnthropicUsageRejection(route, true, "missing_response_body", onUsage, onLog);
    reportLogicalUpstreamFailure(lifecycle, {
      stage: "protocol",
      error: "Anthropic upstream returned a successful response without a body.",
      ...(providerRequestId ? { providerRequestId } : {}),
    });
    return upstreamErrorResponse({
      route,
      upstreamUrl,
      status: 502,
      bodyText: "Anthropic upstream returned a successful response without a body.",
    });
  }

  const reader = upstreamResponse.body.getReader();
  let cancelled = false;
  let terminalSettled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const state = newAnthropicEventToResponsesState(toolContext);
      const usageTracker = newAnthropicStreamUsageTracker();
      let sseBuffer = "";
      const utf8Decoder = createStreamUtf8Decoder();
      let usageOutcomeSettled = false;
      let streamFailed = false;
      let sawMessageStop = false;

      const settleUsage = () => {
        if (cancelled || usageOutcomeSettled) {
          return;
        }
        usageOutcomeSettled = true;
        const outcome = resolveAnthropicStreamUsage(usageTracker);
        if (outcome.status === "rejected") {
          logAnthropicUsageRejection(route, true, outcome.reason, onUsage, onLog);
          return;
        }
        emitAnthropicGatewayUsage({
          route,
          usage: outcome.usage,
          stream: true,
          responseId: outcome.responseId,
          ...(providerRequestId && { providerRequestId }),
          ...(codexTurnMetadata && { codexTurnMetadata }),
          onUsage,
          onLog,
          ...(lifecycle && { lifecycle }),
        });
      };

      // Codex's app-server reports a tool only once its arguments are complete, so the write
      // itself is announced from here — the converted stream carries the same
      // `response.output_item.added` the native Responses providers send.
      const toolWriteAnnouncer = new GatewayToolWriteAnnouncer(onToolWriteStarted, codexTurnMetadata, onLog);

      const writeResponsesEvents = (events: ReturnType<typeof anthropicEventToResponsesEvents>) => {
        if (cancelled || terminalSettled) {
          return;
        }
        for (const evt of events) {
          toolWriteAnnouncer.observeEvent(evt);
          controller.enqueue(encoder.encode(responsesEventToSse(evt)));
        }
      };

      const closeDownstreamAndCancelUpstream = () => {
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

      const completeSuccessfully = () => {
        if (terminalSettled || cancelled || streamFailed) {
          return;
        }
        writeResponsesEvents(finalizeAnthropicResponsesStream(state));
        settleUsage();
        tryEmitLogicalCompleted(lifecycle, providerRequestId);
        closeDownstreamAndCancelUpstream();
      };

      const failStream = (message: string) => {
        if (terminalSettled || cancelled) {
          return;
        }
        streamFailed = true;
        settleUsage();
        reportLogicalUpstreamFailure(lifecycle, {
          stage: "stream",
          error: message,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
        try {
          controller.enqueue(encoder.encode(responsesFailedSse(message)));
        } catch {
          // downstream already closed
        }
        closeDownstreamAndCancelUpstream();
      };

      /** @returns true when a terminal frame froze the stream */
      const processAnthropicEvent = (
        anthropicEvent: NonNullable<ReturnType<typeof parseAnthropicStreamEventBlock>>,
      ): boolean => {
        if (terminalSettled || cancelled) {
          return true;
        }
        if (anthropicEvent.type === "error") {
          const errEvent = anthropicEvent as unknown as { error?: { message?: string } };
          const message =
            typeof errEvent.error?.message === "string"
              ? errEvent.error.message
              : "Upstream Anthropic stream error";
          failStream(message);
          return true;
        }
        lifecycle?.tracker.noteFirstChunk();
        if (
          anthropicEvent.type === "content_block_delta" &&
          anthropicEvent.delta &&
          ((anthropicEvent.delta.type === "text_delta" &&
            typeof anthropicEvent.delta.text === "string" &&
            anthropicEvent.delta.text) ||
            (anthropicEvent.delta.type === "thinking_delta" &&
              typeof anthropicEvent.delta.thinking === "string" &&
              anthropicEvent.delta.thinking))
        ) {
          lifecycle?.tracker.noteFirstToken();
        }
        // Freeform custom tools (`apply_patch`) are buffered by the conversion until the block
        // stops, so their arguments never reach the converted events this announcer reads.
        const partialToolJson =
          anthropicEvent.type === "content_block_delta" &&
          anthropicEvent.delta?.type === "input_json_delta" &&
          typeof anthropicEvent.delta.partial_json === "string"
            ? anthropicEvent.delta.partial_json
            : "";
        if (partialToolJson) {
          const itemId = state.currentItemId || undefined;
          const callId = state.currentCallId || undefined;
          const name = state.currentName || undefined;
          toolWriteAnnouncer.pushArguments({
            text: partialToolJson,
            ...(itemId && { itemId }),
            ...(callId && { callId }),
            ...(name && { name }),
          });
        }
        const responsesEvents = anthropicEventToResponsesEvents(anthropicEvent, state);
        trackAnthropicStreamUsage(usageTracker, anthropicEvent);
        writeResponsesEvents(responsesEvents);
        if (anthropicEvent.type === "message_stop") {
          sawMessageStop = true;
          completeSuccessfully();
          return true;
        }
        return false;
      };

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
                const anthropicEvent = parseAnthropicStreamEventBlock(block);
                if (!anthropicEvent) {
                  continue;
                }
                if (processAnthropicEvent(anthropicEvent)) {
                  break;
                }
              }
            }
            if (cancelled || terminalSettled) {
              return;
            }
            if (!streamFailed && !sawMessageStop) {
              failStream("Upstream Anthropic stream ended before message_stop.");
            }
            return;
          }
          if (!value) {
            continue;
          }
          sseBuffer = appendStreamUtf8Chunk(utf8Decoder, sseBuffer, value);
          const { blocks, remainder } = splitSseBlocks(sseBuffer);
          sseBuffer = remainder;
          for (const block of blocks) {
            const anthropicEvent = parseAnthropicStreamEventBlock(block);
            if (!anthropicEvent) {
              continue;
            }
            if (processAnthropicEvent(anthropicEvent)) {
              break;
            }
          }
        }
      } catch (error) {
        if (cancelled || terminalSettled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        failStream(message);
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

  return new Response(stream, {
    status: 200,
    headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    }),
  });
}

function emitAnthropicGatewayUsage(input: {
  route: ResolvedProviderRoute;
  usage: ParsedUsage;
  stream: boolean;
  responseId: string;
  providerRequestId?: string;
  codexTurnMetadata?: GatewayCodexTurnMetadata;
  onUsage: GatewayUsageObserver | undefined;
  onLog: GatewayLogFn;
  lifecycle?: RequestLifecycleContext;
}): void {
  if (!input.onUsage) {
    return;
  }
  const sourceEventId = `anthropic:${input.route.provider.id}:response:${input.responseId}`;
  const event: GatewayUsageEvent = {
    source: "responses",
    sourceEventId,
    providerId: input.route.provider.id,
    requestedModel: input.route.requestedModel,
    upstreamModelId: input.route.upstreamModelId,
    usage: input.usage,
    stream: input.stream,
    observedAt: new Date().toISOString(),
    ...(input.stream && input.lifecycle ? input.lifecycle.tracker.generationTiming() : {}),
    responseId: input.responseId,
    ...(input.providerRequestId && { providerRequestId: input.providerRequestId }),
    ...(input.codexTurnMetadata && { codexTurnMetadata: input.codexTurnMetadata }),
    ...(input.route.bridgeBindingId ? { bridgeBindingId: input.route.bridgeBindingId } : {}),
    ...(input.route.threadId ? { threadId: input.route.threadId } : {}),
    ...(input.route.runAttemptId ? { runAttemptId: input.route.runAttemptId } : {}),
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

function logAnthropicUsageRejection(
  route: ResolvedProviderRoute,
  stream: boolean,
  reason: AnthropicUsageRejectionReason,
  onUsage: GatewayUsageObserver | undefined,
  onLog: GatewayLogFn,
): void {
  if (!onUsage) {
    return;
  }
  onLog(
    `anthropic usage rejected provider=${route.provider.id} model=${route.upstreamModelId} stream=${stream} reason=${reason}; usage will not be billed`,
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
