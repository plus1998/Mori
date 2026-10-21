import { randomUUID } from "node:crypto";
import { type AgentEvent, createAgentEvent } from "../../shared/src";
import {
  type AcpTaskRequest,
  formatAcpCursorSubagentType,
  parseAcpTaskRequest,
  parseAcpUpdateTodosRequest,
} from "./acp-cursor-extensions.js";
import { isAcpUnstartedProviderFailure, splitAcpProviderExhaustion } from "./acp-provider-exhaustion.js";

type JsonRecord = Record<string, unknown>;

export type AcpMappedTool = {
  tool_name: string;
  input: Record<string, unknown>;
};

export type AcpOpenSubagent = {
  toolCallId: string;
  /** Synthetic Eco agent id so Cards/Feed can own a subagent timeline. */
  agentId: string;
  subagentType: string;
  task: string;
};

/** Prefix for synthetic Eco agent ids minted for Cursor ACP nested Agent/Task calls. */
export const ACP_SUBAGENT_AGENT_ID_PREFIX = "acp-sub:";

/** Stable agent id for an ACP nested Agent/Task tool call. */
export function acpSubagentAgentId(toolCallId: string): string {
  return `${ACP_SUBAGENT_AGENT_ID_PREFIX}${toolCallId}`;
}

/** True when this agent id was minted for a Cursor ACP nested subagent. */
export function isAcpSubagentAgentId(agentId: string | undefined | null): boolean {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  return id.startsWith(ACP_SUBAGENT_AGENT_ID_PREFIX);
}

export type AcpEventMapContext = {
  threadId: string;
  agentId: string;
  sessionRunId: string;
  /** Remember start payloads so tool_call_update completed can emit Eco tool_result. */
  tools?: Map<string, AcpMappedTool>;
  /**
   * Accumulated `agent_message_chunk` text for the current prompt turn.
   * Used so `end_turn` with only a RetriableError envelope becomes `run.terminal` failed.
   */
  agentMessageText?: { value: string };
  /** Whether this prompt turn produced tools or thinking before it failed. */
  turnProgress?: { tools: boolean; thoughts: boolean };
  /**
   * Open Agent/Task subagent tool calls keyed by toolCallId.
   * Used to stream subagent output (tool_call_update content) as message.delta
   * attributed to the parent tool via `parent_tool_use_id`.
   */
  openSubagents?: Map<string, AcpOpenSubagent>;
};

function readSubagentOutputText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((entry) => readSubagentOutputText(entry))
      .filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (!isRecord(content)) return undefined;
  if (content.type === "text" && typeof content.text === "string") return content.text;
  // ACP content blocks: { type: "content", content: { type: "text", text } }
  if (content.type === "content") {
    return readSubagentOutputText(content.content);
  }
  // Some agents stream output as { type: "output", content: "..." }.
  if (typeof content.content === "string") return content.content;
  if (typeof content.output === "string") return content.output;
  if (typeof content.text === "string") return content.text;
  return undefined;
}

/**
 * Map ACP `session/update` params (or prompt `stopReason` result) → Eco AgentEvent[].
 *
 * Cursor `agent acp` (2026.08.11-e8db854) notifies:
 * `{ sessionId, update: { sessionUpdate, ... } }`.
 * Turn end is on `session/prompt` result `{ stopReason }`, not on session/update.
 */
