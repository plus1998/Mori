import { type AgentEvent, createAgentEvent, ToolWriteTargetTracker } from "../../shared/src";
import { mapPiToolNameToSdkToolName } from "./pi-tool-approval.js";
import { parsePiUsage } from "./pi-usage.js";

/**
 * Minimal PI session event surface used by Eco's feed adapter.
 * Full union lives in `@earendil-works/pi-coding-agent` AgentSessionEvent.
 */
export type PiSessionEventLike = {
  type: string;
  [key: string]: unknown;
};

/** Mutable per-session adapter state so stream_block_key are ordered and scoped. */
export interface PiEventAdapterState {
  /** Monotonic assistant message generation (bumped on message_start / message_end). */
  messageSeq: number;
  /** last contentIndex for text / thinking within current message (for stable keys). */
  lastTextIndex: number | null;
  lastThinkingIndex: number | null;
  openText: boolean;
  openThinking: boolean;
  /** Last stamped thinking display for this open thinking stream. */
  openThinkingDisplay: "summary" | "raw" | undefined;
  /** tool.started inputs keyed by toolCallId — replayed on tool.completed/failed for metadata. */
  pendingToolUses: Map<
    string,
    { toolName: string; input: Record<string, unknown>; parentToolCallId?: string }
  >;
  /**
   * Tool calls whose "the model is writing its arguments" placeholder was already
   * emitted for the current assistant message. PI streams one `toolcall_delta` per
   * fragment, so without this the same call would be announced thousands of times.
   */
  /** writeKey → target already announced for that call (`""` while it has none yet). */
  announcedToolWrites: Map<string, string>;
  /** writeKey → tool-call arguments seen so far, for naming the write's target. */
  piToolCallArguments: Map<string, PiToolCallArguments>;
  /** writeKey → reader that names the write's target without re-reading every fragment. */
  piToolWriteTargets: Map<string, ToolWriteTargetTracker>;
}

interface PiToolCallArguments {
  text: string;
  /** True for the model's own JSON text; false for a re-serialized parsed object. */
  raw: boolean;
}

export function createPiEventAdapterState(): PiEventAdapterState {
  return {
    messageSeq: 0,
    lastTextIndex: null,
    lastThinkingIndex: null,
    openText: false,
    openThinking: false,
    openThinkingDisplay: undefined,
    pendingToolUses: new Map(),
    announcedToolWrites: new Map(),
    piToolCallArguments: new Map(),
    piToolWriteTargets: new Map(),
  };
}

/** Map PI lowercase tool names to Eco Feed / SDK PascalCase labels. */
export function mapPiFeedToolName(toolName: string): string {
  return mapPiToolNameToSdkToolName(toolName);
}

/** Last assistant `stopReason: error` text from a live PI session event. */
export function readPiAssistantErrorMessage(event: PiSessionEventLike): string | undefined {
  const messages: unknown[] = [];
  if (event.type === "message_end") {
    messages.push(event.message);
  } else if (event.type === "agent_end" && Array.isArray(event.messages)) {
    messages.push(...event.messages);
  }
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    if (message.stopReason !== "error") {
      continue;
    }
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
    if (errorMessage) {
      return errorMessage;
    }
  }
  return undefined;
}

/** PI compaction trigger: manual (/compact) | threshold | overflow. */
export function readPiCompactionReason(value: unknown): "manual" | "threshold" | "overflow" | undefined {
  return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
}

function isPiAssistantSuccessMessage(event: PiSessionEventLike): boolean {
  if (event.type !== "message_end" || !isRecord(event.message) || event.message.role !== "assistant") {
    return false;
  }
  return event.message.stopReason !== "error";
}

/** Track in-stream PI errors across retries; a later successful assistant turn clears them. */
export function applyPiAssistantErrorTracker(
  event: PiSessionEventLike,
  current: string | undefined,
): string | undefined {
  const nextError = readPiAssistantErrorMessage(event);
  if (nextError) {
    return nextError;
  }
  if (isPiAssistantSuccessMessage(event)) {
    return undefined;
  }
  return current;
}

