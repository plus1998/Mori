import {
  type AgentEvent,
  createAgentEvent,
  type RuntimeAgentRole,
  ToolWriteTargetTracker,
} from "../../shared/src";
import { tryParseSerializedAnthropicContentBlocks } from "./anthropic-content-normalize.js";
import { SDK_GENERAL_PURPOSE_AGENT_KEY, SDK_PLAN_AGENT_KEY } from "./subagent-availability.js";
import { normalizeSdkSubagentType } from "./subagent-resume.js";

export type EcoStreamBlockKind = "text" | "thinking" | "tool_use";

/** Mutable state for one SDK query session while partial messages stream. */
export interface SdkStreamContext {
  inToolBlock: boolean;
  activeBlockKind: EcoStreamBlockKind | null;
  currentToolUseId?: string;
  currentToolName?: string;
  currentToolInputJson: string;
  parentToolUseId: string | null;
  activeSubagentRole?: RuntimeAgentRole;
  /** Remembers each subagent's role so interleaved parallel streams keep correct roles. */
  subagentRoleByParentToolUseId: Map<string, RuntimeAgentRole>;
  /** Subagent instance ids registered from SubagentStart before stream parent_tool_use_id arrives. */
  registeredSubagentByParentToolUseId: Map<string, string>;
  /** Exact Anthropic assistant message id observed from message_start. */
  currentMessageId?: string;
  activeBlockIndex?: number;
  emittedStreamBlockKeys: Set<string>;
  emittedToolUseIds: Set<string>;
  /** Target already announced for the tool call being written, so it is said once. */
  announcedToolWriteTarget?: string;
  /** Reads that target out of the arguments without re-reading them on every fragment. */
  toolWriteTarget?: ToolWriteTargetTracker;
  toolUseById: Map<string, { name: string; input?: Record<string, unknown> }>;
  resolveSubagentAgentId?: (input: {
    role: RuntimeAgentRole;
    parentToolUseId?: string;
    sessionId: string;
  }) => string | undefined;
}

export function createSdkStreamContext(options?: {
  resolveSubagentAgentId?: SdkStreamContext["resolveSubagentAgentId"];
}): SdkStreamContext {
  return {
    inToolBlock: false,
    activeBlockKind: null,
    currentToolInputJson: "",
    parentToolUseId: null,
    subagentRoleByParentToolUseId: new Map(),
    registeredSubagentByParentToolUseId: new Map(),
    emittedStreamBlockKeys: new Set(),
    emittedToolUseIds: new Set(),
    toolUseById: new Map(),
    ...(options?.resolveSubagentAgentId && { resolveSubagentAgentId: options.resolveSubagentAgentId }),
  };
}

/** Seed stream attribution from PreToolUse / SubagentStart before SDK stream carries parent_tool_use_id. */
export function registerSubagentOnStreamContext(
  streamCtx: SdkStreamContext,
  input: { role: RuntimeAgentRole; agentId?: string; parentToolUseId?: string },
): void {
  const agentId = input.agentId?.trim();
  const parentToolUseId = input.parentToolUseId?.trim();
  if (!agentId && !parentToolUseId) {
    return;
  }
  streamCtx.activeSubagentRole = input.role;
  if (parentToolUseId) {
    streamCtx.subagentRoleByParentToolUseId.set(parentToolUseId, input.role);
    streamCtx.parentToolUseId = parentToolUseId;
    if (agentId) {
      streamCtx.registeredSubagentByParentToolUseId.set(parentToolUseId, agentId);
    }
  }
}

export function createAttributedAgentEvent(
  input: {
    id: string;
    threadId: string;
    sessionId: string;
    role: RuntimeAgentRole;
    type: AgentEvent["type"];
    payload: Record<string, unknown>;
    messageParentToolUseId?: string | null;
  },
  streamCtx?: SdkStreamContext,
): AgentEvent {
  const attributed = applySubagentUsageAttribution(
    {
      role: input.role,
      sessionId: input.sessionId,
      payload: input.payload,
      ...(input.messageParentToolUseId !== undefined
        ? { messageParentToolUseId: input.messageParentToolUseId }
        : {}),
    },
    streamCtx,
  );
  return createAgentEvent({
    id: input.id,
    threadId: input.threadId,
    agentId: attributed.agentId,
    role: input.role,
    type: input.type,
    payload: attributed.payload,
  });
}