export function mapAcpSessionUpdate(params: unknown, ctx: AcpEventMapContext): AgentEvent[] {
  const base = { threadId: ctx.threadId, agentId: ctx.agentId, role: "main" as const };
  const id = `${ctx.threadId}:acp:${ctx.sessionRunId}:${randomUUID()}`;

  if (!isRecord(params)) {
    return [rawOutput(id, base, params)];
  }

  // Prompt RPC result — Cursor does not emit end via session/update.
  if (typeof params.stopReason === "string" && !isRecord(params.update)) {
    return [mapStopReason(id, base, params.stopReason, params, ctx)];
  }

  const update = isRecord(params.update) ? params.update : undefined;
  const kind = update && typeof update.sessionUpdate === "string" ? update.sessionUpdate : undefined;

  // Eco already persisted the user prompt; load replay also emits these.
  if (kind === "user_message_chunk" || kind === "available_commands_update") {
    return [];
  }

  if (kind === "session_info_update") {
    const title = typeof update?.title === "string" ? update.title.trim() : "";
    return title
      ? [
          createAgentEvent({
            id,
            ...base,
            type: "session.title",
            payload: { title },
          }),
        ]
      : [];
  }

  if (kind === "agent_message_chunk") {
    const text = readContentText(update?.content);
    if (!text) {
      return [];
    }
    if (ctx.agentMessageText) {
      ctx.agentMessageText.value = `${ctx.agentMessageText.value}${text}`;
    }
    return [
      createAgentEvent({
        id,
        ...base,
        type: "message.delta",
        payload: ecoStreamPayload({ text, raw: params, messageId: readMessageId(update) }),
      }),
    ];
  }

  if (kind === "agent_thought_chunk") {
    const text = readContentText(update?.content);
    if (text && ctx.turnProgress) {
      ctx.turnProgress.thoughts = true;
    }
    return text
      ? [
          createAgentEvent({
            id,
            ...base,
            type: "message.delta",
            payload: ecoStreamPayload({
              text,
              raw: params,
              blockKind: "thinking",
              messageId: readMessageId(update),
            }),
          }),
        ]
      : [];
  }

  if (kind === "tool_call") {
    const toolCallId = typeof update?.toolCallId === "string" ? update.toolCallId : undefined;
    const mapped = mapAcpToolStart(update);
    const openSubagent = toolCallId ? ctx.openSubagents?.get(toolCallId) : undefined;
    if (toolCallId && ctx.tools) {
      ctx.tools.set(toolCallId, openSubagent ? { tool_name: "Agent", input: mapped.input } : mapped);
    }
    if (ctx.turnProgress) {
      ctx.turnProgress.tools = true;
    }
    // Subagent Cards are opened by `cursor/task`. If already registered, skip a
    // second tool.started so the feed does not duplicate the parent tool row.
    if (openSubagent) {
      return [];
    }
    return [
      createAgentEvent({
        id,
        ...base,
        type: "tool.started",
        payload: {
          type: "tool_use",
          tool_name: mapped.tool_name,
          ...(toolCallId && { tool_use_id: toolCallId }),
          input: mapped.input,
          raw: params,
        },
      }),
    ];
  }

  if (kind === "tool_call_update") {
    const status = typeof update?.status === "string" ? update.status : undefined;
    const toolCallId = typeof update?.toolCallId === "string" ? update.toolCallId : undefined;
    const openSubagent = toolCallId ? ctx.openSubagents?.get(toolCallId) : undefined;
    const subagentBase = openSubagent
      ? {
          threadId: ctx.threadId,
          agentId: openSubagent.agentId,
          role: "general-purpose" as const,
        }
      : base;

    // Stream subagent in-progress output onto the synthetic subagent agentId so
    // Cards/Feed own a real timeline (parent_tool_use_id alone is not enough).
    if (openSubagent && (status === "in_progress" || status === "pending")) {
      const text = readSubagentOutputText(update?.content);
      if (text) {
        return [
          createAgentEvent({
            id,
            ...subagentBase,
            type: "message.delta",
            payload: ecoStreamPayload({
              text,
              raw: params,
              blockKind: "subagent_output",
              messageId: readMessageId(update),
              liveType: "acp.subagent_output",
              parent_tool_use_id: toolCallId,
            }),
          }),
        ];
      }
      return [];
    }

    if (status === "in_progress" || status === "pending") {
      return [];
    }

    const started = toolCallId ? ctx.tools?.get(toolCallId) : undefined;
    const tool_name = started?.tool_name ?? mapAcpToolName(update);
    // Prefer update fields (incl. late-arriving ACP diff content) over the
    // snapshot from tool_call start — Cursor often streams diffs on complete.
    const input = {
      ...(started?.input ?? {}),
      ...resolveAcpToolInput(update),
    };
    const failed = status === "failed";

    // Close the subagent on terminal status so attribution stops.
    if (openSubagent && ctx.openSubagents) {
      ctx.openSubagents.delete(toolCallId!);
    }
    const subagentOutput = openSubagent
      ? (readSubagentOutputText(update?.content) ?? readSubagentOutputText(update?.rawOutput))
      : undefined;
    const events: AgentEvent[] = [
      createAgentEvent({
        id,
        ...base,
        type: failed ? "tool.failed" : "tool.completed",
        payload: failed
          ? {
              type: "tool_result_error",
              tool_name: openSubagent ? "Agent" : tool_name,
              ...(toolCallId && { tool_use_id: toolCallId }),
              input,
              content: update?.content ?? update?.rawOutput,
              ...(openSubagent ? { subagent_output: subagentOutput ?? null } : {}),
              raw: params,
            }
          : {
              type: "tool_result",
              tool_name: openSubagent ? "Agent" : tool_name,
              ...(toolCallId && { tool_use_id: toolCallId }),
              input,
              content: update?.content ?? update?.rawOutput,
              ...(openSubagent ? { subagent_output: subagentOutput ?? null } : {}),
              raw: params,
            },
      }),
    ];
    if (openSubagent) {
      if (subagentOutput) {
        events.push(
          createAgentEvent({
            id: `${id}:subagent-output`,
            ...subagentBase,
            type: "message.delta",
            payload: ecoStreamPayload({
              text: subagentOutput,
              raw: params,
              blockKind: "subagent_output",
              messageId: readMessageId(update),
              liveType: "acp.subagent_output",
              parent_tool_use_id: toolCallId,
            }),
          }),
        );
      }
      events.push(
        createAgentEvent({
          id: `${id}:agent-completed`,
          ...subagentBase,
          type: "agent.completed",
          payload: {
            source: "acp",
            parentToolUseId: toolCallId,
            ...(failed ? { failed: true, error: update?.content ?? update?.rawOutput } : {}),
            raw: params,
          },
        }),
      );
    }
    return events;
  }

  if (kind === "current_mode_update") {
    const modeId = typeof update?.currentModeId === "string" ? update.currentModeId.trim() : "";
    return modeId
      ? [
          createAgentEvent({
            id,
            ...base,
            type: "terminal.output",
            payload: {
              source: "acp",
              liveType: "acp.current_mode_update",
              currentModeId: modeId,
              raw: params,
            },
          }),
        ]
      : [];
  }

  if (kind === "plan") {
    const entries = Array.isArray(update?.entries) ? update.entries : [];
    return [
      createAgentEvent({
        id,
        ...base,
        type: "todo.updated",
        payload: {
          source: "acp",
          liveType: "acp.plan",
          entries,
          raw: params,
        },
      }),
    ];
  }

  return kind ? [unhandledSessionUpdate(id, base, params, kind)] : [rawOutput(id, base, params)];
}

