import type { ResponsesRequest, ResponsesUsage } from "@eco/openai-anthropic-bridge";
import { buildUpstreamUrl } from "../provider-router.js";
import {
  type RequestLifecycleContext,
  reportLogicalUpstreamFailure,
  tryEmitLogicalCancelled,
  tryEmitLogicalCompleted,
} from "../request-lifecycle.js";
import type { GatewayLogFn } from "../server.js";
import { parseResponsesStreamEventBlock, splitSseBlocks } from "../sse.js";
import { GatewayToolWriteAnnouncer } from "../tool-write-observation.js";
import type {
  GatewayCodexTurnMetadata,
  GatewayToolWriteObserver,
  GatewayUsageEvent,
  GatewayUsageObserver,
  ResolvedProviderRoute,
} from "../types.js";
import {
  extractUsageFromResponsesStreamEvent,
  normalizeResponsesUsage,
  type ParsedUsage,
} from "../usage-normalize.js";
import { fetchUpstreamWithRetry } from "./fetch-with-retry.js";
import { headersWithLogicalRequestIdentity, readUpstreamRequestId } from "./request-id-headers.js";
import {
  isResponsesToolOutputItem,
  responsesCompletedSse,
  responsesFailedSse,
} from "./responses-stream-errors.js";
import { upstreamErrorResponse } from "./upstream-error.js";
import { applyUpstreamUserAgent } from "./user-agent.js";

let usageEventSeq = 0;

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
  applyUpstreamUserAgent(headers, clientHeaders, upstreamUserAgent);
  return headers;
}

/**
 * DeepSeek Responses (and compatible gateways) accept only custom tool
 * `apply_patch`; other custom names (notably Codex freeform `exec`) return 400.
 * function/web_search pass; unknown tool types are ignored by DeepSeek.
 */
export function isDeepSeekResponsesUpstreamModel(modelId: string): boolean {
  const id = modelId.trim();
  return /\bdeepseek\b/i.test(id) || /^deepseek/i.test(id);
}

export function sanitizeDeepSeekResponsesCustomTools(
  body: ResponsesRequest,
  upstreamModelId: string,
): ResponsesRequest {
  if (!isDeepSeekResponsesUpstreamModel(upstreamModelId)) {
    return body;
  }
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return body;
  }
  const filtered = tools.filter((tool) => {
    if (!tool || typeof tool !== "object") {
      return true;
    }
    if (tool.type !== "custom") {
      return true;
    }
    return tool.name === "apply_patch";
  });
  if (filtered.length === tools.length) {
    return body;
  }
  return { ...body, tools: filtered as ResponsesRequest["tools"] };
}

/**
 * LongCat's native Responses endpoint accepts the standard `message` input
 * item but rejects Codex's multi-agent-only `agent_message` item.  Codex emits
 * the latter for a child-agent handoff. Plain-text handoffs are representable
 * as a user message. If Codex attaches opaque encrypted content, the complete
 * item is left untouched so we fail closed instead of changing its meaning.
 */
export function sanitizeLongCatResponsesAgentMessages(
  body: ResponsesRequest,
  providerBaseUrl: string,
): { body: ResponsesRequest; converted: number; encrypted: number } {
  if (!isLongCatResponsesProvider(providerBaseUrl) || !Array.isArray(body.input)) {
    return { body, converted: 0, encrypted: 0 };
  }
  let converted = 0;
  let encrypted = 0;
  const input = body.input.map((item) => {
    if (!isRecord(item) || item.type !== "agent_message") {
      return item;
    }
    if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
      encrypted += 1;
      return item;
    }
    const content = item.content;
    if (!Array.isArray(content) || content.length === 0) {
      return item;
    }
    if (content.some((part) => isRecord(part) && part.type === "encrypted_content")) {
      encrypted += 1;
      return item;
    }
    converted += 1;
    return {
      type: "message",
      role: "user",
      content,
    };
  });
  return converted > 0 ? { body: { ...body, input }, converted, encrypted } : { body, converted, encrypted };
}

function isLongCatResponsesProvider(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.longcat.chat" || host.endsWith(".longcat.chat");
  } catch {
    return false;
  }
}

/** Official OpenAI hosts need `include: reasoning.encrypted_content`; third parties often stall on it. */
export function isOfficialOpenAIResponsesBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".openai.com");
  } catch {
    return false;
  }
}