/** Attach subagent agent_id to usage events when desktop attribution resolver is wired.
 * Canonical instance id is SubagentStart.agent_id (≡ x-claude-code-agent-id when present).
 * Never treat planner sessionId as a subagent instance when a parent_tool_use_id join exists
 * and a registered/resolved instance id is available.
 */
export function applySubagentUsageAttribution(
  input: {
    role: RuntimeAgentRole;
    sessionId: string;
    payload: Record<string, unknown>;
    /**
     * parent_tool_use_id carried by the SDK message itself. A string marks subagent usage;
     * null marks main-session usage and must never inherit a stale subagent stream context.
     * Omit only for legacy callers that have no message-level signal.
     */
    messageParentToolUseId?: string | null;
  },
  streamCtx?: SdkStreamContext,
): { agentId: string; payload: Record<string, unknown> } {
  const explicit = input.messageParentToolUseId;
  if (explicit === null) {
    return { agentId: input.sessionId, payload: input.payload };
  }
  const parentFromPayload =
    typeof input.payload.parent_tool_use_id === "string" ? input.payload.parent_tool_use_id.trim() : "";
  const attributionRole = explicit !== undefined ? input.role : (streamCtx?.activeSubagentRole ?? input.role);
  const parentToolUseId = (typeof explicit === "string" && explicit.trim()) || parentFromPayload || undefined;

  const payloadAgentId =
    (typeof input.payload.subagentAgentId === "string" && input.payload.subagentAgentId.trim()) ||
    (typeof input.payload.agent_id === "string" && input.payload.agent_id.trim()) ||
    undefined;

  const registeredAgentId =
    parentToolUseId && streamCtx?.registeredSubagentByParentToolUseId.get(parentToolUseId);
  if (registeredAgentId) {
    return {
      agentId: registeredAgentId,
      payload: {
        ...input.payload,
        subagentAgentId: registeredAgentId,
        ...(parentToolUseId && { parent_tool_use_id: parentToolUseId }),
      },
    };
  }

  const subagentAgentId =
    (parentToolUseId
      ? streamCtx?.resolveSubagentAgentId?.({
          role: attributionRole,
          sessionId: input.sessionId,
          parentToolUseId,
        })
      : undefined) ||
    // Explicit Claude instance id on the message — only when this is subagent-scoped.
    (parentToolUseId && payloadAgentId && payloadAgentId !== input.sessionId ? payloadAgentId : undefined);
  if (!subagentAgentId) {
    // Keep parent_tool_use_id on the payload so downstream billing can still attribute the
    // usage to a subagent instance when runtime-side resolution is unavailable or ambiguous.
    // agentId stays sessionId as a fail-closed sentinel; desktop filters it for Feed cards.
    return {
      agentId: input.sessionId,
      payload: parentToolUseId ? { ...input.payload, parent_tool_use_id: parentToolUseId } : input.payload,
    };
  }
  return {
    agentId: subagentAgentId,
    payload: {
      ...input.payload,
      subagentAgentId,
      ...(parentToolUseId && { parent_tool_use_id: parentToolUseId }),
    },
  };
}

export type EcoStreamPayload =
  | {
      type: "eco_stream";
      blockKind: "text" | "thinking";
      text?: string;
      streamPlaceholder?: boolean;
      streamFinalize?: boolean;
      stream_block_key?: string;
      parent_tool_use_id?: string | null;
      subagent_type?: string;
      agent_type?: string;
      messageId?: string;
    }
  | {
      type: "tool_use";
      tool_name: string;
      tool_use_id?: string;
      input?: Record<string, unknown>;
      streaming?: boolean;
      input_complete?: boolean;
      /** The file or command the call names, known before its arguments are complete. */
      tool_input_target?: string;
      parent_tool_use_id?: string | null;
      subagent_type?: string;
      agent_type?: string;
      messageId?: string;
    };