/** Map `cursor/update_todos` (request or notification params) → `todo.updated`. */
export function mapAcpCursorUpdateTodos(params: unknown, ctx: AcpEventMapContext): AgentEvent[] {
  const parsed = parseAcpUpdateTodosRequest(params);
  if (!parsed) {
    return [];
  }
  return [
    createAgentEvent({
      id: `${ctx.threadId}:acp:${ctx.sessionRunId}:${randomUUID()}`,
      threadId: ctx.threadId,
      agentId: ctx.agentId,
      role: "main",
      type: "todo.updated",
      payload: {
        source: "acp",
        liveType: "acp.update_todos",
        todos: parsed.todos,
        merge: parsed.merge,
        ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {}),
        raw: params,
      },
    }),
  ];
}

/**
 * Map `cursor/task` → Eco subagent Cards (`tool.started` + `agent.started`).
 * This is the source of truth for Cursor ACP nested agents — not tool_call titles.
 */
export function mapAcpCursorTask(params: unknown, ctx: AcpEventMapContext): AgentEvent[] {
  const request = parseAcpTaskRequest(params) ?? (isAcpTaskRequestShape(params) ? params : undefined);
  if (!request) {
    return [];
  }
  const toolCallId = request.toolCallId;
  const subagentType = formatAcpCursorSubagentType(request.subagentType);
  const task =
    (typeof request.prompt === "string" && request.prompt.trim()) ||
    (typeof request.description === "string" && request.description.trim()) ||
    (typeof request.title === "string" && request.title.trim()) ||
    "";
  const agentId = acpSubagentAgentId(request.agentId?.trim() || toolCallId);
  const input: Record<string, unknown> = {
    ...(task ? { prompt: task } : {}),
    ...(request.description ? { description: request.description } : {}),
    ...(request.model ? { model: request.model } : {}),
    subagent_type: subagentType,
  };

  if (!ctx.openSubagents) {
    ctx.openSubagents = new Map();
  }
  ctx.openSubagents.set(toolCallId, {
    toolCallId,
    agentId,
    subagentType,
    task,
  });
  const alreadyTracked = Boolean(ctx.tools?.has(toolCallId));
  if (ctx.tools) {
    ctx.tools.set(toolCallId, { tool_name: "Agent", input });
  }
  if (ctx.turnProgress) {
    ctx.turnProgress.tools = true;
  }

  const id = `${ctx.threadId}:acp:${ctx.sessionRunId}:${randomUUID()}`;
  const events: AgentEvent[] = [];
  if (!alreadyTracked) {
    events.push(
      createAgentEvent({
        id: `${id}:tool`,
        threadId: ctx.threadId,
        agentId: ctx.agentId,
        role: "main",
        type: "tool.started",
        payload: {
          type: "tool_use",
          tool_name: "Agent",
          tool_use_id: toolCallId,
          input,
          subagent_type: subagentType,
          ...(task ? { prompt: task } : {}),
          raw: params,
        },
      }),
    );
  }
  events.push(
    createAgentEvent({
      id: `${id}:agent-started`,
      threadId: ctx.threadId,
      agentId,
      role: subagentType,
      type: "agent.started",
      payload: {
        source: "acp",
        liveType: "acp.cursor_task",
        parentToolUseId: toolCallId,
        subagent_type: subagentType,
        ...(task ? { prompt: task } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.agentId ? { cursorAgentId: request.agentId } : {}),
        raw: params,
      },
    }),
  );

  // Completion-shaped updates (durationMs present) close the card immediately.
  if (typeof request.durationMs === "number") {
    ctx.openSubagents.delete(toolCallId);
    events.push(
      createAgentEvent({
        id: `${id}:tool-completed`,
        threadId: ctx.threadId,
        agentId: ctx.agentId,
        role: "main",
        type: "tool.completed",
        payload: {
          type: "tool_result",
          tool_name: "Agent",
          tool_use_id: toolCallId,
          input,
          subagent_output: null,
          raw: params,
        },
      }),
      createAgentEvent({
        id: `${id}:agent-completed`,
        threadId: ctx.threadId,
        agentId,
        role: subagentType,
        type: "agent.completed",
        payload: {
          source: "acp",
          liveType: "acp.cursor_task",
          parentToolUseId: toolCallId,
          durationMs: request.durationMs,
          raw: params,
        },
      }),
    );
  }

  return events;
}

