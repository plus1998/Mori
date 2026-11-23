import { toResponsesCallID } from "./anthropic-to-responses.js";
import { CUSTOM_TOOL_INPUT_FIELD, customToolInputFromChatArguments } from "./codex-chat-common.js";
import {
  buildCodexToolContextFromRequest,
  type CodexToolContext,
  isCustomToolChatName,
  lookupChatName,
} from "./codex-tool-context.js";
import { jsonMarshal } from "./json.js";
import { responsesStreamEventToJSON } from "./responses-stream-event-wire.js";
import type {
  AnthropicResponse,
  AnthropicStreamEvent,
  ResponsesContentPart,
  ResponsesIncompleteDetails,
  ResponsesInputTokensDetails,
  ResponsesOutput,
  ResponsesResponse,
  ResponsesStreamEvent,
  ResponsesUsage,
} from "./types.js";

// ---------------------------------------------------------------------------
// Non-streaming: AnthropicResponse → ResponsesResponse
// ---------------------------------------------------------------------------

export function anthropicToResponsesResponse(
  resp: AnthropicResponse,
  toolContext: CodexToolContext = buildCodexToolContextFromRequest(undefined),
): ResponsesResponse {
  let id = resp.id;
  if (id === "") {
    id = generateResponsesId();
  }

  const out: ResponsesResponse = {
    id,
    object: "response",
    model: resp.model,
  };

  const outputs: ResponsesOutput[] = [];
  const msgParts: ResponsesContentPart[] = [];

  for (const block of resp.content) {
    switch (block.type) {
      case "thinking":
        if (block.thinking !== "") {
          outputs.push({
            type: "reasoning",
            id: block.id ?? generateItemId(),
            summary: [],
            content: [{ type: "reasoning_text", text: block.thinking ?? "" }],
          });
        }
        break;
      case "redacted_thinking":
        if (block.data !== undefined && block.data !== "") {
          outputs.push({
            type: "reasoning",
            id: block.id ?? generateItemId(),
            encrypted_content: block.data,
            summary: [],
          });
        }
        break;
      case "text":
        if (block.text !== "") {
          msgParts.push({ type: "output_text", text: block.text });
        }
        break;
      case "tool_use": {
        const chatName = block.name ?? "";
        if (isCustomToolChatName(toolContext, chatName)) {
          outputs.push({
            type: "custom_tool_call",
            id: generateItemId(),
            call_id: toResponsesCallID(block.id ?? ""),
            name: chatName,
            input: freeformInputFromAnthropicToolUse(block.input),
            status: "completed",
          });
          break;
        }
        let args = "{}";
        if (block.input !== undefined && block.input !== null) {
          const s = typeof block.input === "string" ? block.input : jsonMarshal(block.input);
          if (s.length > 0) {
            args = s;
          }
        }
        const spec = lookupChatName(toolContext, chatName);
        outputs.push({
          type: "function_call",
          id: generateItemId(),
          call_id: toResponsesCallID(block.id ?? ""),
          name: spec?.name ?? chatName,
          ...(spec?.namespace ? { namespace: spec.namespace } : {}),
          arguments: args,
          status: "completed",
        });
        break;
      }
    }
  }

  if (msgParts.length > 0) {
    outputs.push({
      type: "message",
      id: generateItemId(),
      role: "assistant",
      content: msgParts,
      status: "completed",
    });
  }

  if (outputs.length === 0) {
    outputs.push({
      type: "message",
      id: generateItemId(),
      role: "assistant",
      content: [{ type: "output_text", text: "" }],
      status: "completed",
    });
  }
  out.output = outputs;

  out.status = anthropicStopReasonToResponsesStatus(resp.stop_reason);
  if (out.status === "incomplete") {
    out.incomplete_details = { reason: "max_output_tokens" };
  }

  const totalInputTokens =
    resp.usage.input_tokens + resp.usage.cache_read_input_tokens + resp.usage.cache_creation_input_tokens;
  out.usage = {
    input_tokens: totalInputTokens,
    output_tokens: resp.usage.output_tokens,
    total_tokens: totalInputTokens + resp.usage.output_tokens,
  };
  if (resp.usage.cache_read_input_tokens > 0) {
    out.usage.input_tokens_details = {
      cached_tokens: resp.usage.cache_read_input_tokens,
    };
  }

  return out;
}