export function slimStreamEventMessage(message: Record<string, unknown>): Record<string, unknown> {
  const parentToolUseId = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
  const subagentType = typeof message.subagent_type === "string" ? message.subagent_type : undefined;
  const agentType = typeof message.agent_type === "string" ? message.agent_type : undefined;
  const userMessageUuid =
    typeof message.user_message_uuid === "string" && message.user_message_uuid.trim()
      ? message.user_message_uuid.trim()
      : undefined;
  const userMessageUuids = Array.isArray(message.user_message_uuids)
    ? message.user_message_uuids
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : undefined;
  const event = isRecord(message.event) ? message.event : null;
  if (!event) {
    return {
      type: "stream_event",
      ...(parentToolUseId && { parent_tool_use_id: parentToolUseId }),
      ...(subagentType && { subagent_type: subagentType }),
      ...(agentType && { agent_type: agentType }),
      ...(userMessageUuid && { user_message_uuid: userMessageUuid }),
      ...(userMessageUuids && userMessageUuids.length > 0 && { user_message_uuids: userMessageUuids }),
    };
  }
  return {
    type: "stream_event",
    event: slimRawStreamEvent(event),
    ...(parentToolUseId && { parent_tool_use_id: parentToolUseId }),
    ...(subagentType && { subagent_type: subagentType }),
    ...(agentType && { agent_type: agentType }),
    ...(userMessageUuid && { user_message_uuid: userMessageUuid }),
    ...(userMessageUuids && userMessageUuids.length > 0 && { user_message_uuids: userMessageUuids }),
  };
}

function slimRawStreamEvent(event: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = { type: event.type };
  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    slim.delta = event.delta;
  }
  if (event.type === "content_block_start" && isRecord(event.content_block)) {
    slim.content_block = event.content_block;
  }
  if (event.type === "message_delta" && isRecord(event.usage)) {
    slim.usage = event.usage;
  }
  if (event.type === "message_delta" && event.delta !== undefined) {
    slim.delta = event.delta;
  }
  return slim;
}

function readMessageSubagentRole(message: Record<string, unknown>): RuntimeAgentRole | undefined {
  const subagentType = typeof message.subagent_type === "string" ? message.subagent_type : undefined;
  const agentType = typeof message.agent_type === "string" ? message.agent_type : undefined;
  const subagentRole = subagentType ? normalizeSdkRuntimeAgentRole(subagentType) : undefined;
  const agentRole = agentType ? normalizeSdkRuntimeAgentRole(agentType) : undefined;
  return subagentRole ?? agentRole;
}

function normalizeSdkRuntimeAgentRole(type: string): RuntimeAgentRole | undefined {
  const trimmed = type.trim();
  if (trimmed === SDK_GENERAL_PURPOSE_AGENT_KEY || trimmed === SDK_PLAN_AGENT_KEY) {
    return trimmed;
  }
  return normalizeSdkSubagentType(trimmed);
}

function effectiveStreamRole(ctx: SdkStreamContext, fallback: RuntimeAgentRole): RuntimeAgentRole {
  return ctx.activeSubagentRole ?? fallback;
}