function isAcpTaskRequestShape(value: unknown): value is AcpTaskRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { toolCallId?: unknown }).toolCallId === "string" &&
    Boolean((value as { toolCallId: string }).toolCallId.trim())
  );
}

function resetAcpTurnAccumulators(ctx: AcpEventMapContext): void {
  if (ctx.agentMessageText) {
    ctx.agentMessageText.value = "";
  }
  if (ctx.turnProgress) {
    ctx.turnProgress.tools = false;
    ctx.turnProgress.thoughts = false;
  }
}

function acpUnstartedFromContext(ctx: AcpEventMapContext, agentText = ""): boolean {
  return isAcpUnstartedProviderFailure({
    agentText,
    sawTool: Boolean(ctx.turnProgress?.tools),
    sawThought: Boolean(ctx.turnProgress?.thoughts),
  });
}

function mapStopReason(
  id: string,
  base: { threadId: string; agentId: string; role: "main" },
  stopReason: string,
  params: JsonRecord,
  ctx: AcpEventMapContext,
): AgentEvent {
  if (stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
    const agentText = ctx.agentMessageText?.value?.trim() ?? "";
    if (stopReason === "end_turn") {
      const split = splitAcpProviderExhaustion(agentText);
      if (split) {
        const unstarted = isAcpUnstartedProviderFailure({
          agentText: split.body || split.envelope,
          sawTool: Boolean(ctx.turnProgress?.tools),
          sawThought: Boolean(ctx.turnProgress?.thoughts),
        });
        resetAcpTurnAccumulators(ctx);
        return createAgentEvent({
          id,
          ...base,
          type: "run.terminal",
          payload: { status: "failed", error: split.envelope, ...(unstarted ? { unstarted: true } : {}) },
        });
      }
    }
    resetAcpTurnAccumulators(ctx);
    return createAgentEvent({
      id,
      ...base,
      type: "run.terminal",
      payload: { status: "completed" },
    });
  }
  const unstarted = acpUnstartedFromContext(ctx, ctx.agentMessageText?.value ?? "");
  resetAcpTurnAccumulators(ctx);
  if (stopReason === "cancelled") {
    return createAgentEvent({
      id,
      ...base,
      type: "run.terminal",
      payload: { status: "cancelled", reason: "cancelled" },
    });
  }
  const error =
    typeof params.error === "string"
      ? params.error
      : typeof params.message === "string"
        ? params.message
        : stopReason;
  return createAgentEvent({
    id,
    ...base,
    type: "run.terminal",
    payload: { status: "failed", error, ...(unstarted ? { unstarted: true } : {}) },
  });
}