/** Drop soft-fail Responses fields that third-party gateways often accept then hang on mid-SSE. */
export function sanitizeThirdPartyResponsesSoftFailFields(
  body: ResponsesRequest,
  providerBaseUrl: string,
): { body: ResponsesRequest; dropped: string[] } {
  if (isOfficialOpenAIResponsesBaseUrl(providerBaseUrl)) {
    return { body, dropped: [] };
  }
  const rec = { ...(body as unknown as Record<string, unknown>) };
  const dropped: string[] = [];
  if ("include" in rec) {
    delete rec.include;
    dropped.push("include");
  }
  if (rec.text && typeof rec.text === "object") {
    const text = { ...(rec.text as Record<string, unknown>) };
    if (text.format === undefined && text.verbosity !== undefined) {
      delete text.verbosity;
      dropped.push("text.verbosity");
      if (Object.keys(text).length === 0) {
        delete rec.text;
      } else {
        rec.text = text;
      }
    }
  }
  return { body: rec as unknown as ResponsesRequest, dropped };
}

/** Pass Responses request body to an upstream that already speaks Responses API. */
export async function forwardResponsesPassthrough(
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
  const deepSeekSanitized = sanitizeDeepSeekResponsesCustomTools(responsesBody, route.upstreamModelId);
  const longCatSanitized = sanitizeLongCatResponsesAgentMessages(deepSeekSanitized, route.provider.baseUrl);
  if (longCatSanitized.converted > 0) {
    onLog(
      `responses LongCat agent_message sanitize provider=${route.provider.id} ` +
        `converted=${longCatSanitized.converted} encrypted=${longCatSanitized.encrypted}`,
    );
  }
  if (longCatSanitized.encrypted > 0) {
    onLog(
      `responses LongCat encrypted agent_message remains unsupported ` +
        `provider=${route.provider.id} encrypted=${longCatSanitized.encrypted}`,
    );
  }
  const softFail = sanitizeThirdPartyResponsesSoftFailFields(longCatSanitized.body, route.provider.baseUrl);
  if (softFail.dropped.length > 0) {
    onLog(`responses soft-fail sanitize provider=${route.provider.id} dropped=${softFail.dropped.join(",")}`);
  }
  const upstreamBody: ResponsesRequest = {
    ...softFail.body,
    model: route.upstreamModelId,
  };

  const upstreamUrl = buildUpstreamUrl(route.provider, route.upstreamKind);
  const upstreamHeaders = buildOpenAIUpstreamHeaders(route.provider.apiKey, clientHeaders, upstreamUserAgent);
  const payload = JSON.stringify(upstreamBody);
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
      ...(route.provider.upstreamProxyUrl ? { upstreamProxyUrl: route.provider.upstreamProxyUrl } : {}),
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
      error: `Upstream returned HTTP ${upstreamResponse.status}`,
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
  const isEventStream =
    contentType.includes("text/event-stream") ||
    (route.provider.authMethod === "chatgpt_subscription" && upstreamBody.stream === true);
  const providerRequestId = readUpstreamRequestId(upstreamResponse.headers);
  if (!isEventStream || !upstreamResponse.body) {
    const text = await upstreamResponse.text();
    const parsedJsonUsage = parseResponsesJsonUsage(text, route.upstreamModelId);
    observeResponsesJsonUsage({
      route,
      text,
      stream: false,
      ...(providerRequestId && { providerRequestId }),
      ...(codexTurnMetadata && { codexTurnMetadata }),
      onUsage,
      onLog,
    });
    tryEmitLogicalCompleted(lifecycle, providerRequestId ?? parsedJsonUsage?.responseId);
    return new Response(text, {
      status: 200,
      headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
        "content-type": contentType || "application/json",
      }),
    });
  }

  const observedBody = observeResponsesSseBody({
    route,
    body: upstreamResponse.body,
    onUsage,
    onLog,
    ...(providerRequestId && { providerRequestId }),
    ...(codexTurnMetadata && { codexTurnMetadata }),
    ...(lifecycle && { lifecycle }),
    ...(onToolWriteStarted && { onToolWriteStarted }),
  });

  return new Response(observedBody, {
    status: 200,
    headers: headersWithLogicalRequestIdentity(upstreamResponse.headers, route.logicalRequestId, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    }),
  });
}

