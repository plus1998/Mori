import type {
  ResponsesError,
  ResponsesOutput,
  ResponsesResponse,
  ResponsesStreamEvent,
} from "@eco/openai-anthropic-bridge";
import { IncrementalSseParser, type ParsedSseFrame, parseResponsesSseFrame } from "../sse.js";
import type { GatewayUpstreamErrorInfo } from "../types.js";
import { extractResponsesErrorInfo, readResponsesResponseId } from "./responses-stream-errors.js";

export class ResponsesStreamError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly errorInfo?: GatewayUpstreamErrorInfo,
    readonly responseId?: string,
  ) {
    super(message);
    this.name = "ResponsesStreamError";
  }
}

/** Collect the terminal response for clients requesting JSON from a streaming upstream. */
export async function collectResponsesStream(
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal; idleTimeoutMs?: number } = {},
): Promise<ResponsesResponse> {
  const reader = body.getReader();
  const parser = new IncrementalSseParser();
  const completedItems = new Map<number, ResponsesOutput>();
  const pendingItems = new Set<number>();
  let sawOutput = false;
  let responseId: string | undefined;

  const readChunk = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(options.signal?.reason ?? new Error("Request aborted"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      timer = setTimeout(
        () =>
          reject(
            new ResponsesStreamError(
              "Timed out waiting for upstream Responses stream",
              "stream_timeout",
              {
                message: "Timed out waiting for upstream Responses stream",
                code: "stream_timeout",
                rawEvent: { reason: "idle_timeout" },
              },
              responseId,
            ),
          ),
        options.idleTimeoutMs ?? 45_000,
      );
    });
    try {
      return await Promise.race([reader.read(), stopped]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  };

  const terminalResponse = (frames: readonly ParsedSseFrame[]): ResponsesResponse | undefined => {
    for (const frame of frames) {
      let event: ResponsesStreamEvent & {
        error?: ResponsesError;
        message?: string;
        code?: string;
      };
      try {
        event = parseResponsesSseFrame(frame) as typeof event;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ResponsesStreamError(
          message,
          "invalid_stream",
          {
            message,
            code: "invalid_stream",
            eventType: frame.event ?? "responses",
            rawEvent: frame.data,
          },
          responseId,
        );
      }
      responseId = readResponsesResponseId(event as unknown as Record<string, unknown>) ?? responseId;
      if (event.type === "response.failed" || event.type === "error") {
        const errorInfo = extractResponsesErrorInfo(
          event as unknown as Record<string, unknown>,
          event.type,
        ) ?? {
          message: "Upstream Responses stream failed without structured error fields.",
          code: "upstream_error",
          eventType: event.type,
          rawEvent: event,
        };
        throw new ResponsesStreamError(
          errorInfo.message,
          errorInfo.code,
          errorInfo,
          responseId,
        );
      }
      if (
        event.type.startsWith("response.output_") ||
        event.type === "response.function_call_arguments.delta"
      ) {
        sawOutput = true;
      }
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        const index = event.output_index;
        if (index === undefined || !Number.isInteger(index) || index < 0 || !event.item?.type) {
          throw new ResponsesStreamError(
            "Invalid output item in upstream Responses stream",
            "invalid_stream",
          );
        }
        if (event.type === "response.output_item.done") {
          completedItems.set(index, event.item);
          pendingItems.delete(index);
        } else {
          pendingItems.add(index);
        }
      }
      if (event.type === "response.incomplete") {
        const errorInfo = extractResponsesErrorInfo(
          event as unknown as Record<string, unknown>,
          event.type,
        ) ?? {
          message: "Upstream Responses stream ended incomplete.",
          code: "response_incomplete",
          eventType: event.type,
          rawEvent: event,
        };
        throw new ResponsesStreamError(
          errorInfo.message,
          errorInfo.code ?? "response_incomplete",
          errorInfo,
          responseId,
        );
      }
      if (event.type === "response.completed") {
        const response = event.response;
        const completedResponseId = response?.id ?? responseId;
        if (!completedResponseId || !Array.isArray(response?.output) || response.status !== "completed") {
          const message = "Invalid response.completed terminal response in upstream Responses stream";
          throw new ResponsesStreamError(
            message,
            "invalid_stream",
            {
              message,
              code: "invalid_stream",
              eventType: event.type,
              rawEvent: event,
            },
            completedResponseId,
          );
        }
        responseId = completedResponseId;
        response.id = completedResponseId;
        if (response.output.length > 0) return response;
        // ChatGPT sends the full items in output_item.done, while the terminal
        // response.output can be empty. Collect those real items in wire order.
        if (pendingItems.size > 0 || (sawOutput && completedItems.size === 0)) {
          throw new ResponsesStreamError(
            "Upstream terminal response is missing completed output items",
            "incomplete_stream",
            {
              message: "Upstream terminal response is missing completed output items",
              code: "incomplete_stream",
              eventType: event.type,
              rawEvent: event,
            },
            responseId,
          );
        }
        const items = [...completedItems.entries()].sort(([a], [b]) => a - b);
        if (items.some(([index], position) => index !== position)) {
          throw new ResponsesStreamError(
            "Upstream terminal response is missing an output item",
            "incomplete_stream",
            {
              message: "Upstream terminal response is missing an output item",
              code: "incomplete_stream",
              eventType: event.type,
              rawEvent: event,
            },
            responseId,
          );
        }
        return { ...response, output: items.map(([, item]) => item) };
      }
    }
    return undefined;
  };

  try {
    options.signal?.throwIfAborted();
    while (true) {
      const { done, value } = await readChunk();
      const frames = done ? parser.finish() : parser.push(value);
      const response = terminalResponse(frames);
      if (response) return response;
      if (done)
        throw new ResponsesStreamError(
          "Upstream Responses stream ended before a terminal response",
          "incomplete_stream",
          {
            message: "Upstream Responses stream ended before a terminal response",
            code: "incomplete_stream",
            rawEvent: { reason: "eof_before_completed" },
          },
          responseId,
        );
    }
  } finally {
    // Stop immediately at the terminal event; upstream need not close its socket.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