function rawOutput(
  id: string,
  base: { threadId: string; agentId: string; role: "main" },
  raw: unknown,
  liveType?: string,
): AgentEvent {
  return createAgentEvent({
    id,
    ...base,
    type: "terminal.output",
    payload: { source: "acp", ...(liveType ? { liveType } : {}), raw },
  });
}

/**
 * Fallthrough for unrecognized `sessionUpdate` kinds. Explicitly tags the event
 * with the kind name so new shapes are observable instead of silently swallowed.
 */
function unhandledSessionUpdate(
  id: string,
  base: { threadId: string; agentId: string; role: "main" },
  params: JsonRecord,
  kind: string,
): AgentEvent {
  return rawOutput(id, base, params, `acp.unhandled_session_update.${kind}`);
}

function mapAcpToolStart(update: JsonRecord | undefined): AcpMappedTool {
  return {
    tool_name: mapAcpToolName(update),
    input: resolveAcpToolInput(update),
  };
}

/**
 * Cursor ACP kinds observed at runtime: execute / search / read.
 * Titles: command preview, "grep", "Find", "Read File".
 */
function mapAcpToolName(update: JsonRecord | undefined): string {
  const kind = typeof update?.kind === "string" ? update.kind.trim().toLowerCase() : "";
  const title = typeof update?.title === "string" ? update.title.trim() : "";
  const titleKey = title.toLowerCase();
  if (kind === "execute") {
    return "Bash";
  }
  if (kind === "read" || titleKey === "read file" || titleKey === "read") {
    return "Read";
  }
  if (titleKey === "grep") {
    return "Grep";
  }
  if (titleKey === "find" || titleKey === "glob") {
    return "Glob";
  }
  if (kind === "search") {
    return "Grep";
  }
  if (kind === "edit") {
    return "Edit";
  }
  if (titleKey === "agent" || titleKey === "task") {
    return "Agent";
  }
  if (kind === "other" || kind === "fetch") {
    return title || (kind === "fetch" ? "Fetch" : "MCP");
  }
  if (title && !title.startsWith("`") && title.length <= 80) {
    return title;
  }
  return kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Tool";
}

function resolveAcpToolInput(update: JsonRecord | undefined): Record<string, unknown> {
  const raw = isRecord(update?.rawInput) ? { ...update.rawInput } : {};
  const pathFromLocations = readFirstLocationPath(update?.locations);
  if (pathFromLocations && typeof raw.path !== "string" && typeof raw.file_path !== "string") {
    raw.file_path = pathFromLocations;
    raw.path = pathFromLocations;
  }
  mergeAcpDiffContentIntoToolInput(raw, update?.content);
  return raw;
}

