/**
 * Client face: POST /v1/chat/completions → openai-chat upstream.
 * Body and SSE stay Chat Completions wire format (no Responses/Anthropic disguise).
 */
import type { ChatCompletionsRequest, ChatCompletionsResponse } from "@eco/openai-anthropic-bridge";
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
  parseChatCompletionsChunkBlock,
  splitSseBlocks,
} from "../sse.js";
import type { GatewayUsageEvent, GatewayUsageObserver, ResolvedProviderRoute } from "../types.js";
import { normalizeChatCompletionsUsage, type ParsedUsage } from "../usage-normalize.js";
import { fetchUpstreamWithRetry } from "./fetch-with-retry.js";
import { headersWithLogicalRequestIdentity, readUpstreamRequestId } from "./request-id-headers.js";
import { formatUpstreamHttpError, upstreamErrorResponse } from "./upstream-error.js";
import { applyUpstreamUserAgent } from "./user-agent.js";

let chatCompletionsUsageSeq = 0;

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

export async function forwardOpenAIChatPassthrough(
  route: ResolvedProviderRoute,
  chatBody: ChatCompletionsRequest,
  clientHeaders: Headers,
  fetchImpl: typeof fetch = fetch,
  onLog: GatewayLogFn = () => undefined,
  onUsage?: GatewayUsageObserver,
  upstreamUserAgent?: string,
  lifecycle?: RequestLifecycleContext,
): Promise<Response> {
  if (route.upstreamKind !== "openai-chat") {
    return Response.json(
      {
        error: {
          message:
            `POST /v1/chat/completions requires openai-chat upstream ` +
            `(got ${route.upstreamKind}). Do not disguise Chat as Anthropic/Responses.`,
          type: "unsupported_face",
          providerId: route.provider.id,
          upstreamKind: route.upstreamKind,
        },
      },
      { status: 400 },
    );
  }

  const upstreamBody: ChatCompletionsRequest = {
    ...chatBody,
    model: route.upstreamModelId,
  };
  if (upstreamBody.stream === true && !upstreamBody.stream_options) {
    upstreamBody.stream_options = { include_usage: true };
  }

  const upstreamUrl = buildUpstreamUrl(route.provider, "openai-chat");
  const upstreamHeaders = buildOpenAIUpstreamHeaders(route.provider.apiKey, clientHeaders, upstreamUserAgent);
  const payload = JSON.stringify(upstreamBody);
  onLog(
    `upstream POST ${upstreamUrl} face=chat_completions provider=${route.provider.id} model=${route.upstreamModelId} bytes=${payload.length}`,
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
    });
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
    return upstreamErrorResponse({
      route,
      upstreamUrl,
      status: upstreamResponse.status,
      bodyText: text,
    });
  }

  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
  if (!contentType.includes("text/event-stream") || !upstreamResponse.body) {
    const text = await upstreamResponse.text();
    observeChatJsonUsage({
      route,
      text,
      stream: false,
      ...(providerRequestId ? { providerRequestId } : {}),
      onUsage,
      onLog,
    });
    tryEmitLogicalCompleted(lifecycle, providerRequestId);
    return new Response(text, {
      status: upstreamResponse.status,
      headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
        "content-type": contentType || "application/json",
      }),
    });
  }

  return new Response(
    observeChatSseBody({
      route,
      body: upstreamResponse.body,
      ...(providerRequestId ? { providerRequestId } : {}),
      onUsage,
      onLog,
      ...(lifecycle ? { lifecycle } : {}),
    }),
    {
      status: 200,
      headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      }),
    },
  );
}

