import {
  hasCodexIntegerToolArguments,
  newResponsesToolArgumentStreamState,
  normalizeResponsesStreamToolArguments,
  normalizeResponsesToolArguments,
  type ResponsesResponse,
  type ResponsesStreamEvent,
} from "@eco/openai-anthropic-bridge";
import { parseResponsesStreamEventBlock, splitSseBlocks } from "./sse.js";
import {
  fixupEcoMcpHubResponsesPayload,
  fixupEcoMcpHubStreamEvent,
} from "./eco-mcp-hub-fixup.js";

const TOOL_ARGUMENT_FAILURE_LIMIT = 3;
const TOOL_ARGUMENT_FAILURE_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED_TURNS = 512;
const ARGUMENT_PARSE_FAILURE =
  /^failed to parse function arguments:\s*invalid type:\s*floating point\s+`[^`]+`,\s*expected\s+[A-Za-z0-9_]+/i;

interface FailureState {
  signature: string;
  count: number;
  updatedAt: number;
}

export interface ToolArgumentFailureObservation {
  signature: string;
  count: number;
  tripped: boolean;
}

/** Stops deterministic Codex tool argument parse loops before another model request. */
export class CodexToolArgumentFailureCircuitBreaker {
  private readonly failuresByTurn = new Map<string, FailureState>();

  observe(input: {
    threadId?: string;
    turnId?: string;
    responsesInput: unknown;
    now?: number;
  }): ToolArgumentFailureObservation | undefined {
    const threadId = input.threadId?.trim();
    const turnId = input.turnId?.trim();
    if (!threadId || !turnId) {
      return undefined;
    }
    const key = `${threadId}\u0000${turnId}`;
    const now = input.now ?? Date.now();
    this.prune(now);

    const signature = latestFunctionCallOutput(input.responsesInput);
    if (!signature || !ARGUMENT_PARSE_FAILURE.test(signature)) {
      this.failuresByTurn.delete(key);
      return undefined;
    }

    const previous = this.failuresByTurn.get(key);
    const count = previous?.signature === signature ? previous.count + 1 : 1;
    this.failuresByTurn.set(key, { signature, count, updatedAt: now });
    return { signature, count, tripped: count >= TOOL_ARGUMENT_FAILURE_LIMIT };
  }

  clear(): void {
    this.failuresByTurn.clear();
  }

  private prune(now: number): void {
    for (const [key, state] of this.failuresByTurn) {
      if (now - state.updatedAt > TOOL_ARGUMENT_FAILURE_TTL_MS) {
        this.failuresByTurn.delete(key);
      }
    }
    while (this.failuresByTurn.size >= MAX_TRACKED_TURNS) {
      const oldest = this.failuresByTurn.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.failuresByTurn.delete(oldest);
    }
  }
}

export const codexToolArgumentFailureCircuitBreaker = new CodexToolArgumentFailureCircuitBreaker();

export function toolArgumentCircuitBreakResponse(stream: boolean, count: number): Response {
  const message =
    `Codex tool arguments failed integer deserialization ${count} times in the same turn; ` +
    "Mori stopped the retry loop before another upstream model request.";
  const error = { code: "tool_argument_parse_loop", message };
  if (stream) {
    return new Response(
      `event: response.failed\ndata: ${JSON.stringify({
        type: "response.failed",
        response: { status: "failed", error },
      })}\n\n`,
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      },
    );
  }
  return Response.json({ error: { ...error, type: "invalid_tool_arguments" } }, { status: 422 });
}

/** Normalize every successful Responses API output path, including native passthrough. */
export async function normalizeResponsesToolArgumentResponse(
  response: Response,
  hubNamespace?: string,
): Promise<Response> {
  if (!response.ok) {
    return response;
  }
  const namespace = hubNamespace?.trim() || undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    return recreateResponse(response, normalizeResponsesSse(response.body, namespace));
  }
  if (!contentType.includes("json")) {
    return response;
  }

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return recreateResponse(response, text);
  }
  const normalized = normalizeResponsesPayload(parsed, namespace);
  return recreateResponse(response, normalized === parsed ? text : JSON.stringify(normalized));
}

function normalizeResponsesSse(
  body: ReadableStream<Uint8Array>,
  hubNamespace?: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = newResponsesToolArgumentStreamState();
  const integerToolStreamKeys = new Set<string>();
  const pendingArgumentDeltas = new Map<
    string,
    { blocks: string[]; firstEvent: ResponsesStreamEvent; argumentsText: string }
  >();
  let buffer = "";

  const hubNamespaceValue = hubNamespace?.trim() || undefined;
  const withHubNamespace = (event: ResponsesStreamEvent): ResponsesStreamEvent =>
    hubNamespaceValue ? (fixupEcoMcpHubStreamEvent(event, hubNamespaceValue) as ResponsesStreamEvent) : event;

  const normalizeBlock = (block: string): string[] => {
    const event = parseResponsesStreamEventBlock(block) as ResponsesStreamEvent | null;
    if (!event) {
      return [`${block}\n\n`];
    }
    const key = responsesFunctionCallStreamKey(event);
    const name = event.item?.name?.trim() || event.name?.trim();
    if (key && name && hasCodexIntegerToolArguments(name)) {
      integerToolStreamKeys.add(key);
    }

    // A complete output item is authoritative even when an upstream omitted
    // arguments.done. Flush any held deltas before that terminal item.
    if (event.type === "response.output_item.done" && key) {
      const pending = pendingArgumentDeltas.get(key);
      const normalized = normalizeResponsesStreamToolArguments(event, state);
      if (!pending) {
        return [normalizedResponsesSseBlock(block, event, withHubNamespace(normalized))];
      }
      pendingArgumentDeltas.delete(key);
      const itemArguments = event.item?.arguments;
      const normalizedArguments = normalized.item?.arguments;
      const changed =
        typeof itemArguments === "string" &&
        typeof normalizedArguments === "string" &&
        normalizedArguments !== itemArguments;
      return [
        ...(changed
          ? [normalizedArgumentDeltaBlock(pending, normalizedArguments)]
          : pending.blocks.map((pendingBlock) => `${pendingBlock}\n\n`)),
        normalizedResponsesSseBlock(block, event, withHubNamespace(normalized)),
      ];
    }

    if (event.type === "response.function_call_arguments.delta" && key && integerToolStreamKeys.has(key)) {
      normalizeResponsesStreamToolArguments(event, state);
      const pending = pendingArgumentDeltas.get(key);
      if (pending) {
        pending.blocks.push(block);
        pending.argumentsText += event.delta ?? "";
      } else {
        pendingArgumentDeltas.set(key, {
          blocks: [block],
          firstEvent: event,
          argumentsText: event.delta ?? "",
        });
      }
      return [];
    }

    if (event.type === "response.function_call_arguments.done" && key) {
      const pending = pendingArgumentDeltas.get(key);
      const fullArguments = event.arguments ?? pending?.argumentsText ?? "";
      const normalized = normalizeResponsesStreamToolArguments(
        fullArguments === event.arguments ? event : { ...event, arguments: fullArguments },
        state,
      );
      if (!pending) {
        return [normalizedResponsesSseBlock(block, event, withHubNamespace(normalized))];
      }
      pendingArgumentDeltas.delete(key);
      const normalizedArguments = normalized.arguments ?? fullArguments;
      const changed = normalizedArguments !== fullArguments;
      return [
        ...(changed
          ? [normalizedArgumentDeltaBlock(pending, normalizedArguments)]
          : pending.blocks.map((pendingBlock) => `${pendingBlock}\n\n`)),
        normalizedResponsesSseBlock(block, event, withHubNamespace(normalized)),
      ];
    }

    const normalized = normalizeResponsesStreamToolArguments(event, state);
    if (isResponsesTerminalEvent(event.type) && pendingArgumentDeltas.size > 0) {
      const held = [...pendingArgumentDeltas.values()].flatMap((pending) =>
        pending.blocks.map((pendingBlock) => `${pendingBlock}\n\n`),
      );
      pendingArgumentDeltas.clear();
      return [...held, normalizedResponsesSseBlock(block, event, withHubNamespace(normalized))];
    }
    return [normalizedResponsesSseBlock(block, event, withHubNamespace(normalized))];
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const { blocks, remainder } = splitSseBlocks(buffer);
        buffer = remainder;
        for (const block of blocks) {
          for (const normalizedBlock of normalizeBlock(block)) {
            controller.enqueue(encoder.encode(normalizedBlock));
          }
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        let remainder = "";
        if (buffer.trim()) {
          const split = splitSseBlocks(`${buffer}\n\n`);
          remainder = split.remainder;
          for (const block of split.blocks) {
            for (const normalizedBlock of normalizeBlock(block)) {
              controller.enqueue(encoder.encode(normalizedBlock));
            }
          }
        }
        for (const pending of pendingArgumentDeltas.values()) {
          for (const pendingBlock of pending.blocks) {
            controller.enqueue(encoder.encode(`${pendingBlock}\n\n`));
          }
        }
        pendingArgumentDeltas.clear();
        if (remainder) {
          controller.enqueue(encoder.encode(remainder));
        }
      },
    }),
  );
}

function normalizedResponsesSseBlock(
  block: string,
  event: ResponsesStreamEvent,
  normalized: ResponsesStreamEvent,
): string {
  if (normalized === event) {
    return `${block}\n\n`;
  }
  return replaceSseData(block, JSON.stringify(normalized));
}

function normalizedArgumentDeltaBlock(
  pending: { firstEvent: ResponsesStreamEvent; blocks: string[] },
  argumentsText: string,
): string {
  const firstBlock = pending.blocks[0] ?? "event: response.function_call_arguments.delta";
  return replaceSseData(firstBlock, JSON.stringify({ ...pending.firstEvent, delta: argumentsText }));
}

function responsesFunctionCallStreamKey(event: ResponsesStreamEvent): string | undefined {
  if (event.output_index !== undefined) {
    return `output:${event.output_index}`;
  }
  const itemId = event.item?.id?.trim() || event.item_id?.trim();
  if (itemId) {
    return `item:${itemId}`;
  }
  const callId = event.item?.call_id?.trim() || event.call_id?.trim();
  return callId ? `call:${callId}` : undefined;
}

function isResponsesTerminalEvent(type: string): boolean {
  return (
    type === "response.completed" ||
    type === "response.done" ||
    type === "response.incomplete" ||
    type === "response.failed"
  );
}

function replaceSseData(block: string, data: string): string {
  const lines = block.split(/\r?\n/);
  const firstData = lines.findIndex((line) => line.startsWith("data:"));
  const preserved = lines.filter((line) => !line.startsWith("data:"));
  const insertionIndex = firstData < 0 ? preserved.length : Math.min(firstData, preserved.length);
  preserved.splice(insertionIndex, 0, `data: ${data}`);
  return `${preserved.join("\n")}\n\n`;
}

function normalizeResponsesPayload(value: unknown, hubNamespace?: string): unknown {
  if (!isRecord(value)) {
    return value;
  }
  let normalized: unknown;
  if (isRecord(value.response)) {
    const response = normalizeResponsesToolArguments(value.response as unknown as ResponsesResponse);
    normalized = (response as unknown) === value.response ? value : { ...value, response };
  } else if (Array.isArray(value.output)) {
    normalized = normalizeResponsesToolArguments(value as unknown as ResponsesResponse);
  } else {
    return value;
  }
  const namespace = hubNamespace?.trim();
  return namespace ? fixupEcoMcpHubResponsesPayload(normalized, namespace) : normalized;
}

function latestFunctionCallOutput(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    if (!isRecord(item) || item.type !== "function_call_output") {
      continue;
    }
    return readOutputText(item.output)?.trim();
  }
  return undefined;
}

function readOutputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
  return text || undefined;
}

function recreateResponse(source: Response, body: BodyInit): Response {
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  return new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