/**
 * ACP edit tool calls may carry file diffs in `content[]` as
 * `{ type: "diff", path, oldText, newText }` (optionally wrapped in a
 * `{ type: "content", content: ... }` block). Fold those into tool input so
 * Eco's file-change UI can render a preview without `fs/write_text_file`.
 */
function mergeAcpDiffContentIntoToolInput(input: Record<string, unknown>, content: unknown): void {
  const diffs = collectAcpDiffBlocks(content);
  if (diffs.length === 0) {
    return;
  }

  const pathFromDiff = diffs.find((entry) => entry.path)?.path;
  if (pathFromDiff && typeof input.path !== "string" && typeof input.file_path !== "string") {
    input.path = pathFromDiff;
    input.file_path = pathFromDiff;
  }

  const hasOld = diffs.some((entry) => entry.oldText !== undefined);
  const hasNew = diffs.some((entry) => entry.newText !== undefined);
  if (hasOld) {
    input.oldText = diffs.map((entry) => entry.oldText ?? "").join("\n");
  }
  if (hasNew) {
    input.newText = diffs.map((entry) => entry.newText ?? "").join("\n");
  }
}

type AcpDiffBlock = {
  path?: string;
  oldText?: string | null;
  newText?: string | null;
};

function collectAcpDiffBlocks(content: unknown): AcpDiffBlock[] {
  if (Array.isArray(content)) {
    const blocks: AcpDiffBlock[] = [];
    for (const entry of content) {
      const block = readAcpDiffBlock(entry);
      if (block) {
        blocks.push(block);
      }
    }
    return blocks;
  }
  const single = readAcpDiffBlock(content);
  return single ? [single] : [];
}

function readAcpDiffBlock(value: unknown): AcpDiffBlock | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.type === "diff") {
    return normalizeAcpDiffBlock(value);
  }
  // Nested content block: { type: "content", content: { type: "diff", ... } }
  if (value.type === "content" && isRecord(value.content) && value.content.type === "diff") {
    return normalizeAcpDiffBlock(value.content);
  }
  return undefined;
}

function normalizeAcpDiffBlock(value: JsonRecord): AcpDiffBlock | undefined {
  const path =
    typeof value.path === "string" && value.path.trim()
      ? value.path.trim()
      : typeof value.file_path === "string" && value.file_path.trim()
        ? value.file_path.trim()
        : undefined;
  const hasOld = "oldText" in value || "old_text" in value || "old_string" in value;
  const hasNew = "newText" in value || "new_text" in value || "new_string" in value;
  if (!path && !hasOld && !hasNew) {
    return undefined;
  }
  return {
    ...(path ? { path } : {}),
    ...(hasOld
      ? { oldText: readNullableAcpDiffText(value.oldText ?? value.old_text ?? value.old_string) }
      : {}),
    ...(hasNew
      ? { newText: readNullableAcpDiffText(value.newText ?? value.new_text ?? value.new_string) }
      : {}),
  };
}

/** ACP allows `oldText: null` for new files; keep null distinct from missing. */
function readNullableAcpDiffText(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : null;
}

function readFirstLocationPath(locations: unknown): string | undefined {
  if (!Array.isArray(locations)) {
    return undefined;
  }
  for (const entry of locations) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.path === "string" && entry.path.trim()) {
      return entry.path.trim();
    }
    if (typeof entry.file_path === "string" && entry.file_path.trim()) {
      return entry.file_path.trim();
    }
  }
  return undefined;
}

function ecoStreamPayload(input: {
  text: string;
  raw: unknown;
  blockKind?: "thinking" | "subagent_output";
  messageId?: string | null | undefined;
  liveType?: string | null | undefined;
  parent_tool_use_id?: string | null | undefined;
}): Record<string, unknown> {
  return {
    type: "eco_stream",
    ...(input.blockKind && { blockKind: input.blockKind }),
    text: input.text,
    ...(input.messageId && { messageId: input.messageId }),
    ...(input.liveType && { liveType: input.liveType }),
    ...(input.parent_tool_use_id && { parent_tool_use_id: input.parent_tool_use_id }),
    raw: input.raw,
  };
}

function readMessageId(update: JsonRecord | undefined): string | undefined {
  const value = update?.messageId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readContentText(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined;
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