function anthropicStopReasonToResponsesStatus(stopReason: string): string {
  switch (stopReason) {
    case "max_tokens":
      return "incomplete";
    case "end_turn":
    case "tool_use":
    case "stop_sequence":
      return "completed";
    default:
      return "completed";
  }
}

// ---------------------------------------------------------------------------
// Streaming: AnthropicStreamEvent → ResponsesStreamEvent (stateful converter)
// ---------------------------------------------------------------------------

export interface AnthropicEventToResponsesState {
  responseId: string;
  model: string;
  created: number;
  sequenceNumber: number;
  createdSent: boolean;
  completedSent: boolean;
  outputIndex: number;
  currentItemId: string;
  currentItemType: string;
  currentEncryptedContent: string;
  currentText: string;
  currentReasoningText: string;
  contentIndex: number;
  currentCallId: string;
  currentName: string;
  /** Unflattened Codex name when chat used collaboration__spawn_agent. */
  currentResponsesName: string;
  currentNamespace?: string | undefined;
  currentArguments: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Custom freeform tool names from the original Responses request. */
  toolContext: CodexToolContext;
}

export function newAnthropicEventToResponsesState(
  toolContext: CodexToolContext = buildCodexToolContextFromRequest(undefined),
): AnthropicEventToResponsesState {
  return {
    responseId: "",
    model: "",
    created: Math.floor(Date.now() / 1000),
    sequenceNumber: 0,
    createdSent: false,
    completedSent: false,
    outputIndex: 0,
    currentItemId: "",
    currentItemType: "",
    currentEncryptedContent: "",
    currentText: "",
    currentReasoningText: "",
    contentIndex: 0,
    currentCallId: "",
    currentName: "",
    currentResponsesName: "",
    currentArguments: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    toolContext,
  };
}

export function anthropicEventToResponsesEvents(
  evt: AnthropicStreamEvent,
  state: AnthropicEventToResponsesState,
): ResponsesStreamEvent[] {
  switch (evt.type) {
    case "message_start":
      return anthToResHandleMessageStart(evt, state);
    case "content_block_start":
      return anthToResHandleContentBlockStart(evt, state);
    case "content_block_delta":
      return anthToResHandleContentBlockDelta(evt, state);
    case "content_block_stop":
      return anthToResHandleContentBlockStop(state);
    case "message_delta":
      return anthToResHandleMessageDelta(evt, state);
    case "message_stop":
      return anthToResHandleMessageStop(state);
    default:
      return [];
  }
}

export function finalizeAnthropicResponsesStream(
  state: AnthropicEventToResponsesState,
): ResponsesStreamEvent[] {
  if (!state.createdSent || state.completedSent) {
    return [];
  }

  const events: ResponsesStreamEvent[] = [];
  events.push(...closeCurrentResponsesItem(state));
  events.push(makeResponsesCompletedEvent(state, "completed", undefined));
  state.completedSent = true;
  return events;
}

export function responsesEventToSse(evt: ResponsesStreamEvent): string {
  const data = responsesStreamEventToJSON(evt);
  return `event: ${evt.type}\ndata: ${data}\n\n`;
}

function anthToResHandleMessageStart(
  evt: AnthropicStreamEvent,
  state: AnthropicEventToResponsesState,
): ResponsesStreamEvent[] {
  if (evt.message !== undefined) {
    state.responseId = evt.message.id;
    if (state.model === "") {
      state.model = evt.message.model;
    }
    if (evt.message.usage.input_tokens > 0) {
      state.inputTokens = evt.message.usage.input_tokens;
    }
    if (evt.message.usage.cache_read_input_tokens > 0) {
      state.cacheReadInputTokens = evt.message.usage.cache_read_input_tokens;
    }
    if (evt.message.usage.cache_creation_input_tokens > 0) {
      state.cacheCreationInputTokens = evt.message.usage.cache_creation_input_tokens;
    }
  }

  if (state.createdSent) {
    return [];
  }
  state.createdSent = true;

  return [makeResponsesCreatedEvent(state)];
}