export interface PiEventAdapterContext {
  threadId: string;
  sessionId: string;
  /** Monotonic counter for stable event ids within a turn. */
  nextSeq: () => number;
  /** Required for stream-key isolation across multi-message agent loops. */
  state: PiEventAdapterState;
  /**
   * Eco feed agentId. Parent sessions use the PI session UUID; subagents use their
   * instance id (must NOT equal the parent session UUID).
   */
  agentId?: string;
  /** Eco feed role. Parent = planner; subagents use their orchestration agentKey. */
  role?: string;
  /**
   * Wire used for this PI session. openai_responses thinking_delta is a reasoning
   * summary; anthropic thinking_delta is raw thinking body. Missing means do not guess.
   */
  apiCompat?: "anthropic" | "openai_responses" | "openai_chat_completions";
}

/**
 * Map Pi agent/session events → Eco `AgentEvent` stream for feed + billing.
 * Unknown events yield an empty array (no silent inventing of feed rows).
 *
 * Ordering / stream isolation rules (v1):
 * - Every assistant message gets a unique stream generation (`messageSeq`).
 * - text / thinking use different stream_block_key and finalize on *_end / message_end / tools.
 * - Never reuse one session-wide key (that merges later turns into earlier narrative).
 */
export function mapPiSessionEventToAgentEvents(
  event: PiSessionEventLike,
  ctx: PiEventAdapterContext,
): AgentEvent[] {
  const seq = ctx.nextSeq();
  // Parent: agentId must equal conversationStore sessionId (PI session UUID).
  // Subagent: agentId is the child instance id and role is the orchestration agentKey.
  const base = {
    threadId: ctx.threadId,
    agentId: ctx.agentId?.trim() || ctx.sessionId,
    role: ctx.role?.trim() || "planner",
  };
  const state = ctx.state;

  switch (event.type) {
    case "agent_start":
      return [
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:agent_start`,
          ...base,
          type: "agent.started",
          payload: { source: "pi", sessionId: ctx.sessionId },
        }),
      ];

    case "auto_retry_start": {
      const attempt = typeof event.attempt === "number" ? event.attempt : undefined;
      const maxRetries = typeof event.maxAttempts === "number" ? event.maxAttempts : undefined;
      return [
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:auto_retry_start`,
          ...base,
          type: "agent.started",
          payload: {
            type: "system",
            subtype: "api_retry",
            ...(attempt !== undefined ? { attempt } : {}),
            ...(maxRetries !== undefined ? { max_retries: maxRetries } : {}),
          },
        }),
      ];
    }

    case "message_start": {
      // Only assistant model messages open a new stream generation.
      // Tool-result / user app messages must not burn messageSeq or reset mid-stream state.
      if (isAssistantMessage(event.message) || event.message === undefined) {
        // message may be partial on start; PI partials are assistant-shaped when present.
        const role =
          isRecord(event.message) && typeof event.message.role === "string"
            ? event.message.role
            : "assistant";
        if (role === "assistant") {
          beginMessage(state);
        }
      }
      return [];
    }

    case "agent_end": {
      // agent_end is loop-boundary only — may retry / continue. Do NOT emit run completion.
      // Usage is emitted exactly once per assistant message at message_end (which fires
      // for every assistant message, including error/aborted ones) — re-emitting from
      // the agent_end transcript would double-bill every invocation.
      return [
        ...closeOpenStreams(ctx, seq, "agent_end"),
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:agent_end`,
          ...base,
          type: "agent.loop_ended",
          payload: {
            source: "pi",
            sessionId: ctx.sessionId,
            willRetry: event.willRetry === true,
          },
        }),
      ];
    }

    case "agent_settled": {
      // True settle — no automatic retry/compaction/queued continuation remains.
      // run.terminal is emitted by the session prompt loop after settle (single observable).
      return [
        ...closeOpenStreams(ctx, seq, "agent_settled"),
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:agent_settled`,
          ...base,
          type: "agent.settled",
          payload: { source: "pi", sessionId: ctx.sessionId, aborted: event.aborted === true },
        }),
      ];
    }

    case "compaction_start": {
      // PI native compaction is invisible otherwise; surface the lifecycle for the Feed.
      const reason = readPiCompactionReason(event.reason);
      return [
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:compaction_start`,
          ...base,
          type: "context.compaction.started",
          payload: {
            source: "pi",
            sessionId: ctx.sessionId,
            ...(reason && { reason }),
          },
        }),
      ];
    }

    case "compaction_end": {
      const reason = readPiCompactionReason(event.reason);
      const result = isRecord(event.result) ? event.result : undefined;
      const aborted = event.aborted === true;
      const errorMessage =
        typeof event.errorMessage === "string" && event.errorMessage.trim()
          ? event.errorMessage.trim()
          : undefined;
      const ok = !aborted && result !== undefined;
      return [
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:compaction_end`,
          ...base,
          type: ok ? "context.compaction.completed" : "context.compaction.failed",
          payload: {
            source: "pi",
            sessionId: ctx.sessionId,
            ...(reason && { reason }),
            ...(ok && result
              ? {
                  ...(typeof result.tokensBefore === "number" && {
                    tokensBefore: result.tokensBefore,
                  }),
                  ...(typeof result.estimatedTokensAfter === "number" && {
                    estimatedTokensAfter: result.estimatedTokensAfter,
                  }),
                }
              : {
                  message: errorMessage ?? (aborted ? "Compaction aborted." : "Compaction failed."),
                }),
          },
        }),
      ];
    }

    case "message_update": {
      const amEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
      if (!amEvent) {
        return [];
      }
      const amType = typeof amEvent.type === "string" ? amEvent.type : "";
      const contentIndex = readContentIndex(amEvent);

      if (amType === "text_start") {
        ensureMessageGeneration(state);
        state.lastTextIndex = contentIndex ?? state.lastTextIndex ?? 0;
        state.openText = true;
        return [];
      }
      if (amType === "thinking_start") {
        ensureMessageGeneration(state);
        state.lastThinkingIndex = contentIndex ?? state.lastThinkingIndex ?? 0;
        state.openThinking = true;
        const reasoningDisplay = stampOpenThinkingDisplay(amEvent, ctx, state);
        return [
          createAgentEvent({
            id: `${ctx.threadId}:pi:${seq}:thinking_start`,
            ...base,
            type: "message.delta",
            payload: {
              type: "eco_stream",
              blockKind: "thinking",
              streamPlaceholder: true,
              ...(reasoningDisplay && { reasoningDisplay }),
              stream_block_key: thinkingStreamKey(ctx.sessionId, state),
            },
          }),
        ];
      }

      if (amType === "text_delta") {
        const delta = typeof amEvent.delta === "string" ? amEvent.delta : "";
        if (!delta) {
          return [];
        }
        ensureMessageGeneration(state);
        if (contentIndex !== null) {
          state.lastTextIndex = contentIndex;
        } else if (state.lastTextIndex === null) {
          state.lastTextIndex = 0;
        }
        state.openText = true;
        return [
          createAgentEvent({
            id: `${ctx.threadId}:pi:${seq}:text_delta`,
            ...base,
            type: "message.delta",
            payload: {
              type: "eco_stream",
              blockKind: "text",
              text: delta,
              stream_block_key: textStreamKey(ctx.sessionId, state),
            },
          }),
        ];
      }

      if (amType === "thinking_delta") {
        const delta = typeof amEvent.delta === "string" ? amEvent.delta : "";
        if (!delta) {
          return [];
        }
        ensureMessageGeneration(state);
        if (contentIndex !== null) {
          state.lastThinkingIndex = contentIndex;
        } else if (state.lastThinkingIndex === null) {
          state.lastThinkingIndex = 0;
        }
        state.openThinking = true;
        const reasoningDisplay = stampOpenThinkingDisplay(amEvent, ctx, state);
        return [
          createAgentEvent({
            id: `${ctx.threadId}:pi:${seq}:thinking_delta`,
            ...base,
            type: "message.delta",
            payload: {
              type: "eco_stream",
              blockKind: "thinking",
              text: delta,
              ...(reasoningDisplay && { reasoningDisplay }),
              stream_block_key: thinkingStreamKey(ctx.sessionId, state),
            },
          }),
        ];
      }

      if (amType === "text_end") {
        const content = typeof amEvent.content === "string" ? amEvent.content : "";
        ensureMessageGeneration(state);
        if (contentIndex !== null) {
          state.lastTextIndex = contentIndex;
        } else if (state.lastTextIndex === null) {
          state.lastTextIndex = 0;
        }
        const events: AgentEvent[] = [];
        // If no deltas arrived, surface full block once; else finalize accumulated stream.
        if (!state.openText && content) {
          events.push(
            createAgentEvent({
              id: `${ctx.threadId}:pi:${seq}:text_end_body`,
              ...base,
              type: "message.delta",
              payload: {
                type: "eco_stream",
                blockKind: "text",
                text: content,
                stream_block_key: textStreamKey(ctx.sessionId, state),
              },
            }),
          );
        }
        events.push(
          createAgentEvent({
            id: `${ctx.threadId}:pi:${seq}:text_end`,
            ...base,
            type: "message.delta",
            payload: {
              type: "eco_stream",
              blockKind: "text",
              text: "",
              streamFinalize: true,
              stream_block_key: textStreamKey(ctx.sessionId, state),
            },
          }),
        );
        state.openText = false;
        return events;
      }

      if (amType === "thinking_end") {
        const content = typeof amEvent.content === "string" ? amEvent.content : "";
        ensureMessageGeneration(state);
        if (contentIndex !== null) {
          state.lastThinkingIndex = contentIndex;
        } else if (state.lastThinkingIndex === null) {
          state.lastThinkingIndex = 0;
        }
        const reasoningDisplay = stampOpenThinkingDisplay(amEvent, ctx, state);
        const events: AgentEvent[] = [];
        if (!state.openThinking && content) {
          events.push(
            createAgentEvent({
              id: `${ctx.threadId}:pi:${seq}:thinking_end_body`,
              ...base,
              type: "message.delta",
              payload: {
                type: "eco_stream",
                blockKind: "thinking",
                text: content,
                ...(reasoningDisplay && { reasoningDisplay }),
                stream_block_key: thinkingStreamKey(ctx.sessionId, state),
              },
            }),
          );
        }
        events.push(
          createAgentEvent({
            id: `${ctx.threadId}:pi:${seq}:thinking_end`,
            ...base,
            type: "message.delta",
            payload: {
              type: "eco_stream",
              blockKind: "thinking",
              text: "",
              ...(reasoningDisplay && { reasoningDisplay }),
              streamFinalize: true,
              stream_block_key: thinkingStreamKey(ctx.sessionId, state),
            },
          }),
        );
        state.openThinking = false;
        state.openThinkingDisplay = undefined;
        return events;
      }

      if (amType === "toolcall_start" || amType === "toolcall_delta") {
        // The model has started writing this tool call. Nothing renders for it yet —
        // arguments are incomplete, and `tool_execution_start` only fires once it runs —
        // but the state itself is not silence, so hand it over as a placeholder rather
        // than dropping it and letting the Composer guess from a still Feed.
        const writing = readPiToolCallWrite(amEvent, contentIndex);
        if (!writing) {
          return [];
        }
        const writeKey = writing.id ?? `pos:${state.messageSeq}:${writing.position}`;
        const feedToolName = mapPiFeedToolName(writing.name);
        // `toolcall_delta` fragments are the call's arguments, so the Feed can name the file or
        // command being written instead of only saying a call is under way.
        const argumentsText = accumulatePiToolCallArguments(state, amEvent, contentIndex, writing.id);
        const target = piToolWriteTarget(state, writeKey, feedToolName).observe(argumentsText);
        const announced = state.announcedToolWrites.get(writeKey);
        const isFirstAnnouncement = announced === undefined;
        if (!isFirstAnnouncement && (!target || target === announced)) {
          return [];
        }
        state.announcedToolWrites.set(writeKey, target ?? "");
        const parentToolCallId = readPiParentToolCallId(event);
        return [
          createAgentEvent({
            id: `${ctx.threadId}:pi:${seq}:toolcall_writing:${writeKey}`,
            ...base,
            type: "tool.started",
            payload: {
              type: "tool_use",
              tool_name: feedToolName,
              ...(writing.id ? { tool_use_id: writing.id } : {}),
              streaming: true,
              input_complete: false,
              ...(target ? { tool_input_target: target } : {}),
              ...piNestedToolCallPayload(parentToolCallId),
            },
          }),
        ];
      }

      // Remaining toolcall_* noise (e.g. argument fragments) is covered by
      // tool_execution_* session events; nothing else here is a Feed row.
      return [];
    }

    case "message_end": {
      const message = event.message;
      const events: AgentEvent[] = [];
      // Close any open streams first so thinking never bleeds into the next message.
      events.push(...closeOpenStreams(ctx, seq, "message_end"));

      if (isAssistantMessage(message)) {
        const text = extractAssistantText(message);
        // Only inject a full text snapshot when this message never streamed text deltas
        // (avoids re-pushing full body and double-merge into narrative).
        if (text && state.lastTextIndex === null) {
          ensureMessageGeneration(state);
          state.lastTextIndex = 0;
          events.push(
            createAgentEvent({
              id: `${ctx.threadId}:pi:${seq}:message_end_text`,
              ...base,
              type: "message.delta",
              payload: {
                type: "eco_stream",
                blockKind: "text",
                text,
                streamFinalize: true,
                stream_block_key: textStreamKey(ctx.sessionId, state),
              },
            }),
          );
        } else if (text) {
          // Already streamed — finalize only if still open (closeOpenStreams may have done it).
          // No full-text re-emit.
        }

        // Same for thinking blocks that never streamed (non-stream path).
        const thinking = extractAssistantThinking(message);
        if (thinking && state.lastThinkingIndex === null) {
          ensureMessageGeneration(state);
          state.lastThinkingIndex = 0;
          const reasoningDisplay = resolvePiThinkingReasoningDisplay(undefined, ctx, state);
          events.push(
            createAgentEvent({
              id: `${ctx.threadId}:pi:${seq}:message_end_thinking`,
              ...base,
              type: "message.delta",
              payload: {
                type: "eco_stream",
                blockKind: "thinking",
                text: thinking,
                ...(reasoningDisplay && { reasoningDisplay }),
                streamFinalize: true,
                stream_block_key: thinkingStreamKey(ctx.sessionId, state),
              },
            }),
          );
        }

        const usageEvent = usageEventFromAssistantMessage(message, ctx, seq);
        if (usageEvent) {
          events.push(usageEvent);
        }
      }

      // Close generation so the next message_start / first delta starts a fresh key.
      endMessage(state);
      return events;
    }

    case "tool_execution_start": {
      // Barrier: finalize open narrative streams before tool noise so they cannot merge across tools.
      const barrier = closeOpenStreams(ctx, seq, "tool_start");
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `tool_${seq}`;
      const rawToolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const toolName = mapPiFeedToolName(rawToolName);
      const args = normalizePiToolUseInput(rawToolName, isRecord(event.args) ? event.args : {});
      const parentToolCallId = readPiParentToolCallId(event);
      ctx.state.pendingToolUses.set(toolCallId, {
        toolName,
        input: args,
        ...(parentToolCallId ? { parentToolCallId } : {}),
      });
      return [
        ...barrier,
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:tool_start:${toolCallId}`,
          ...base,
          type: "tool.started",
          payload: {
            type: "tool_use",
            tool_name: toolName,
            tool_use_id: toolCallId,
            input: args,
            input_complete: true,
            ...piNestedToolCallPayload(parentToolCallId),
          },
        }),
      ];
    }

    case "tool_execution_end": {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `tool_${seq}`;
      const pending = ctx.state.pendingToolUses.get(toolCallId);
      ctx.state.pendingToolUses.delete(toolCallId);
      const rawToolName = typeof event.toolName === "string" ? event.toolName : (pending?.toolName ?? "tool");
      const toolName = mapPiFeedToolName(rawToolName);
      const input = pending?.input ?? {};
      const isError = event.isError === true;
      const resultText = formatToolResult(event.result);
      const parentToolCallId = readPiParentToolCallId(event) ?? pending?.parentToolCallId;
      const structuredContent = readPiStructuredContent(event.result);
      const codemodeDetails = readPiCodemodeDetails(event.result);
      const durationMs =
        typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
          ? event.durationMs
          : undefined;
      return [
        createAgentEvent({
          id: `${ctx.threadId}:pi:${seq}:tool_end:${toolCallId}`,
          ...base,
          type: isError ? "tool.failed" : "tool.completed",
          payload: isError
            ? {
                type: "tool_result_error",
                tool_name: toolName,
                tool_use_id: toolCallId,
                input,
                message: resultText || "Tool execution failed.",
                ...(durationMs !== undefined && { durationMs }),
                ...piNestedToolCallPayload(parentToolCallId),
                ...(codemodeDetails ? { codemodeDetails } : {}),
              }
            : {
                type: "tool_result",
                tool_name: toolName,
                tool_use_id: toolCallId,
                input,
                content: resultText,
                ...(durationMs !== undefined && { durationMs }),
                ...(structuredContent !== undefined && { structuredContent }),
                ...piNestedToolCallPayload(parentToolCallId),
                ...(codemodeDetails ? { codemodeDetails } : {}),
              },
        }),
      ];
    }

    default:
      return [];
  }
}

function beginMessage(state: PiEventAdapterState): void {
  state.messageSeq += 1;
  state.lastTextIndex = null;
  state.lastThinkingIndex = null;
  state.openText = false;
  state.openThinking = false;
  state.announcedToolWrites.clear();
  state.piToolCallArguments.clear();
  state.piToolWriteTargets.clear();
}

function endMessage(state: PiEventAdapterState): void {
  state.lastTextIndex = null;
  state.lastThinkingIndex = null;
  state.openText = false;
  state.openThinking = false;
  state.announcedToolWrites.clear();
  state.piToolCallArguments.clear();
  state.piToolWriteTargets.clear();
}

/** One tracker per call: it remembers what it has already read out of the arguments. */
function piToolWriteTarget(
  state: PiEventAdapterState,
  writeKey: string,
  toolName: string,
): ToolWriteTargetTracker {
  const existing = state.piToolWriteTargets.get(writeKey);
  if (existing) {
    return existing;
  }
  const created = new ToolWriteTargetTracker(toolName);
  state.piToolWriteTargets.set(writeKey, created);
  return created;
}

/**
 * PI streams a tool call's arguments as `toolcall_delta` JSON fragments, and the live `partial`
 * already holds whatever has accumulated. Keep the longer of the two per call.
 */
function accumulatePiToolCallArguments(
  state: PiEventAdapterState,
  amEvent: Record<string, unknown>,
  contentIndex: number | null,
  id: string | undefined,
): string {
  const key = id ?? `idx:${contentIndex ?? 0}`;
  const previous = state.piToolCallArguments.get(key);
  // Only the call's own JSON text can say whether a value is finished: PI also exposes the
  // partially *parsed* call, where a half-written `src/o` has already become a whole-looking
  // `src`. The raw text is right there in the event, and the fragments rebuild it when it is not.
  const partialJson = readPiToolCallPartialJson(amEvent, contentIndex);
  if (partialJson) {
    state.piToolCallArguments.set(key, { text: partialJson, raw: true });
    return partialJson;
  }
  const delta = typeof amEvent.delta === "string" ? amEvent.delta : "";
  if (delta) {
    const text = `${previous?.raw ? previous.text : ""}${delta}`;
    state.piToolCallArguments.set(key, { text, raw: true });
    return text;
  }
  if (previous) {
    return previous.text;
  }
  const parsed = readPiToolCallParsedArguments(amEvent, contentIndex);
  if (parsed) {
    state.piToolCallArguments.set(key, { text: parsed, raw: false });
  }
  return parsed ?? "";
}

/** `partialJson` is the call's raw JSON text, exactly as the model has written it so far. */
function readPiToolCallPartialJson(
  amEvent: Record<string, unknown>,
  contentIndex: number | null,
): string | undefined {
  for (const candidate of piToolCallCandidates(amEvent, contentIndex)) {
    const partialJson = candidate.partialJson;
    if (typeof partialJson === "string" && partialJson.trim()) {
      return partialJson;
    }
  }
  return undefined;
}

/** The parsed arguments, for a provider that delivers the whole call without partial JSON. */
function readPiToolCallParsedArguments(
  amEvent: Record<string, unknown>,
  contentIndex: number | null,
): string | undefined {
  for (const candidate of piToolCallCandidates(amEvent, contentIndex)) {
    const args = candidate.arguments;
    if (typeof args === "string" && args.trim()) {
      return args;
    }
    if (isRecord(args) && Object.keys(args).length > 0) {
      return JSON.stringify(args);
    }
  }
  return undefined;
}

function piToolCallCandidates(
  amEvent: Record<string, unknown>,
  contentIndex: number | null,
): Record<string, unknown>[] {
  const partial = isRecord(amEvent.partial) ? amEvent.partial : undefined;
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const candidates: unknown[] = [];
  if (contentIndex !== null) {
    candidates.push(content[contentIndex]);
  }
  candidates.push(amEvent.toolCall, ...content);
  return candidates.filter(
    (candidate): candidate is Record<string, unknown> => isRecord(candidate) && candidate.type === "toolCall",
  );
}

function readPiToolCallWrite(
  amEvent: Record<string, unknown>,
  contentIndex: number | null,
): { name: string; id?: string; position: string } | undefined {
  const partial = isRecord(amEvent.partial) ? amEvent.partial : undefined;
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const candidates: unknown[] = [];
  if (contentIndex !== null) {
    candidates.push(content[contentIndex]);
  }
  candidates.push(amEvent.toolCall, ...content);
  for (const candidate of candidates) {
    if (!isRecord(candidate) || candidate.type !== "toolCall") {
      continue;
    }
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name) {
      continue;
    }
    const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : undefined;
    return {
      name,
      ...(id ? { id } : {}),
      position: String(contentIndex ?? content.indexOf(candidate)),
    };
  }
  return undefined;
}

/** First streamed content without message_start (defensive). */
function ensureMessageGeneration(state: PiEventAdapterState): void {
  if (state.messageSeq <= 0) {
    beginMessage(state);
  }
}

function textStreamKey(sessionId: string, state: PiEventAdapterState): string {
  const index = state.lastTextIndex ?? 0;
  return `pi-text:${sessionId}:m${state.messageSeq}:c${index}`;
}

function thinkingStreamKey(sessionId: string, state: PiEventAdapterState): string {
  const index = state.lastThinkingIndex ?? 0;
  return `pi-thinking:${sessionId}:m${state.messageSeq}:c${index}`;
}

function readPiReasoningDisplayStamp(value: unknown): "summary" | "raw" | undefined {
  return value === "summary" || value === "raw" ? value : undefined;
}

/**
 * PI maps both OpenAI reasoning summaries and Anthropic thinking bodies to thinking_delta.
 * Classify from an explicit stamp, else from the session wire — do not default unknown to summary.
 */
function resolvePiThinkingReasoningDisplay(
  amEvent: Record<string, unknown> | undefined,
  ctx: PiEventAdapterContext,
  state: PiEventAdapterState,
): "summary" | "raw" | undefined {
  const fromEvent = readPiReasoningDisplayStamp(amEvent?.reasoningDisplay);
  if (fromEvent) {
    return fromEvent;
  }
  if (state.openThinkingDisplay) {
    return state.openThinkingDisplay;
  }
  if (ctx.apiCompat === "openai_responses") {
    return "summary";
  }
  if (ctx.apiCompat === "anthropic") {
    return "raw";
  }
  return undefined;
}

function stampOpenThinkingDisplay(
  amEvent: Record<string, unknown> | undefined,
  ctx: PiEventAdapterContext,
  state: PiEventAdapterState,
): "summary" | "raw" | undefined {
  const reasoningDisplay = resolvePiThinkingReasoningDisplay(amEvent, ctx, state);
  if (reasoningDisplay) {
    state.openThinkingDisplay = reasoningDisplay;
  }
  return reasoningDisplay;
}

function closeOpenStreams(ctx: PiEventAdapterContext, seq: number, reason: string): AgentEvent[] {
  const state = ctx.state;
  const events: AgentEvent[] = [];
  const base = {
    threadId: ctx.threadId,
    agentId: ctx.sessionId,
    role: "planner" as const,
  };
  if (state.openThinking) {
    const reasoningDisplay =
      state.openThinkingDisplay ?? resolvePiThinkingReasoningDisplay(undefined, ctx, state);
    events.push(
      createAgentEvent({
        id: `${ctx.threadId}:pi:${seq}:think_close:${reason}`,
        ...base,
        type: "message.delta",
        payload: {
          type: "eco_stream",
          blockKind: "thinking",
          text: "",
          ...(reasoningDisplay && { reasoningDisplay }),
          streamFinalize: true,
          stream_block_key: thinkingStreamKey(ctx.sessionId, state),
        },
      }),
    );
    state.openThinking = false;
    state.openThinkingDisplay = undefined;
  }
  if (state.openText) {
    events.push(
      createAgentEvent({
        id: `${ctx.threadId}:pi:${seq}:text_close:${reason}`,
        ...base,
        type: "message.delta",
        payload: {
          type: "eco_stream",
          blockKind: "text",
          text: "",
          streamFinalize: true,
          stream_block_key: textStreamKey(ctx.sessionId, state),
        },
      }),
    );
    state.openText = false;
  }
  return events;
}

function readContentIndex(amEvent: Record<string, unknown>): number | null {
  const value = amEvent.contentIndex ?? amEvent.index;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return null;
}

function usageEventFromAssistantMessage(
  message: unknown,
  ctx: PiEventAdapterContext,
  seq: number,
): AgentEvent | null {
  if (!isAssistantMessage(message)) {
    return null;
  }
  const modelId = typeof message.model === "string" ? message.model : undefined;
  const usage = parsePiUsage(message.usage, modelId);
  if (!usage) {
    return null;
  }
  return createAgentEvent({
    id: `${ctx.threadId}:pi:${seq}:usage`,
    threadId: ctx.threadId,
    agentId: ctx.sessionId,
    role: "planner",
    type: "usage.recorded",
    payload: {
      source: "pi",
      usage: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        cache_read_input_tokens: usage.cacheReadTokens,
        cache_creation_input_tokens: usage.cacheCreationTokens,
      },
      ...(usage.totalCostUsd !== undefined && { total_cost_usd: usage.totalCostUsd }),
      ...(usage.modelId && { model: usage.modelId }),
    },
  });
}

function isAssistantMessage(value: unknown): value is {
  role: "assistant";
  content?: unknown;
  usage?: unknown;
  model?: string;
} {
  return isRecord(value) && value.role === "assistant";
}

function extractAssistantText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function extractAssistantThinking(message: { content?: unknown }): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("");
}

/**
 * PI sets `parentToolCallId` when another tool issued this call — today only the
 * codemode sandbox does (`tools["…"](…)`), which also gets the id `<parent id>/<n>`.
 *
 * The link is preserved under `parent_tool_call_id`, deliberately NOT under
 * `parent_tool_use_id`: that key is Eco's subagent-ownership link everywhere it is
 * read (thread-run-event scope, owner-agent resolution, usage attribution), so a
 * nested codemode call carrying it would be treated as a subagent row — the
 * runtime projection resolves no agent for it and drops the row from the timeline.
 */
function readPiParentToolCallId(event: PiSessionEventLike): string | undefined {
  const raw = event.parentToolCallId;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function piNestedToolCallPayload(parentToolCallId: string | undefined): Record<string, unknown> {
  return parentToolCallId ? { parent_tool_call_id: parentToolCallId } : {};
}

/**
 * PI tools may return `structuredContent` beside their text `content` (e.g. bash's
 * exit_code / truncation / full_output_path). It is not rendered in the Feed, but
 * dropping it loses the machine-readable half of the result, so it rides along the
 * same way the Claude adapter carries it.
 */
function readPiStructuredContent(result: unknown): unknown {
  if (!isRecord(result)) {
    return undefined;
  }
  return result.structuredContent;
}

/**
 * PI's codemode reports the calls its script made, plus the temp file holding untruncated output,
 * in the tool result's `details` (`CodemodeToolDetails`). `formatToolResult` keeps only the text,
 * so without this the script's card loses the calls that never produced their own tool event —
 * calls cancelled when the script ended — and the pointer to the full output.
 *
 * Keyed on `details.calls` rather than the tool name: PI assigns each nested call the id of the
 * tool event it caused, which is how the Feed tells these rows apart from the script's own.
 */
function readPiCodemodeDetails(result: unknown): unknown {
  if (!isRecord(result) || !isRecord(result.details) || !Array.isArray(result.details.calls)) {
    return undefined;
  }
  return result.details;
}

function formatToolResult(result: unknown): string {
  if (result === undefined || result === null) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  // Eco Integrated web_search returns `{ content, details: { provider, query, results } }`.
  // Prefer structured JSON for Feed SERP cards (Claude/Codex MCP path already stores this shape).
  if (isRecord(result) && isRecord(result.details) && Array.isArray(result.details.results)) {
    try {
      return JSON.stringify({
        ...(typeof result.details.provider === "string" ? { provider: result.details.provider } : {}),
        ...(typeof result.details.query === "string" ? { query: result.details.query } : {}),
        resultCount: result.details.results.length,
        results: result.details.results,
      });
    } catch {
      // fall through to text content
    }
  }
  if (isRecord(result) && Array.isArray(result.content)) {
    const texts = result.content
      .filter((part): part is { type: string; text?: string } => isRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string);
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function normalizePiToolUseInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== "Agent") {
    return input;
  }
  const agent =
    (typeof input.agent === "string" && input.agent.trim()) ||
    (typeof input.agent_type === "string" && input.agent_type.trim()) ||
    (typeof input.subagent_type === "string" && input.subagent_type.trim()) ||
    "";
  if (!agent) {
    return input;
  }
  return {
    ...input,
    agent,
    ...(typeof input.agent_type !== "string" && { agent_type: agent }),
    ...(typeof input.subagent_type !== "string" && { subagent_type: agent }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
