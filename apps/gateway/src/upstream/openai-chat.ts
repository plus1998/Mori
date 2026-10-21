import {
  buildCodexToolContextFromRequest,
  type ChatCompletionsChunk,
  type ChatCompletionsResponse,
  chatCompletionsChunkToResponsesEvents,
  chatCompletionsResponseToResponses,
  chatErrorToResponseError,
  failChatCompletionsResponsesStream,
  finalizeChatCompletionsResponsesStream,
  newChatCompletionsToResponsesStreamState,
  type ResponsesRequest,
  type ResponsesStreamEvent,
  responsesEventToSse,
  responsesToChatCompletionsRequest,
} from "@eco/openai-anthropic-bridge";
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
  splitSseBlocks,
} from "../sse.js";
import type {
  GatewayCodexTurnMetadata,
  GatewayUsageEvent,
  GatewayUsageObserver,
  ResolvedProviderRoute,
} from "../types.js";
import { normalizeChatCompletionsUsage, type ParsedUsage } from "../usage-normalize.js";
import { fetchUpstreamWithRetry } from "./fetch-with-retry.js";
import { headersWithLogicalRequestIdentity, readUpstreamRequestId } from "./request-id-headers.js";
import { formatUpstreamHttpError } from "./upstream-error.js";
import { applyUpstreamUserAgent } from "./user-agent.js";

let chatUsageEventSeq = 0;
const MAX_CHAT_OUTPUT_TOKENS = 64_000;