export function mapStreamEventToEvents(
  message: Record<string, unknown>,
  threadId: string,
  sessionId: string,
  role: RuntimeAgentRole,
  uuid: string,
  ctx: SdkStreamContext,
): AgentEvent[] {
  const parentToolUseId = typeof message.parent_tool_use_id === "string" ? message.parent_tool_use_id : null;
  ctx.parentToolUseId = parentToolUseId;

  const messageRole = readMessageSubagentRole(message);
  if (parentToolUseId) {
    if (messageRole) {
      ctx.subagentRoleByParentToolUseId.set(parentToolUseId, messageRole);
    }
    const resolvedRole = messageRole ?? ctx.subagentRoleByParentToolUseId.get(parentToolUseId);
    if (resolvedRole) {
      ctx.activeSubagentRole = resolvedRole;
    } else {
      delete ctx.activeSubagentRole;
    }
  } else if (messageRole) {
    ctx.activeSubagentRole = messageRole;
  } else {
    // Messages with no subagent marker belong to the main session; clear subagent context
    // so interleaved main-agent output is not attributed to the last streaming subagent.
    delete ctx.activeSubagentRole;
  }
  const streamRole = effectiveStreamRole(ctx, role);

  const subagentType = typeof message.subagent_type === "string" ? message.subagent_type : undefined;
  const agentType = typeof message.agent_type === "string" ? message.agent_type : undefined;
  const event = isRecord(message.event) ? message.event : null;
  if (!event || typeof event.type !== "string") {
    return [];
  }

  if (event.type === "message_start" && isRecord(event.message)) {
    const messageId = typeof event.message.id === "string" ? event.message.id.trim() : "";
    if (messageId) {
      ctx.currentMessageId = messageId;
    } else {
      delete ctx.currentMessageId;
    }
    return [];
  }

  const events: AgentEvent[] = [];
  const streamMeta = {
    ...(parentToolUseId && { parent_tool_use_id: parentToolUseId }),
    ...(subagentType && { subagent_type: subagentType }),
    ...(agentType && { agent_type: agentType }),
    ...(ctx.currentMessageId && { messageId: ctx.currentMessageId }),
  };

  if (event.type === "content_block_start" && isRecord(event.content_block)) {
    const block = event.content_block;
    const blockType = block.type;
    const blockIndex = readStreamEventIndex(event);
    if (blockIndex !== undefined) {
      ctx.activeBlockIndex = blockIndex;
    } else {
      delete ctx.activeBlockIndex;
    }
    if (blockType === "tool_use" && typeof block.name === "string") {
      ctx.inToolBlock = true;
      ctx.activeBlockKind = "tool_use";
      ctx.currentToolName = block.name;
      if (typeof block.id === "string") {
        ctx.currentToolUseId = block.id;
      } else {
        delete ctx.currentToolUseId;
      }
      ctx.currentToolInputJson = "";
      delete ctx.announcedToolWriteTarget;
      ctx.toolWriteTarget = new ToolWriteTargetTracker(block.name);
      if (ctx.currentToolUseId) {
        ctx.emittedToolUseIds.add(ctx.currentToolUseId);
        ctx.toolUseById.set(ctx.currentToolUseId, { name: block.name });
      }
      events.push(
        createToolStartedEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "tool_use",
            tool_name: block.name,
            ...(ctx.currentToolUseId && { tool_use_id: ctx.currentToolUseId }),
            streaming: true,
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      );
      return events;
    }
    if (blockType === "thinking") {
      ctx.inToolBlock = false;
      ctx.activeBlockKind = "thinking";
      events.push(
        createStreamDeltaEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "eco_stream",
            blockKind: "thinking",
            streamPlaceholder: true,
            ...streamBlockMetadata("thinking", event, ctx),
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      );
      return events;
    }
    if (blockType === "text") {
      ctx.inToolBlock = false;
      ctx.activeBlockKind = "text";
      events.push(
        createStreamDeltaEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "eco_stream",
            blockKind: "text",
            streamPlaceholder: true,
            ...streamBlockMetadata("text", event, ctx),
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      );
      return events;
    }
    return events;
  }

  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    const delta = event.delta;
    if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      ctx.currentToolInputJson += delta.partial_json;
      // The arguments name their file (or command) within the first fragments; the Feed can
      // say which one instead of only「正在写入文件」for the whole write.
      const tracker = ctx.toolWriteTarget ?? new ToolWriteTargetTracker(ctx.currentToolName ?? "");
      ctx.toolWriteTarget = tracker;
      const target = tracker.observe(ctx.currentToolInputJson);
      if (!target || target === ctx.announcedToolWriteTarget) {
        return events;
      }
      ctx.announcedToolWriteTarget = target;
      return [
        createToolStartedEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "tool_use",
            tool_name: ctx.currentToolName ?? "",
            ...(ctx.currentToolUseId && { tool_use_id: ctx.currentToolUseId }),
            streaming: true,
            tool_input_target: target,
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      ];
    }
    if (ctx.inToolBlock && delta.type === "text_delta") {
      return events;
    }
    if (delta.type === "text_delta" && typeof delta.text === "string") {
      const text = delta.text;
      if (!text) {
        return events;
      }
      const embedded = tryParseSerializedAnthropicContentBlocks(text);
      if (embedded) {
        for (const [index, block] of embedded.entries()) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            events.push(
              createStreamDeltaEvent(
                threadId,
                sessionId,
                streamRole,
                uuid,
                {
                  type: "eco_stream",
                  blockKind: "text",
                  text: block.text,
                  streamFinalize: true,
                  stream_block_key: `embedded:text:${index}`,
                  ...streamMeta,
                },
                ctx,
                parentToolUseId,
              ),
            );
          } else if (
            block.type === "thinking" &&
            typeof block.thinking === "string" &&
            block.thinking.trim()
          ) {
            events.push(
              createStreamDeltaEvent(
                threadId,
                sessionId,
                streamRole,
                uuid,
                {
                  type: "eco_stream",
                  blockKind: "thinking",
                  text: block.thinking,
                  streamFinalize: true,
                  stream_block_key: `embedded:thinking:${index}`,
                  ...streamMeta,
                },
                ctx,
                parentToolUseId,
              ),
            );
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const toolUseId = typeof block.id === "string" ? block.id : undefined;
            if (toolUseId && ctx.emittedToolUseIds.has(toolUseId)) {
              continue;
            }
            if (toolUseId) {
              ctx.emittedToolUseIds.add(toolUseId);
              ctx.toolUseById.set(toolUseId, {
                name: block.name,
                ...(isRecord(block.input) && { input: block.input }),
              });
            }
            events.push(
              createToolStartedEvent(
                threadId,
                sessionId,
                streamRole,
                `${uuid}:embedded:${index}`,
                {
                  type: "tool_use",
                  tool_name: block.name,
                  ...(toolUseId && { tool_use_id: toolUseId }),
                  ...(isRecord(block.input) && { input: block.input }),
                  ...streamMeta,
                },
                ctx,
                parentToolUseId,
              ),
            );
          }
        }
        return events;
      }
      events.push(
        createStreamDeltaEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "eco_stream",
            blockKind: "text",
            text,
            ...streamBlockMetadata("text", event, ctx),
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      );
      return events;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
      const thinking = delta.thinking;
      if (!thinking) {
        return events;
      }
      events.push(
        createStreamDeltaEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "eco_stream",
            blockKind: "thinking",
            text: thinking,
            ...streamBlockMetadata("thinking", event, ctx),
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      );
      return events;
    }
    return events;
  }

  if (event.type === "content_block_stop") {
    if (ctx.inToolBlock) {
      const parsedInput = parseToolInputJson(ctx.currentToolInputJson);
      if (ctx.currentToolName) {
        if (ctx.currentToolUseId) {
          ctx.toolUseById.set(ctx.currentToolUseId, {
            name: ctx.currentToolName,
            ...(parsedInput && { input: parsedInput }),
          });
        }
        events.push(
          createToolStartedEvent(
            threadId,
            sessionId,
            streamRole,
            uuid,
            {
              type: "tool_use",
              tool_name: ctx.currentToolName,
              ...(ctx.currentToolUseId && { tool_use_id: ctx.currentToolUseId }),
              ...(parsedInput && { input: parsedInput }),
              streaming: true,
              input_complete: true,
              ...streamMeta,
            },
            ctx,
            parentToolUseId,
          ),
        );
      }
    } else if (ctx.activeBlockKind === "thinking") {
      events.push(
        createStreamDeltaEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "eco_stream",
            blockKind: "thinking",
            streamFinalize: true,
            ...streamBlockMetadata("thinking", event, ctx),
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      );
    } else if (ctx.activeBlockKind === "text") {
      events.push(
        createStreamDeltaEvent(
          threadId,
          sessionId,
          streamRole,
          uuid,
          {
            type: "eco_stream",
            blockKind: "text",
            streamFinalize: true,
            ...streamBlockMetadata("text", event, ctx),
            ...streamMeta,
          },
          ctx,
          parentToolUseId,
        ),
      );
    }
    ctx.inToolBlock = false;
    ctx.activeBlockKind = null;
    delete ctx.activeBlockIndex;
    delete ctx.currentToolName;
    delete ctx.currentToolUseId;
    delete ctx.announcedToolWriteTarget;
    delete ctx.toolWriteTarget;
    ctx.currentToolInputJson = "";
    return events;
  }

  if (event.type === "message_delta" && isRecord(event.usage)) {
    // A message carrying subagent_type but no parent id is still explicitly subagent usage;
    // only messages with neither marker are main-session usage (null short-circuits).
    const attributed = applySubagentUsageAttribution(
      {
        role: streamRole,
        sessionId,
        payload: { usage: event.usage, ...(ctx.currentMessageId && { messageId: ctx.currentMessageId }) },
        ...(parentToolUseId != null
          ? { messageParentToolUseId: parentToolUseId }
          : messageRole
            ? {}
            : { messageParentToolUseId: null }),
      },
      ctx,
    );
    events.push(
      createAgentEvent({
        id: `${uuid}:stream-usage`,
        threadId,
        agentId: attributed.agentId,
        role: streamRole,
        type: "usage.recorded",
        payload: attributed.payload,
      }),
    );
  }

  if (event.type === "message_stop") {
    delete ctx.currentMessageId;
  }

  return events;
}