function anthToResHandleContentBlockStart(
  evt: AnthropicStreamEvent,
  state: AnthropicEventToResponsesState,
): ResponsesStreamEvent[] {
  if (evt.content_block === undefined) {
    return [];
  }

  const events: ResponsesStreamEvent[] = [];

  switch (evt.content_block.type) {
    case "thinking":
      state.currentItemId = generateItemId();
      state.currentItemType = "reasoning";
      state.currentEncryptedContent = "";
      state.currentReasoningText = evt.content_block.thinking ?? "";
      state.contentIndex = 0;

      events.push(
        makeResponsesEvent(state, "response.output_item.added", {
          output_index: state.outputIndex,
          item: {
            type: "reasoning",
            id: state.currentItemId,
            summary: [],
            content: [],
          },
        }),
      );
      break;

    case "redacted_thinking":
      state.currentItemId = generateItemId();
      state.currentItemType = "reasoning";
      state.currentEncryptedContent = evt.content_block.data ?? "";
      state.currentReasoningText = "";
      state.contentIndex = 0;

      events.push(
        makeResponsesEvent(state, "response.output_item.added", {
          output_index: state.outputIndex,
          item: {
            type: "reasoning",
            id: state.currentItemId,
            encrypted_content: state.currentEncryptedContent,
            summary: [],
          },
        }),
      );
      break;

    case "text":
      if (state.currentItemType !== "message") {
        state.currentItemId = generateItemId();
        state.currentItemType = "message";
        state.currentText = evt.content_block.text ?? "";
        state.contentIndex = 0;

        events.push(
          makeResponsesEvent(state, "response.output_item.added", {
            output_index: state.outputIndex,
            item: {
              type: "message",
              id: state.currentItemId,
              role: "assistant",
              status: "in_progress",
            },
          }),
        );
      }
      break;

    case "tool_use": {
      events.push(...closeCurrentResponsesItem(state));

      const toolChatName = evt.content_block.name ?? "";
      const isCustom = isCustomToolChatName(state.toolContext, toolChatName);
      const spec = lookupChatName(state.toolContext, toolChatName);
      state.currentItemId = generateItemId();
      state.currentItemType = isCustom ? "custom_tool_call" : "function_call";
      state.currentCallId = toResponsesCallID(evt.content_block.id ?? "");
      // Chat-facing name stays flattened for custom; Responses wire uses unflattened name+namespace.
      state.currentName = isCustom ? toolChatName : (spec?.name ?? toolChatName);
      state.currentResponsesName = state.currentName;
      const namespace = isCustom ? undefined : spec?.namespace;
      if (namespace === undefined) {
        delete state.currentNamespace;
      } else {
        state.currentNamespace = namespace;
      }
      state.currentArguments = isCustom
        ? freeformInputFromAnthropicToolUse(evt.content_block.input)
        : initialToolArguments(evt.content_block.input);

      events.push(
        makeResponsesEvent(state, "response.output_item.added", {
          output_index: state.outputIndex,
          item: {
            type: state.currentItemType,
            id: state.currentItemId,
            call_id: state.currentCallId,
            name: state.currentName,
            ...(state.currentNamespace ? { namespace: state.currentNamespace } : {}),
            status: "in_progress",
          },
        }),
      );
      break;
    }
  }

  return events;
}

function anthToResHandleContentBlockDelta(
  evt: AnthropicStreamEvent,
  state: AnthropicEventToResponsesState,
): ResponsesStreamEvent[] {
  if (evt.delta === undefined) {
    return [];
  }

  switch (evt.delta.type) {
    case "text_delta":
      if (evt.delta.text === "") {
        return [];
      }
      state.currentText += evt.delta.text ?? "";
      return [
        makeResponsesEvent(state, "response.output_text.delta", {
          output_index: state.outputIndex,
          content_index: state.contentIndex,
          delta: evt.delta.text,
          item_id: state.currentItemId,
        }),
      ];

    case "thinking_delta":
      if (evt.delta.thinking === "") {
        return [];
      }
      state.currentReasoningText += evt.delta.thinking ?? "";
      return [
        makeResponsesEvent(state, "response.reasoning_text.delta", {
          output_index: state.outputIndex,
          content_index: 0,
          delta: evt.delta.thinking,
          item_id: state.currentItemId,
        }),
      ];

    case "input_json_delta":
      if (evt.delta.partial_json === "") {
        return [];
      }
      state.currentArguments += evt.delta.partial_json ?? "";
      // Buffer freeform custom tool JSON fragments; unwrap on content_block_stop.
      if (state.currentItemType === "custom_tool_call") {
        return [];
      }
      return [
        makeResponsesEvent(state, "response.function_call_arguments.delta", {
          output_index: state.outputIndex,
          delta: evt.delta.partial_json,
          item_id: state.currentItemId,
          call_id: state.currentCallId,
          name: state.currentName,
        }),
      ];

    case "signature_delta":
      return [];
  }

  return [];
}