function observeChatJsonUsage(input: {
  route: ResolvedProviderRoute;
  text: string;
  stream: boolean;
  providerRequestId?: string;
  onUsage: GatewayUsageObserver | undefined;
  onLog: GatewayLogFn;
}): void {
  if (!input.onUsage) {
    return;
  }
  let parsed: ChatCompletionsResponse;
  try {
    parsed = JSON.parse(input.text) as ChatCompletionsResponse;
  } catch {
    return;
  }
  const usage = normalizeChatCompletionsUsage(parsed.usage, parsed.model || input.route.upstreamModelId);
  if (!usage) {
    return;
  }
  emitChatCompletionsUsage({
    route: input.route,
    usage,
    stream: input.stream,
    ...(typeof parsed.id === "string" ? { responseId: parsed.id } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    onUsage: input.onUsage,
    onLog: input.onLog,
  });
}

function observeChatSseBody(input: {
  route: ResolvedProviderRoute;
  body: ReadableStream<Uint8Array>;
  providerRequestId?: string;
  onUsage: GatewayUsageObserver | undefined;
  onLog: GatewayLogFn;
  lifecycle?: RequestLifecycleContext;
}): ReadableStream<Uint8Array> {
  const utf8Decoder = createStreamUtf8Decoder();
  let sseBuffer = "";
  let usageEmitted = false;
  let sawDone = false;
  let streamFailed = false;
  let terminalSettled = false;
  let lastChatResponseId: string | undefined;
  const providerRequestId = input.providerRequestId;
  const reader = input.body.getReader();
  let cancelled = false;

  const settleTerminal = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    mode: "complete" | "cancel" | "fail",
    error?: string,
  ) => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    if (mode === "complete") {
      tryEmitLogicalCompleted(input.lifecycle, providerRequestId ?? lastChatResponseId);
    } else if (mode === "cancel") {
      tryEmitLogicalCancelled(input.lifecycle, {
        reason: "downstream cancel",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    } else {
      reportLogicalUpstreamFailure(input.lifecycle, {
        stage: "stream",
        error: error ?? "chat stream failed",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    }
    try {
      controller.close();
    } catch {
      // already closed
    }
    void reader.cancel().catch(() => undefined);
  };

  const processBlocks = (blocks: string[]): boolean => {
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed.includes("data: [DONE]")) {
        sawDone = true;
        continue;
      }
      const chunk = parseChatCompletionsChunkBlock(block);
      if (!chunk) {
        continue;
      }
      if (typeof chunk.id === "string" && chunk.id.trim()) {
        lastChatResponseId = chunk.id.trim();
      }
      if (!usageEmitted && chunk.usage && input.onUsage) {
        const usage = normalizeChatCompletionsUsage(chunk.usage, chunk.model || input.route.upstreamModelId);
        if (usage) {
          usageEmitted = true;
          emitChatCompletionsUsage({
            route: input.route,
            usage,
            stream: true,
            ...(typeof chunk.id === "string" ? { responseId: chunk.id } : {}),
            ...(providerRequestId
              ? { providerRequestId }
              : typeof chunk.id === "string"
                ? { providerRequestId: chunk.id }
                : {}),
            onUsage: input.onUsage,
            onLog: input.onLog,
          });
        }
      }
      if (isRecord(chunk) && chunk.error) {
        streamFailed = true;
        return true;
      }
    }
    return false;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async () => {
        try {
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (cancelled) {
              return;
            }
            if (done) {
              const rem = finalizeStreamUtf8Decoder(utf8Decoder, sseBuffer);
              if (rem.trim()) {
                // Final flush: force a block boundary so trailing `data: [DONE]` is observed.
                const { blocks } = splitSseBlocks(`${rem}\n\n`);
                processBlocks(blocks);
              }
              if (!sawDone && !streamFailed) {
                streamFailed = true;
                settleTerminal(controller, "fail", "Upstream stream ended before the [DONE] terminator.");
                return;
              }
              settleTerminal(controller, streamFailed ? "fail" : "complete");
              return;
            }
            if (!value) {
              continue;
            }
            // Original bytes passthrough — observe usage from a parallel decode buffer.
            controller.enqueue(value);
            sseBuffer = appendStreamUtf8Chunk(utf8Decoder, sseBuffer, value);
            const { blocks, remainder } = splitSseBlocks(sseBuffer);
            sseBuffer = remainder;
            if (processBlocks(blocks) && streamFailed) {
              settleTerminal(controller, "fail", "Upstream chat stream reported error");
              return;
            }
            if (sawDone) {
              settleTerminal(controller, "complete");
              return;
            }
          }
        } catch (error) {
          if (cancelled) {
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          settleTerminal(controller, "fail", `reader failure: ${message}`);
        }
      };
      void pump();
    },
    cancel() {
      cancelled = true;
      tryEmitLogicalCancelled(input.lifecycle, {
        reason: "downstream cancel",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      void reader.cancel().catch(() => undefined);
    },
  });
}

function emitChatCompletionsUsage(input: {
  route: ResolvedProviderRoute;
  usage: ParsedUsage;
  stream: boolean;
  responseId?: string;
  providerRequestId?: string;
  onUsage: GatewayUsageObserver;
  onLog: GatewayLogFn;
}): void {
  chatCompletionsUsageSeq += 1;
  const sourceEventId = input.responseId
    ? `chat_completions:${input.route.provider.id}:response:${input.responseId}`
    : input.providerRequestId
      ? `chat_completions:${input.route.provider.id}:req:${input.providerRequestId}`
      : `chat_completions:${input.route.provider.id}:seq:${chatCompletionsUsageSeq}`;
  const event: GatewayUsageEvent = {
    source: "chat_completions",
    sourceEventId,
    providerId: input.route.provider.id,
    requestedModel: input.route.requestedModel,
    upstreamModelId: input.route.upstreamModelId,
    usage: input.usage,
    stream: input.stream,
    observedAt: new Date().toISOString(),
    ...(input.responseId ? { responseId: input.responseId } : {}),
    ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
    ...(input.route.bridgeBindingId ? { bridgeBindingId: input.route.bridgeBindingId } : {}),
    ...(input.route.threadId ? { threadId: input.route.threadId } : {}),
    ...(input.route.runAttemptId ? { runAttemptId: input.route.runAttemptId } : {}),
    ...(input.route.logicalRequestId?.trim()
      ? { logicalRequestId: input.route.logicalRequestId.trim() }
      : {}),
  };
  try {
    void Promise.resolve(input.onUsage(event)).catch((error) => {
      input.onLog(`usage observer failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    input.onLog(`usage observer failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