function readStreamEventIndex(event: Record<string, unknown>): number | undefined {
  const index = event.index;
  if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
    return index;
  }
  return undefined;
}

function streamBlockMetadata(
  kind: "text" | "thinking",
  event: Record<string, unknown>,
  ctx: SdkStreamContext,
): { stream_block_key?: string } {
  const index = readStreamEventIndex(event) ?? ctx.activeBlockIndex;
  if (index === undefined) {
    return {};
  }
  const key = ctx.currentMessageId ? `${ctx.currentMessageId}:${kind}:${index}` : `${kind}:${index}`;
  ctx.emittedStreamBlockKeys.add(key);
  return { stream_block_key: key };
}

function createStreamDeltaEvent(
  threadId: string,
  sessionId: string,
  role: RuntimeAgentRole,
  uuid: string,
  payload: EcoStreamPayload & { type: "eco_stream" },
  streamCtx: SdkStreamContext,
  messageParentToolUseId?: string | null,
): AgentEvent {
  return createAttributedAgentEvent(
    {
      id: `${uuid}:stream`,
      threadId,
      sessionId,
      role,
      type: "message.delta",
      payload: payload as Record<string, unknown>,
      ...(messageParentToolUseId !== undefined ? { messageParentToolUseId } : {}),
    },
    streamCtx,
  );
}