function anthToResHandleContentBlockStop(state: AnthropicEventToResponsesState): ResponsesStreamEvent[] {
  switch (state.currentItemType) {
    case "reasoning": {
      const events: ResponsesStreamEvent[] = [
        makeResponsesEvent(state, "response.reasoning_text.done", {
          output_index: state.outputIndex,
          content_index: 0,
          item_id: state.currentItemId,
          text: state.currentReasoningText,
        }),
      ];
      events.push(...closeCurrentResponsesItem(state));
      return events;
    }

    case "function_call": {
      const events: ResponsesStreamEvent[] = [
        makeResponsesEvent(state, "response.function_call_arguments.done", {
          output_index: state.outputIndex,
          item_id: state.currentItemId,
          call_id: state.currentCallId,
          name: state.currentName,
          arguments: completedToolArguments(state.currentArguments),
        }),
      ];
      events.push(...closeCurrentResponsesItem(state));
      return events;
    }

    case "custom_tool_call": {
      const input = freeformInputFromAnthropicToolUse(
        state.currentArguments === ""
          ? undefined
          : (tryParseJsonObject(state.currentArguments) ?? state.currentArguments),
      );
      // Keep unwrapped freeform text for output_item.done.
      state.currentArguments = input;
      const events: ResponsesStreamEvent[] = [
        makeResponsesEvent(state, "response.custom_tool_call_input.done", {
          output_index: state.outputIndex,
          item_id: state.currentItemId,
          call_id: state.currentCallId,
          name: state.currentName,
          input,
        }),
      ];
      events.push(...closeCurrentResponsesItem(state));
      return events;
    }

    case "message":
      return [
        makeResponsesEvent(state, "response.output_text.done", {
          output_index: state.outputIndex,
          content_index: state.contentIndex,
          item_id: state.currentItemId,
          text: state.currentText,
        }),
      ];
  }

  return [];
}

function anthToResHandleMessageDelta(
  evt: AnthropicStreamEvent,
  state: AnthropicEventToResponsesState,
): ResponsesStreamEvent[] {
  if (evt.usage !== undefined) {
    const { output_tokens, input_tokens, cache_read_input_tokens, cache_creation_input_tokens } = evt.usage;
    state.outputTokens = output_tokens;
    if (typeof input_tokens === "number" && input_tokens >= 0) {
      state.inputTokens = input_tokens;
    }
    if (typeof cache_read_input_tokens === "number" && cache_read_input_tokens >= 0) {
      state.cacheReadInputTokens = cache_read_input_tokens;
    }
    if (typeof cache_creation_input_tokens === "number" && cache_creation_input_tokens >= 0) {
      state.cacheCreationInputTokens = cache_creation_input_tokens;
    }
  }

  return [];
}

function anthToResHandleMessageStop(state: AnthropicEventToResponsesState): ResponsesStreamEvent[] {
  if (state.completedSent) {
    return [];
  }

  const events: ResponsesStreamEvent[] = [];
  events.push(...closeCurrentResponsesItem(state));
  events.push(makeResponsesCompletedEvent(state, "completed", undefined));
  state.completedSent = true;
  return events;
}