function buildOpenAIUpstreamHeaders(
  providerApiKey: string,
  clientHeaders: Headers,
  upstreamUserAgent?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${providerApiKey}`,
  };
  const openAiOrg = clientHeaders.get("openai-organization");
  if (openAiOrg) {
    headers["openai-organization"] = openAiOrg;
  }
  const openAiProject = clientHeaders.get("openai-project");
  if (openAiProject) {
    headers["openai-project"] = openAiProject;
  }
  const accept = clientHeaders.get("accept");
  if (accept) {
    headers.accept = accept;
  }
  applyUpstreamUserAgent(headers, clientHeaders, upstreamUserAgent);
  return headers;
}

function parseChatSseBlock(block: string): {
  eventName?: string;
  chunk?: ChatCompletionsChunk & { error?: unknown };
  done?: boolean;
} {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  const data = dataLines.join("\n").trim();
  const withEventName = eventName !== undefined ? { eventName } : {};
  if (!data) {
    return withEventName;
  }
  if (data === "[DONE]") {
    return { ...withEventName, done: true };
  }
  try {
    return {
      ...withEventName,
      chunk: JSON.parse(data) as ChatCompletionsChunk & { error?: unknown },
    };
  } catch {
    return withEventName;
  }
}

export async function forwardOpenAIChat(
  route: ResolvedProviderRoute,
  responsesBody: ResponsesRequest,
  clientHeaders: Headers,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  codexTurnMetadata?: GatewayCodexTurnMetadata,
  upstreamUserAgent?: string,
  lifecycle?: RequestLifecycleContext,
): Promise<Response> {
  const toolContext = buildCodexToolContextFromRequest(responsesBody);
  const chatBody = responsesToChatCompletionsRequest(responsesBody);
  chatBody.model = route.upstreamModelId;
  const requestedMaxOutputTokens =
    responsesBody.max_output_tokens ?? route.provider.modelMaxOutputTokens?.[route.upstreamModelId];
  if (
    typeof requestedMaxOutputTokens === "number" &&
    Number.isFinite(requestedMaxOutputTokens) &&
    requestedMaxOutputTokens > 0
  ) {
    const appliedMaxTokens = route.provider.modelContextTokens
      ? Math.floor(requestedMaxOutputTokens)
      : Math.min(Math.floor(requestedMaxOutputTokens), MAX_CHAT_OUTPUT_TOKENS);
    chatBody.max_tokens = appliedMaxTokens;
    delete chatBody.max_completion_tokens;
    onLog(
      `chat max_tokens provider=${route.provider.id} model=${route.upstreamModelId} requested=${Math.floor(requestedMaxOutputTokens)} applied=${appliedMaxTokens} source=${responsesBody.max_output_tokens !== undefined ? "request" : "model-config"}`,
    );
  } else {
    onLog(
      `chat max_tokens missing provider=${route.provider.id} model=${route.upstreamModelId}; upstream default will apply`,
    );
  }
  if (responsesBody.stream === true) {
    chatBody.stream = true;
    chatBody.stream_options = { include_usage: true };
  }

  const upstreamUrl = buildUpstreamUrl(route.provider, "openai-chat");
  const upstreamHeaders = buildOpenAIUpstreamHeaders(route.provider.apiKey, clientHeaders, upstreamUserAgent);
  const payload = JSON.stringify(chatBody);
  onLog(
    `upstream POST ${upstreamUrl} provider=${route.provider.id} model=${route.upstreamModelId} bytes=${payload.length}`,
  );

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchUpstreamWithRetry({
      fetchImpl,
      url: upstreamUrl,
      init: {
        method: "POST",
        headers: upstreamHeaders,
        body: payload,
      },
      lifecycle,
      onLog,
      httpFailureContext: { route, upstreamUrl },
      ...(route.provider.upstreamProxyUrl ? { upstreamProxyUrl: route.provider.upstreamProxyUrl } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog(`upstream fetch failed ${upstreamUrl}: ${message}`);
    reportLogicalUpstreamFailure(lifecycle, { stage: "transport", error: message });
    return Response.json(
      chatErrorToResponseError(undefined, {
        message: `Upstream provider ${route.provider.id} · model=${route.upstreamModelId} · url=${upstreamUrl} · ${message}`,
        type: "upstream_error",
        providerId: route.provider.id,
        model: route.upstreamModelId,
        url: upstreamUrl,
      }),
      { status: 502 },
    );
  }

  onLog(`upstream response ${upstreamUrl} status=${upstreamResponse.status}`);
  if (!upstreamResponse.ok) {
    const text = await upstreamResponse.text();
    onLog(`upstream error body: ${text.slice(0, 300)}`);
    const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
    reportLogicalUpstreamFailure(lifecycle, {
      stage: "http",
      error: formatUpstreamHttpError({
        route,
        upstreamUrl,
        status: upstreamResponse.status,
        bodyText: text,
      }),
      statusCode: upstreamResponse.status,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
    return openaiChatErrorResponse({
      route,
      upstreamUrl,
      status: upstreamResponse.status,
      bodyText: text,
    });
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);

  if (!isEventStream) {
    const text = await upstreamResponse.text();
    try {
      const chatMessage = JSON.parse(text) as ChatCompletionsResponse;
      const finishReason = chatMessage.choices[0]?.finish_reason;
      onLog(
        `chat response terminal provider=${route.provider.id} model=${route.upstreamModelId} finish_reason=${typeof finishReason === "string" && finishReason ? finishReason : "(missing)"}`,
      );
      observeChatUsage({
        route,
        usage: normalizeChatCompletionsUsage(chatMessage.usage, chatMessage.model || route.upstreamModelId),
        stream: false,
        responseId: chatMessage.id,
        ...(providerRequestId && { providerRequestId }),
        ...(codexTurnMetadata && { codexTurnMetadata }),
        onUsage,
        onLog,
      });
      tryEmitLogicalCompleted(lifecycle, providerRequestId ?? chatMessage.id);
      const responsesJson = chatCompletionsResponseToResponses(
        chatMessage,
        route.upstreamModelId,
        toolContext,
        true,
      );
      return Response.json(responsesJson, {
        status: 200,
        headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
          "content-type": "application/json",
        }),
      });
    } catch {
      reportLogicalUpstreamFailure(lifecycle, {
        stage: "protocol",
        error: "Unable to parse OpenAI Chat Completions upstream response.",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      return Response.json(
        chatErrorToResponseError({
          message: "Unable to parse OpenAI Chat Completions upstream response.",
        }),
        { status: 502 },
      );
    }
  }

  if (!upstreamResponse.body) {
    onLog(
      `upstream response missing body ${upstreamUrl} provider=${route.provider.id} model=${route.upstreamModelId}`,
    );
    reportLogicalUpstreamFailure(lifecycle, {
      stage: "protocol",
      error: `Upstream provider ${route.provider.id} returned a successful response without a body.`,
      ...(providerRequestId ? { providerRequestId } : {}),
    });
    return Response.json(
      chatErrorToResponseError({
        message: `Upstream provider ${route.provider.id} returned a successful response without a body.`,
        type: "upstream_error",
      }),
      { status: 502 },
    );
  }

  const reader = upstreamResponse.body.getReader();
  let cancelled = false;
  let closed = false;
  let upstreamReaderSettled = false;

  const settleUpstreamReader = (action: "cancel" | "release"): void => {
    if (upstreamReaderSettled) {
      return;
    }
    upstreamReaderSettled = true;
    if (action === "cancel") {
      void reader.cancel().catch(() => undefined);
      return;
    }
    try {
      reader.releaseLock();
    } catch {
      // already released or cancelled
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const state = newChatCompletionsToResponsesStreamState(route.upstreamModelId, toolContext, true);
      let sseBuffer = "";
      const utf8Decoder = createStreamUtf8Decoder();
      let streamStarted = false;
      let streamFailed = false;
      let usageEmitted = false;
      let sawDone = false;
      let lastChatResponseId: string | undefined;

      const safeClose = () => {
        if (closed) {
          return;
        }
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed or cancelled
        }
      };

      const writeResponsesEvents = (events: ResponsesStreamEvent[]) => {
        if (cancelled || closed) {
          return;
        }
        if (events.length > 0) {
          streamStarted = true;
        }
        for (const evt of events) {
          if (cancelled || closed) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(responsesEventToSse(evt)));
          } catch {
            closed = true;
            return;
          }
        }
      };

      const processBlock = (block: string): boolean => {
        const parsed = parseChatSseBlock(block);
        if (parsed.done) {
          sawDone = true;
          return true;
        }
        if (parsed.eventName === "error" || parsed.chunk?.error !== undefined) {
          const errorBody = parsed.chunk ?? { error: { message: "Upstream stream error" } };
          const mapped = chatErrorToResponseError(errorBody);
          const err = mapped.error;
          writeResponsesEvents(
            failChatCompletionsResponsesStream(
              state,
              String(err.message ?? "Upstream stream error"),
              typeof err.type === "string" ? err.type : undefined,
            ),
          );
          streamFailed = true;
          reportLogicalUpstreamFailure(lifecycle, {
            stage: "stream",
            error: String(err.message ?? "Upstream stream error"),
            ...(providerRequestId ? { providerRequestId } : {}),
          });
          return true;
        }
        if (!parsed.chunk) {
          return false;
        }
        if (typeof parsed.chunk.id === "string" && parsed.chunk.id.trim()) {
          lastChatResponseId = parsed.chunk.id.trim();
        }
        lifecycle?.tracker.noteFirstChunk();
        const delta = parsed.chunk.choices[0]?.delta;
        if (
          delta &&
          (typeof delta.content === "string" ||
            typeof delta.reasoning_content === "string" ||
            typeof delta.reasoning === "string") &&
          (delta.content ?? delta.reasoning_content ?? delta.reasoning)
        ) {
          lifecycle?.tracker.noteFirstToken();
        }
        if (!usageEmitted && parsed.chunk.usage) {
          const usage = normalizeChatCompletionsUsage(
            parsed.chunk.usage,
            parsed.chunk.model || route.upstreamModelId,
          );
          if (usage) {
            usageEmitted = true;
            observeChatUsage({
              route,
              usage,
              stream: true,
              responseId: parsed.chunk.id,
              ...(providerRequestId && { providerRequestId }),
              ...(codexTurnMetadata && { codexTurnMetadata }),
              onUsage,
              onLog,
              ...(lifecycle && { lifecycle }),
            });
          }
        }
        writeResponsesEvents(chatCompletionsChunkToResponsesEvents(parsed.chunk, state));
        return false;
      };

      const processBlocks = (blocks: readonly string[]): boolean => {
        for (const block of blocks) {
          if (processBlock(block)) {
            return true;
          }
        }
        return false;
      };

      const flushRemainder = () => {
        sseBuffer = finalizeStreamUtf8Decoder(utf8Decoder, sseBuffer);
        if (!sseBuffer.trim()) {
          return;
        }
        const { blocks } = splitSseBlocks(`${sseBuffer}\n\n`);
        processBlocks(blocks);
      };

      const emitTerminalIfOpen = () => {
        if (cancelled || streamFailed) {
          return;
        }
        onLog(
          `chat stream terminal provider=${route.provider.id} model=${route.upstreamModelId} finish_reason=${state.finishReason || "(missing)"} done=${sawDone} tool_calls=${state.toolCalls.size} text_chars=${state.text.length} reasoning_chars=${state.reasoning.length}`,
        );
        if (!sawDone) {
          writeResponsesEvents(
            failChatCompletionsResponsesStream(
              state,
              "Upstream stream ended before the [DONE] terminator.",
              "stream_error",
            ),
          );
          reportLogicalUpstreamFailure(lifecycle, {
            stage: "stream",
            error: "Upstream stream ended before the [DONE] terminator.",
            ...(providerRequestId ? { providerRequestId } : {}),
          });
          streamFailed = true;
          return;
        }
        writeResponsesEvents(finalizeChatCompletionsResponsesStream(state));
        tryEmitLogicalCompleted(lifecycle, providerRequestId ?? lastChatResponseId);
      };

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (cancelled) {
            return;
          }
          if (done) {
            if (!streamFailed) {
              flushRemainder();
            }
            emitTerminalIfOpen();
            safeClose();
            settleUpstreamReader("release");
            return;
          }
          if (!value) {
            continue;
          }
          sseBuffer = appendStreamUtf8Chunk(utf8Decoder, sseBuffer, value);
          const { blocks, remainder } = splitSseBlocks(sseBuffer);
          sseBuffer = remainder;
          if (processBlocks(blocks) && (sawDone || streamFailed)) {
            break;
          }
        }

        if (cancelled) {
          return;
        }
        if (!streamFailed) {
          flushRemainder();
        }
        emitTerminalIfOpen();
        safeClose();
        settleUpstreamReader("cancel");
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        reportLogicalUpstreamFailure(lifecycle, {
          stage: "stream",
          error: `reader failure: ${message}`,
          ...(providerRequestId ? { providerRequestId } : {}),
        });
        if (streamStarted) {
          writeResponsesEvents(
            failChatCompletionsResponsesStream(state, `reader failure: ${message}`, "stream_error"),
          );
        } else if (!closed) {
          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(
                  chatErrorToResponseError(
                    { message },
                    {
                      providerId: route.provider.id,
                      model: route.upstreamModelId,
                      url: upstreamUrl,
                    },
                  ),
                )}\n\n`,
              ),
            );
          } catch {
            closed = true;
          }
        }
        safeClose();
        settleUpstreamReader("release");
      } finally {
        if (!upstreamReaderSettled) {
          settleUpstreamReader(sawDone || streamFailed ? "cancel" : "release");
        }
      }
    },
    cancel() {
      cancelled = true;
      tryEmitLogicalCancelled(lifecycle, {
        reason: "downstream cancel",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      settleUpstreamReader("cancel");
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

function observeChatUsage(input: {
  route: ResolvedProviderRoute;
  usage: ParsedUsage | null;
  stream: boolean;
  responseId?: string;
  providerRequestId?: string;
  codexTurnMetadata?: GatewayCodexTurnMetadata;
  onUsage: GatewayUsageObserver | undefined;
  onLog: GatewayLogFn;
  lifecycle?: RequestLifecycleContext;
}): void {
  if (!input.usage || !input.onUsage) {
    return;
  }
  const sourceEventId = buildChatUsageSourceEventId(input);
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
    ...(input.responseId && { responseId: input.responseId }),
    ...(input.providerRequestId
      ? { providerRequestId: input.providerRequestId }
      : input.responseId
        ? { providerRequestId: input.responseId }
        : {}),
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

function buildChatUsageSourceEventId(input: {
  route: ResolvedProviderRoute;
  responseId?: string;
  providerRequestId?: string;
}): string {
  if (input.responseId) {
    return `chat:${input.route.provider.id}:response:${input.responseId}`;
  }
  if (input.providerRequestId) {
    return `chat:${input.route.provider.id}:request:${input.providerRequestId}`;
  }
  chatUsageEventSeq += 1;
  return ["chat", input.route.provider.id, input.route.requestedModel, Date.now(), chatUsageEventSeq].join(
    ":",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openaiChatErrorResponse(input: {
  route: ResolvedProviderRoute;
  upstreamUrl: string;
  status: number;
  bodyText: string;
}): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    parsed = input.bodyText;
  }
  const body = chatErrorToResponseError(parsed, {
    providerId: input.route.provider.id,
    model: input.route.upstreamModelId,
    url: input.upstreamUrl,
    status: input.status,
  });
  // Prefer standard Responses error fields; keep Eco attribution as extras.
  if (typeof body.error.message === "string" && !body.error.message.includes("Upstream provider")) {
    body.error.message = [
      `Upstream provider ${input.route.provider.id}`,
      `model=${input.route.upstreamModelId}`,
      `url=${input.upstreamUrl}`,
      `status=${input.status}`,
      body.error.message,
    ].join(" · ");
  }
  return Response.json(body, {
    status: input.status >= 400 && input.status < 600 ? input.status : 502,
  });
}