function createToolStartedEvent(
  threadId: string,
  sessionId: string,
  role: RuntimeAgentRole,
  uuid: string,
  payload: EcoStreamPayload & { type: "tool_use" },
  streamCtx: SdkStreamContext,
  messageParentToolUseId?: string | null,
): AgentEvent {
  const toolUseId = payload.tool_use_id;
  return createAttributedAgentEvent(
    {
      id: `${uuid}:tool:${toolUseId ?? payload.tool_name}`,
      threadId,
      sessionId,
      role,
      type: "tool.started",
      payload: payload as Record<string, unknown>,
      ...(messageParentToolUseId !== undefined ? { messageParentToolUseId } : {}),
    },
    streamCtx,
  );
}

export function isEcoStreamPayload(payload: unknown): payload is EcoStreamPayload {
  if (!isRecord(payload)) {
    return false;
  }
  if (payload.type === "eco_stream") {
    return payload.blockKind === "text" || payload.blockKind === "thinking";
  }
  if (payload.type === "tool_use") {
    return typeof payload.tool_name === "string";
  }
  return false;
}

export function isEcoStreamPlaceholder(payload: unknown): boolean {
  return isRecord(payload) && payload.type === "eco_stream" && payload.streamPlaceholder === true;
}

export function isEcoStreamFinalize(payload: unknown): boolean {
  return isRecord(payload) && payload.type === "eco_stream" && payload.streamFinalize === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolInputJson(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