function closeCurrentResponsesItem(state: AnthropicEventToResponsesState): ResponsesStreamEvent[] {
  if (state.currentItemType === "") {
    return [];
  }

  const itemType = state.currentItemType;
  const itemId = state.currentItemId;
  const encryptedContent = state.currentEncryptedContent;
  const text = state.currentText;
  const reasoningText = state.currentReasoningText;
  const callId = state.currentCallId;
  const name = state.currentName;
  const namespace = state.currentNamespace;
  const rawArgs = state.currentArguments;
  const args = itemType === "custom_tool_call" ? rawArgs : completedToolArguments(rawArgs);

  state.currentItemType = "";
  state.currentItemId = "";
  state.currentEncryptedContent = "";
  state.currentText = "";
  state.currentReasoningText = "";
  state.currentCallId = "";
  state.currentName = "";
  state.currentResponsesName = "";
  delete state.currentNamespace;
  state.currentArguments = "";
  state.outputIndex++;
  state.contentIndex = 0;

  return [
    makeResponsesEvent(state, "response.output_item.done", {
      output_index: state.outputIndex - 1,
      item: {
        type: itemType,
        id: itemId,
        role: itemType === "message" ? "assistant" : undefined,
        content:
          itemType === "message"
            ? [{ type: "output_text", text }]
            : itemType === "reasoning" && reasoningText !== ""
              ? [{ type: "reasoning_text", text: reasoningText }]
              : itemType === "reasoning"
                ? []
                : undefined,
        call_id: itemType === "function_call" || itemType === "custom_tool_call" ? callId : undefined,
        name: itemType === "function_call" || itemType === "custom_tool_call" ? name : undefined,
        ...(itemType === "function_call" && namespace ? { namespace } : {}),
        arguments: itemType === "function_call" ? args : undefined,
        input: itemType === "custom_tool_call" ? args : undefined,
        encrypted_content: itemType === "reasoning" && encryptedContent !== "" ? encryptedContent : undefined,
        summary: itemType === "reasoning" ? [] : undefined,
        status: "completed",
      },
    }),
  ];
}

function initialToolArguments(input: unknown): string {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input === "{}" ? "" : input;
  }
  if (typeof input === "object" && Object.keys(input).length === 0) {
    return "";
  }
  return jsonMarshal(input);
}

function completedToolArguments(args: string): string {
  return args === "" ? "{}" : args;
}

function freeformInputFromAnthropicToolUse(input: unknown): string {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return customToolInputFromChatArguments(input);
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const wrapped = record[CUSTOM_TOOL_INPUT_FIELD];
    if (typeof wrapped === "string") {
      return wrapped;
    }
    // Streaming tool_use blocks often start with `{}`; keep the buffer empty so
    // subsequent input_json_delta fragments form a single parseable JSON object.
    if (Object.keys(record).length === 0) {
      return "";
    }
  }
  return jsonMarshal(input);
}

function tryParseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function makeResponsesCreatedEvent(state: AnthropicEventToResponsesState): ResponsesStreamEvent {
  const seq = state.sequenceNumber;
  state.sequenceNumber++;
  return {
    type: "response.created",
    sequence_number: seq,
    response: {
      id: state.responseId,
      object: "response",
      model: state.model,
      status: "in_progress",
      output: [],
    },
  };
}

function makeResponsesCompletedEvent(
  state: AnthropicEventToResponsesState,
  status: string,
  incompleteDetails: ResponsesIncompleteDetails | undefined,
): ResponsesStreamEvent {
  const seq = state.sequenceNumber;
  state.sequenceNumber++;

  const totalInputTokens = state.inputTokens + state.cacheReadInputTokens + state.cacheCreationInputTokens;
  const usage: ResponsesUsage = {
    input_tokens: totalInputTokens,
    output_tokens: state.outputTokens,
    total_tokens: totalInputTokens + state.outputTokens,
  };
  if (state.cacheReadInputTokens > 0) {
    usage.input_tokens_details = {
      cached_tokens: state.cacheReadInputTokens,
    } satisfies ResponsesInputTokensDetails;
  }

  return {
    type: "response.completed",
    sequence_number: seq,
    response: {
      id: state.responseId,
      object: "response",
      model: state.model,
      status,
      output: [],
      usage,
      incomplete_details: incompleteDetails,
    },
  };
}

function makeResponsesEvent(
  state: AnthropicEventToResponsesState,
  eventType: string,
  template: Omit<ResponsesStreamEvent, "type" | "sequence_number">,
): ResponsesStreamEvent {
  const seq = state.sequenceNumber;
  state.sequenceNumber++;
  return {
    ...template,
    type: eventType,
    sequence_number: seq,
  };
}

function randomHex(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateResponsesId(): string {
  return `resp_${randomHex(12)}`;
}

export function generateItemId(): string {
  return `item_${randomHex(12)}`;
}