function observeResponsesJsonUsage(input: {
  route: ResolvedProviderRoute;
  text: string;
  stream: boolean;
  providerRequestId?: string;
  codexTurnMetadata?: GatewayCodexTurnMetadata;
  onUsage: GatewayUsageObserver | undefined;
  onLog: GatewayLogFn;
}): void {
  if (!input.onUsage) {
    return;
  }
  const parsed = parseResponsesJsonUsage(input.text, input.route.upstreamModelId);
  if (!parsed?.usage) {
    return;
  }
  emitGatewayUsage({
    route: input.route,
    usage: parsed.usage,
    stream: input.stream,
    ...(parsed.responseId && { responseId: parsed.responseId }),
    ...(input.providerRequestId && { providerRequestId: input.providerRequestId }),
    ...(input.codexTurnMetadata && { codexTurnMetadata: input.codexTurnMetadata }),
    onUsage: input.onUsage,
    onLog: input.onLog,
  });
}

function parseResponsesJsonUsage(
  text: string,
  fallbackModelId: string,
): { usage: ParsedUsage; responseId?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const response = isRecord(parsed) && isRecord(parsed.response) ? parsed.response : parsed;
  if (!isRecord(response) || !isRecord(response.usage)) {
    return null;
  }
  const modelId = readString(response, "model") ?? fallbackModelId;
  const usage = normalizeResponsesUsage(response.usage as unknown as ResponsesUsage, modelId);
  if (!usage) {
    return null;
  }
  const responseId = readString(response, "id");
  return {
    usage,
    ...(responseId && { responseId }),
  };
}

