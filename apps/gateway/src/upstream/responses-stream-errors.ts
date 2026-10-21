import type { GatewayUpstreamErrorInfo } from "../types.js";

/** Emit a Responses-shaped `response.failed` SSE event for mid-stream conversion failures. */
export function responsesFailedSse(message: string, code = "upstream_error"): string {
  const payload = {
    type: "response.failed",
    response: {
      error: {
        code,
        message,
      },
    },
  };
  return `event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Preserve the complete upstream error envelope and the additive error fields Codex relies on. */
export function extractResponsesErrorInfo(
  event: Record<string, unknown>,
  eventType?: string,
): GatewayUpstreamErrorInfo | undefined {
  const directError = event.error;
  const response = isRecord(event.response) ? event.response : undefined;
  const responseError = response && isRecord(response.error) ? response.error : undefined;
  const errorObject =
    isRecord(directError)
      ? directError
      : responseError ??
        (isRecord(response) ? response : undefined);
  const message =
    (typeof directError === "string" ? directError : undefined) ??
    readString(errorObject, "message") ??
    readString(event, "message");
  const code =
    readString(errorObject, "code") ??
    readString(event, "code") ??
    readString(responseError, "code");
  const param =
    readString(errorObject, "param") ??
    readString(event, "param") ??
    readString(responseError, "param");
  const type =
    readString(errorObject, "type") ??
    readString(event, "error_type") ??
    readString(responseError, "type");

  if (!message && !code && !param && !type) {
    return undefined;
  }
  return {
    message: message ?? "Upstream Responses stream failed without an error message.",
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    ...(type ? { type } : {}),
    ...(eventType ? { eventType } : {}),
    rawEvent: event,
  };
}

export function readResponsesResponseId(event: Record<string, unknown>): string | undefined {
  const response = isRecord(event.response) ? event.response : undefined;
  return readString(response, "id") ?? readString(event, "response_id");
}

/** Terminal `response.completed` when upstream stalls after usable streamed items. */
export function responsesCompletedSse(input: {
  responseId: string;
  modelId: string;
  output?: unknown[];
}): string {
  const payload = {
    type: "response.completed",
    response: {
      id: input.responseId,
      object: "response",
      status: "completed",
      model: input.modelId,
      output: input.output ?? [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  };
  return `event: response.completed\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function isResponsesToolOutputItem(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return false;
  }
  const type = (item as { type?: unknown }).type;
  return (
    type === "custom_tool_call" ||
    type === "function_call" ||
    type === "tool_call" ||
    type === "computer_call" ||
    type === "file_search_call" ||
    type === "web_search_call" ||
    type === "code_interpreter_call"
  );
}

export function isIncompleteResponsesCompletedRemainder(remainder: string): boolean {
  const head = remainder.trimStart().slice(0, 120);
  if (head.startsWith("event: response.completed")) {
    return true;
  }
  if (head.startsWith('data: {"type":"response.completed"')) {
    return true;
  }
  return head.startsWith('data: {"sequence_number"') && head.includes("response.completed");
}