function observeResponsesSseBody(input: {
  route: ResolvedProviderRoute;
  body: ReadableStream<Uint8Array>;
  providerRequestId?: string;
  codexTurnMetadata?: GatewayCodexTurnMetadata;
  onUsage: GatewayUsageObserver | undefined;
  onLog: GatewayLogFn;
  onToolWriteStarted?: GatewayToolWriteObserver;
  lifecycle?: RequestLifecycleContext;
}): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let usageEmitted = false;
  let streamFailed = false;
  let sawResponseCompleted = false;
  let sawToolOutputItemDone = false;
  const collectedOutputItems: unknown[] = [];
  let terminalSettled = false;
  const providerRequestId = input.providerRequestId;
  const reader = input.body.getReader();
  let cancelled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const POST_TOOL_STALL_MS = 120;

  const clearStallTimer = () => {
    if (stallTimer !== undefined) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };

  const closeDownstreamAndCancelUpstream = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (terminalSettled) {
      return;
    }
    terminalSettled = true;
    clearStallTimer();
    try {
      controller.close();
    } catch {
      // already closed
    }
    void reader.cancel().catch(() => undefined);
  };

  const failureMessageFromEvent = (event: Record<string, unknown>, type: string): string => {
    const errObj = event.error as { message?: string } | string | undefined;
    const responseObj = event.response as { error?: { message?: string } | string } | undefined;
    const responseError = responseObj?.error;
    return type === "response.incomplete"
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
  };

  const synthesizeCompletedAndClose = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    reason: string,
  ): boolean => {
    if (terminalSettled || cancelled || sawResponseCompleted) {
      return false;
    }
    clearStallTimer();
    const responseId = providerRequestId ?? `resp_synth_${Date.now()}`;
    input.onLog(
      `responses synthesizing completed provider=${input.route.provider.id} ` +
        `outputs=${collectedOutputItems.length} reason=${reason}`,
    );
    buffer = "";
    try {
      const sse = responsesCompletedSse({
        responseId,
        modelId: input.route.upstreamModelId,
        output: collectedOutputItems,
      });
      controller.enqueue(encoder.encode(sse));
      observeEnqueuedBlock(sse.trim(), controller);
      return true;
    } catch {
      closeDownstreamAndCancelUpstream(controller);
      return false;
    }
  };

  const armPostToolStall = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (!sawToolOutputItemDone || buffer.length === 0 || stallTimer !== undefined) {
      return;
    }
    if (cancelled || terminalSettled || sawResponseCompleted) {
      return;
    }
    stallTimer = setTimeout(() => {
      synthesizeCompletedAndClose(controller, "post-tool stall on incomplete SSE remainder");
    }, POST_TOOL_STALL_MS);
  };

  const toolWriteAnnouncer = new GatewayToolWriteAnnouncer(
    input.onToolWriteStarted,
    input.codexTurnMetadata,
    input.onLog,
  );

  /** Observe one SSE block after it has been enqueued. Returns true when terminal froze the stream. */
  const observeEnqueuedBlock = (
    block: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): boolean => {
    if (terminalSettled || cancelled) {
      return true;
    }
    const event = parseResponsesStreamEventBlock(block);
    if (!event) {
      return false;
    }
    const type = typeof event.type === "string" ? event.type : "unknown";

    toolWriteAnnouncer.observeEvent(event);

    if (
      type === "error" ||
      type === "response.failed" ||
      type === "response.incomplete" ||
      (event as { error?: unknown }).error
    ) {
      streamFailed = true;
      reportLogicalUpstreamFailure(input.lifecycle, {
        stage: "stream",
        error: failureMessageFromEvent(event as unknown as Record<string, unknown>, type),
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      closeDownstreamAndCancelUpstream(controller);
      return true;
    }

    input.lifecycle?.tracker.noteFirstChunk();
    if (type === "response.reasoning_text.delta" || type === "response.output_text.delta") {
      input.lifecycle?.tracker.noteFirstToken();
    }

    if (type === "response.output_item.done") {
      const item = (event as { item?: unknown }).item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        collectedOutputItems.push(item);
        if (isResponsesToolOutputItem(item)) {
          sawToolOutputItemDone = true;
        }
      }
    }

    if (type === "response.completed") {
      sawResponseCompleted = true;
      const response = isRecord(event.response) ? event.response : undefined;
      const responseId = response ? readString(response, "id") : undefined;
      if (!usageEmitted && input.onUsage) {
        const usage = extractUsageFromResponsesStreamEvent(event, input.route.upstreamModelId);
        if (usage) {
          usageEmitted = true;
          emitGatewayUsage({
            route: input.route,
            usage,
            stream: true,
            ...(responseId && { responseId }),
            ...(providerRequestId && { providerRequestId }),
            ...(input.codexTurnMetadata && { codexTurnMetadata: input.codexTurnMetadata }),
            onUsage: input.onUsage,
            onLog: input.onLog,
            ...(input.lifecycle && { lifecycle: input.lifecycle }),
          });
        }
      }
      tryEmitLogicalCompleted(input.lifecycle, providerRequestId ?? responseId);
      closeDownstreamAndCancelUpstream(controller);
      return true;
    }

    if (!usageEmitted && input.onUsage) {
      const usage = extractUsageFromResponsesStreamEvent(event, input.route.upstreamModelId);
      if (usage) {
        usageEmitted = true;
        const response = isRecord(event.response) ? event.response : undefined;
        const responseId = response ? readString(response, "id") : undefined;
        emitGatewayUsage({
          route: input.route,
          usage,
          stream: true,
          ...(responseId && { responseId }),
          ...(providerRequestId && { providerRequestId }),
          ...(input.codexTurnMetadata && { codexTurnMetadata: input.codexTurnMetadata }),
          onUsage: input.onUsage,
          onLog: input.onLog,
          ...(input.lifecycle && { lifecycle: input.lifecycle }),
        });
      }
    }
    return false;
  };

  const enqueueSseBlock = (controller: ReadableStreamDefaultController<Uint8Array>, block: string) => {
    const framed = block.endsWith("\n\n") ? block : `${block}\n\n`;
    controller.enqueue(encoder.encode(framed));
  };

  const processBlocks = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    blocks: readonly string[],
  ): boolean => {
    for (const block of blocks) {
      if (terminalSettled || cancelled) {
        return true;
      }
      enqueueSseBlock(controller, block);
      if (observeEnqueuedBlock(block, controller)) {
        return true;
      }
    }
    return false;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Eager pump (not pull): keep draining while the first SSE event is still incomplete.
      // pull()-only can stop reading when nothing has been enqueued yet.
      const pump = async () => {
        try {
          while (!cancelled && !terminalSettled) {
            const { done, value } = await reader.read();
            if (cancelled || terminalSettled) {
              return;
            }
            if (done) {
              clearStallTimer();
              buffer += decoder.decode();
              if (buffer.trim()) {
                const { blocks } = splitSseBlocks(`${buffer}\n\n`);
                if (processBlocks(controller, blocks)) {
                  return;
                }
              }
              if (cancelled || terminalSettled) {
                return;
              }
              if (!streamFailed && !sawResponseCompleted) {
                if (collectedOutputItems.length > 0) {
                  synthesizeCompletedAndClose(controller, "upstream ended without response.completed");
                  return;
                }
                streamFailed = true;
                const message = "Upstream Responses stream ended before response.completed.";
                reportLogicalUpstreamFailure(input.lifecycle, {
                  stage: "stream",
                  error: message,
                  ...(providerRequestId ? { providerRequestId } : {}),
                });
                try {
                  controller.enqueue(encoder.encode(responsesFailedSse(message)));
                } catch {
                  // downstream already closed
                }
              }
              closeDownstreamAndCancelUpstream(controller);
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const { blocks, remainder } = splitSseBlocks(buffer);
            buffer = remainder;
            if (processBlocks(controller, blocks)) {
              return;
            }
            if (blocks.length > 0) {
              clearStallTimer();
            }
            armPostToolStall(controller);
          }
        } catch (error) {
          if (cancelled || terminalSettled) {
            return;
          }
          if (sawToolOutputItemDone && !sawResponseCompleted && !streamFailed) {
            if (synthesizeCompletedAndClose(controller, "reader abort after tool output")) {
              return;
            }
          }
          clearStallTimer();
          const message = error instanceof Error ? error.message : String(error);
          reportLogicalUpstreamFailure(input.lifecycle, {
            stage: "stream",
            error: `reader failure: ${message}`,
            ...(providerRequestId ? { providerRequestId } : {}),
          });
          try {
            controller.error(error);
          } catch {
            // already closed
          }
        }
      };
      void pump();
    },
    cancel() {
      cancelled = true;
      clearStallTimer();
      tryEmitLogicalCancelled(input.lifecycle, {
        reason: "downstream cancel",
        ...(providerRequestId ? { providerRequestId } : {}),
      });
      reader.cancel().catch(() => {});
    },
  });
}

function emitGatewayUsage(input: {
  route: ResolvedProviderRoute;
  usage: ParsedUsage;
  stream: boolean;
  responseId?: string;
  providerRequestId?: string;
  codexTurnMetadata?: GatewayCodexTurnMetadata;
  onUsage: GatewayUsageObserver;
  onLog: GatewayLogFn;
  lifecycle?: RequestLifecycleContext;
}): void {
  const sourceEventId = buildGatewayUsageSourceEventId(input);
  const resolvedProviderRequestId = input.providerRequestId ?? input.responseId;
  if (input.lifecycle) {
    tryEmitLogicalCompleted(input.lifecycle, resolvedProviderRequestId);
  }
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
    ...(resolvedProviderRequestId ? { providerRequestId: resolvedProviderRequestId } : {}),
    ...(input.codexTurnMetadata && { codexTurnMetadata: input.codexTurnMetadata }),
    ...(input.route.bridgeBindingId ? { bridgeBindingId: input.route.bridgeBindingId } : {}),
    ...(input.route.threadId ? { threadId: input.route.threadId } : {}),
    ...(input.route.runAttemptId ? { runAttemptId: input.route.runAttemptId } : {}),
    ...(input.route.logicalRequestId?.trim()
      ? { logicalRequestId: input.route.logicalRequestId.trim() }
      : input.codexTurnMetadata?.turnId?.trim()
        ? { logicalRequestId: input.codexTurnMetadata.turnId.trim() }
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

function buildGatewayUsageSourceEventId(input: {
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
  usageEventSeq += 1;
  return ["responses", input.route.provider.id, input.route.requestedModel, Date.now(), usageEventSeq].join(
    ":",
  );
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Collect Responses SSE events from a stream (test helper). */
export async function collectResponsesSseEvents(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  let buffer = "";
  const events: string[] = [];

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const { blocks, remainder } = splitSseBlocks(buffer);
    buffer = remainder;
    for (const block of blocks) {
      const evt = parseResponsesStreamEventBlock(block);
      if (evt?.type) {
        events.push(evt.type);
      }
    }
  }

  if (buffer.trim()) {
    const { blocks } = splitSseBlocks(`${buffer}\n\n`);
    for (const block of blocks) {
      const evt = parseResponsesStreamEventBlock(block);
      if (evt?.type) {
        events.push(evt.type);
      }
    }
  }

  return events;
}
