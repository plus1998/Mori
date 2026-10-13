import {
  type AgentEvent,
  createToolOutputPreview,
  formatSendMessageToolInputSummary,
  formatSendMessageToolResultSummary,
  isEcoWebSearchToolName,
  parseEcoWebSearchToolOutput,
  parseSendMessageToolResult,
  readEcoWebSearchQuery,
  readHtmlHostMetadataFromToolOutput,
  readImageDisplayMetadataFromToolOutput,
  readSendMessageToolInput,
  resolveEcoHtmlHostToolCall,
  resolveEcoImageDisplayToolCall,
  resolveEcoImageViewToolCall,
  resolveEcoMcpHubSearchCall,
  resolveEcoMcpHubToolCall,
  resolvePiMcpProxyDiscoveryCall,
  resolveSkillDisplayName,
} from "@eco/runtime";
import { formatAgentEventDisplay, isEcoStreamFinalize, isEcoStreamPlaceholder } from "@eco/runtime/sdk";
import { classifyToolWriteKind } from "@eco/shared";
import type { ToolWritingActivity } from "../shared/conversation-v2-projection";
import {
  enrichFileChangeFromToolOutput,
  isFileChangeToolName,
  resolveFileChangeFromToolInput,
} from "../shared/file-change.js";
import type { ThreadRunImageViewMetadata, ThreadRunToolMetadata } from "../shared/ipc";
import { resolvePiMcpProxyCall, resolvePiMcpProxyToolName } from "../shared/pi-mcp-proxy.js";
import { parseThreadRunImageViewMetadata } from "../shared/thread-run-events.js";
import { resolveCodemodeMetadata } from "../shared/thread-run-tool-projection.js";
import {
  formatThreadRunGrepTargetLabel,
  formatThreadRunReadTargetLabel,
  resolveThreadRunToolTargets,
} from "../shared/tool-target.js";
import { activityStreamKey } from "./activity-agent-id.js";
import { classifySdkStreamMessageOrigin } from "./sdk-activity-origin.js";

type AgentEventLike = Pick<AgentEvent, "type" | "payload" | "role" | "agentId">;

interface PendingRemoteStreamDelta {
  role: string;
  message: string;
  stream: boolean;
  agentId?: string;
  extras?: { tool?: ThreadRunToolMetadata; metadata?: Record<string, unknown> };
  timer: ReturnType<typeof setTimeout> | null;
}

export type SdkActivityEmit = (
  threadId: string,
  type: string,
  message: string,
  role: string,
  stream: boolean,
  agentId?: string,
  extras?: { tool?: ThreadRunToolMetadata; metadata?: Record<string, unknown> },
) => void;

const REMOTE_STREAM_THROTTLE_MS = 50;

type LastStreamLine = {
  role: string;
  message: string;
  agentId?: string;
  extras?: { tool?: ThreadRunToolMetadata; metadata?: Record<string, unknown> };
};

export class SdkStreamActivityBridge {
  private readonly pendingDeltas = new Map<string, PendingRemoteStreamDelta>();
  private readonly lastStreamLine = new Map<string, LastStreamLine>();
  private readonly finalizedSdkMessageBlocks = new Set<string>();
  /**
   * ACP (and other unkeyed eco_stream) thinking/text share one agent stream unless we
   * split generations on channel change, incompatible ACP messageId, or tool start.
   * Zed: same messageId (or missing id) appends; a changed messageId starts a new
   * thought chunk; a tool_call is a new thread entry so later thoughts cannot reopen
   * the previous block. ACP messageId must not use the keyed Claude identity, which
   * survives tool.started.
   */
  private readonly unkeyedNarrativeBlocks = new Map<
    string,
    { channel: "thinking" | "message"; generation: number; messageId?: string }
  >();

  /**
   * What was last said about each tool call being written: the tool, and the target once the
   * arguments named it. Providers stream one placeholder per argument fragment, so the same
   * call is announced once as「正在准备写入文件」and once more as「正在写入 /tmp/x.md」— and never
   * per fragment.
   */
  private readonly announcedToolWrites = new Map<string, Map<string, string>>();

  /**
   * Surface the gap the Feed cannot narrate: the model is writing a tool call whose
   * arguments are not complete yet, so no tool row exists to look at. Emitted as its own
   * activity (`tool.writing`) instead of being dropped, because "the agent is busy" is a
   * fact the stream states plainly — it is only the tool card that has to wait.
   */
  private announceToolWrite(
    threadId: string,
    payload: unknown,
    emit: SdkActivityEmit,
    activityAgentId: string | undefined,
  ): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const record = payload as Record<string, unknown>;
    const toolName = readString(record.tool_name)?.trim();
    const target = readString(record.tool_input_target)?.trim();
    if (!toolName && !target) {
      return;
    }
    // The call's own id is what tells two calls of the same tool apart. Without one — a provider
    // that omits the block id — two calls of the same tool in one run collapse into a single key,
    // and the second one stays silent (the SDK, π and ACP all name their calls, so this is the
    // malformed-stream case rather than the common one).
    const writeKey = readString(record.tool_use_id)?.trim() || toolName || target || "tool";
    const announced = this.announcedToolWrites.get(threadId) ?? new Map<string, string>();
    const signature = `${toolName ?? ""}\u0000${target ?? ""}`;
    if (announced.get(writeKey) === signature) {
      return;
    }
    announced.set(writeKey, signature);
    this.announcedToolWrites.set(threadId, announced);
    const writing: ToolWritingActivity = {
      kind: toolName ? classifyToolWriteKind(toolName) : "tool",
      ...(toolName && { name: toolName }),
      ...(target && { target }),
    };
    emit(threadId, "tool.writing", toolName ?? target ?? "", "tool", false, activityAgentId, {
      metadata: { activityOrigin: "sdk.tool_writing", toolWriting: writing },
    });
  }

  /**
   * Flush throttled deltas and finalize any open narrative streams before clearing
   * bridge state. Dropping pending text here would lose the durable V2 tail.
   */
  flushPendingAndReset(threadId: string, emit: SdkActivityEmit): void {
    this.flushPending(threadId, emit);
    const openLines = [...this.lastStreamLine.entries()].filter(([streamKey, last]) => {
      return streamKey.startsWith(`${threadId}:`) && Boolean(last.message.trim());
    });
    for (const [, last] of openLines) {
      emit(threadId, "message.delta", last.message, last.role, false, last.agentId, last.extras);
    }
    this.resetThread(threadId);
  }

  resetThread(threadId: string): void {
    this.announcedToolWrites.delete(threadId);
    for (const key of [...this.lastStreamLine.keys()]) {
      if (key.startsWith(`${threadId}:`)) {
        this.lastStreamLine.delete(key);
      }
    }
    for (const key of [...this.pendingDeltas.keys()]) {
      if (key.startsWith(`${threadId}:`)) {
        const pending = this.pendingDeltas.get(key);
        if (pending?.timer) {
          clearTimeout(pending.timer);
        }
        this.pendingDeltas.delete(key);
      }
    }
    for (const key of [...this.finalizedSdkMessageBlocks]) {
      if (key.startsWith(`${threadId}:`)) {
        this.finalizedSdkMessageBlocks.delete(key);
      }
    }
    for (const key of [...this.unkeyedNarrativeBlocks.keys()]) {
      if (key.startsWith(`${threadId}:`)) {
        this.unkeyedNarrativeBlocks.delete(key);
      }
    }
  }

  handleEvent(
    threadId: string,
    event: AgentEventLike,
    emit: SdkActivityEmit,
    emitUsage?: (threadId: string, event: AgentEventLike) => void,
    options?: {
      activityAgentId?: string;
      parentToolUseId?: string;
      runAttemptId?: string;
    },
  ): void {
    const activityAgentId = options?.activityAgentId;
    const runAttemptId = options?.runAttemptId?.trim() || undefined;

    if (event.type === "usage.recorded") {
      emitUsage?.(threadId, event);
      return;
    }

    if (event.type === "tool.started") {
      if (isSdkToolInputPlaceholder(event.payload)) {
        this.announceToolWrite(threadId, event.payload, emit, activityAgentId);
        return;
      }
      this.closeUnkeyedNarrativeBeforeTool({
        threadId,
        ...(activityAgentId !== undefined ? { activityAgentId } : {}),
        ...(options?.parentToolUseId !== undefined ? { parentToolUseId: options.parentToolUseId } : {}),
        ...(runAttemptId !== undefined ? { runAttemptId } : {}),
        emit,
      });
    }

    if (event.type === "agent.started") {
      const status = resolveSdkAgentStatusActivity(event.payload);
      if (!status) {
        return;
      }
      const display = formatAgentEventDisplay(event);
      const systemNotice = status.type.startsWith("sdk.") || status.type === "request.rate_limit";
      this.flushPending(threadId, emit);
      emit(
        threadId,
        status.type,
        status.message,
        systemNotice ? "system" : String(display?.role ?? event.role),
        false,
        systemNotice ? undefined : activityAgentId,
        status.metadata ? { metadata: status.metadata } : undefined,
      );
      return;
    }

    const allowed =
      event.type === "message.delta" ||
      event.type === "todo.updated" ||
      event.type === "tool.started" ||
      event.type === "tool.completed" ||
      event.type === "tool.failed";
    if (!allowed) {
      return;
    }

    const display = formatAgentEventDisplay(event);
    if (!display && !(event.payload && isEcoStreamFinalize(event.payload))) {
      return;
    }

    const role = String(display?.role ?? event.role);
    const stream = display?.stream ?? false;
    const message = display?.message ?? "";
    const explicitStreamBlockKey = readSdkStreamBlockKey(event.payload);
    let sdkStreamBlockKey = explicitStreamBlockKey ? readSdkStreamIdentityKey(event.payload) : undefined;
    if (!sdkStreamBlockKey && event.type === "message.delta") {
      const messageId = readSdkMessageId(event.payload);
      sdkStreamBlockKey = this.allocateUnkeyedNarrativeBlockKey({
        threadId,
        ...(activityAgentId !== undefined ? { activityAgentId } : {}),
        role,
        ...(options?.parentToolUseId !== undefined ? { parentToolUseId: options.parentToolUseId } : {}),
        ...(runAttemptId !== undefined ? { runAttemptId } : {}),
        emit,
        ...(messageId ? { messageId } : {}),
      });
    }
    const streamKey = activityStreamKey(
      threadId,
      activityAgentId,
      role,
      options?.parentToolUseId,
      sdkStreamBlockKey,
      runAttemptId,
    );
    const stableSdkMessageBlock = readSdkMessageId(event.payload) ? streamKey : undefined;
    if (stableSdkMessageBlock && this.finalizedSdkMessageBlocks.has(stableSdkMessageBlock)) {
      return;
    }

    if (event.payload && isEcoStreamFinalize(event.payload)) {
      this.flushPending(threadId, emit);
      const last = this.lastStreamLine.get(streamKey);
      const finalizedMessage = last?.message.trim() ? last.message : message;
      const finalizedAgentId = last?.agentId ?? activityAgentId;
      const finalizedExtras = mergeSdkActivityEmitExtras(
        finalizedMessage,
        undefined,
        event.payload,
        sdkStreamBlockKey,
      );
      emit(
        threadId,
        event.type,
        finalizedMessage,
        last?.role ?? role,
        false,
        finalizedAgentId,
        finalizedExtras,
      );
      this.lastStreamLine.delete(streamKey);
      if (stableSdkMessageBlock) {
        this.finalizedSdkMessageBlocks.add(stableSdkMessageBlock);
      }
      return;
    }

    if (event.payload && isEcoStreamPlaceholder(event.payload)) {
      this.flushPending(threadId, emit);
      const previousLine = this.lastStreamLine.get(streamKey);
      const placeholderExtras = withThinkingStartedAt(
        mergeSdkActivityEmitExtras(message, undefined, event.payload, sdkStreamBlockKey),
        role,
        previousLine?.extras,
      );
      this.lastStreamLine.set(streamKey, {
        role,
        message: "",
        ...(activityAgentId && { agentId: activityAgentId }),
        ...(placeholderExtras && { extras: placeholderExtras }),
      });
      emit(threadId, event.type, message, role, true, activityAgentId, placeholderExtras);
      return;
    }

    if (event.type === "message.delta" && stream) {
      const previousLine = this.lastStreamLine.get(streamKey);
      const previous = previousLine?.message ?? "";
      // eco_stream and raw SDK stream_event carry incremental deltas. Text equality
      // cannot identify a replay: "100" + "00" and repeated words are valid output.
      // The bridge emits cumulative snapshots only after appending every delta.
      const accumulated = previous + message;
      const emitExtras = withThinkingStartedAt(
        mergeSdkActivityEmitExtras(accumulated, undefined, event.payload, sdkStreamBlockKey),
        role,
        previousLine?.extras,
      );
      this.lastStreamLine.set(streamKey, {
        role,
        message: accumulated,
        ...(activityAgentId && { agentId: activityAgentId }),
        ...(emitExtras && { extras: emitExtras }),
      });
      this.scheduleRemoteDelta(
        threadId,
        streamKey,
        event.type,
        accumulated,
        role,
        stream,
        activityAgentId,
        emitExtras,
        emit,
      );
      return;
    }

    const emitExtras = withThinkingStartedAt(
      mergeSdkActivityEmitExtras(
        message,
        resolveSdkActivityToolMetadata(event),
        event.payload,
        sdkStreamBlockKey,
      ),
      role,
      stream ? this.lastStreamLine.get(streamKey)?.extras : undefined,
    );

    this.flushPending(threadId, emit);
    if (stream) {
      this.lastStreamLine.set(streamKey, {
        role,
        message,
        ...(activityAgentId && { agentId: activityAgentId }),
        ...(emitExtras && { extras: emitExtras }),
      });
    } else {
      this.lastStreamLine.delete(streamKey);
    }
    emit(threadId, event.type, message, role, stream, activityAgentId, emitExtras);
  }

  private scheduleRemoteDelta(
    threadId: string,
    streamKey: string,
    type: string,
    message: string,
    role: string,
    stream: boolean,
    agentId: string | undefined,
    extras: { tool?: ThreadRunToolMetadata; metadata?: Record<string, unknown> } | undefined,
    emit: SdkActivityEmit,
  ): void {
    const pendingExisting = this.pendingDeltas.get(streamKey);
    if (pendingExisting?.timer) {
      pendingExisting.role = role;
      pendingExisting.message = message;
      pendingExisting.stream = stream;
      if (agentId) {
        pendingExisting.agentId = agentId;
      } else {
        delete pendingExisting.agentId;
      }
      if (extras) {
        pendingExisting.extras = extras;
      } else {
        delete pendingExisting.extras;
      }
      return;
    }
    const pending: PendingRemoteStreamDelta = {
      role,
      message,
      stream,
      ...(agentId && { agentId }),
      ...(extras && { extras }),
      timer: setTimeout(() => {
        this.pendingDeltas.delete(streamKey);
        emit(threadId, type, pending.message, pending.role, pending.stream, pending.agentId, pending.extras);
      }, REMOTE_STREAM_THROTTLE_MS),
    };
    this.pendingDeltas.set(streamKey, pending);
  }

  private flushPending(threadId: string, emit: SdkActivityEmit): void {
    for (const [streamKey, pending] of [...this.pendingDeltas.entries()]) {
      if (!streamKey.startsWith(`${threadId}:`)) {
        continue;
      }
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pendingDeltas.delete(streamKey);
      this.lastStreamLine.set(streamKey, {
        role: pending.role,
        message: pending.message,
        ...(pending.agentId && { agentId: pending.agentId }),
        ...(pending.extras && { extras: pending.extras }),
      });
      emit(
        threadId,
        "message.delta",
        pending.message,
        pending.role,
        pending.stream,
        pending.agentId,
        pending.extras,
      );
    }
  }

  private allocateUnkeyedNarrativeBlockKey(input: {
    threadId: string;
    activityAgentId?: string;
    role: string;
    parentToolUseId?: string;
    runAttemptId?: string;
    emit: SdkActivityEmit;
    messageId?: string;
  }): string {
    const ownerKey = activityStreamKey(
      input.threadId,
      input.activityAgentId,
      input.role,
      input.parentToolUseId,
      undefined,
      input.runAttemptId,
    );
    const channel: "thinking" | "message" = input.role === "thinking" ? "thinking" : "message";
    const current = this.unkeyedNarrativeBlocks.get(ownerKey);
    if (!current) {
      this.unkeyedNarrativeBlocks.set(ownerKey, {
        channel,
        generation: 0,
        ...(input.messageId && { messageId: input.messageId }),
      });
      return `${channel}:0`;
    }
    if (current.channel === channel && canMergeAcpMessageIds(current.messageId, input.messageId)) {
      const adopted = current.messageId ?? input.messageId;
      this.unkeyedNarrativeBlocks.set(ownerKey, {
        channel,
        generation: current.generation,
        ...(adopted && { messageId: adopted }),
      });
      return `${channel}:${current.generation}`;
    }
    const previousStreamKey = activityStreamKey(
      input.threadId,
      input.activityAgentId,
      current.channel === "thinking" ? "thinking" : input.role,
      input.parentToolUseId,
      `${current.channel}:${current.generation}`,
      input.runAttemptId,
    );
    this.closeNarrativeStream(input.threadId, previousStreamKey, input.emit);
    const generation = current.generation + 1;
    this.unkeyedNarrativeBlocks.set(ownerKey, {
      channel,
      generation,
      ...(input.messageId && { messageId: input.messageId }),
    });
    return `${channel}:${generation}`;
  }

  /**
   * PI finalizes open narrative streams on tool start. ACP thought chunks have no
   * end marker; Zed treats a tool_call as a new thread entry, so the same barrier
   * lives here: close the current unkeyed thinking/text block and bump generation
   * so later chunks (even with the same messageId) cannot reopen it as still-streaming.
   */
  private closeUnkeyedNarrativeBeforeTool(input: {
    threadId: string;
    activityAgentId?: string;
    parentToolUseId?: string;
    runAttemptId?: string;
    emit: SdkActivityEmit;
  }): void {
    for (const ownerKey of this.unkeyedNarrativeOwnerKeys(input)) {
      const current = this.unkeyedNarrativeBlocks.get(ownerKey);
      if (!current) {
        continue;
      }
      const previousStreamKey = activityStreamKey(
        input.threadId,
        input.activityAgentId,
        current.channel === "thinking" ? "thinking" : "planner",
        input.parentToolUseId,
        `${current.channel}:${current.generation}`,
        input.runAttemptId,
      );
      this.closeNarrativeStream(input.threadId, previousStreamKey, input.emit);
      this.unkeyedNarrativeBlocks.set(ownerKey, {
        channel: current.channel,
        generation: current.generation + 1,
      });
    }
  }

  private unkeyedNarrativeOwnerKeys(input: {
    threadId: string;
    activityAgentId?: string;
    parentToolUseId?: string;
    runAttemptId?: string;
  }): string[] {
    return [
      ...new Set(
        (["thinking", "planner"] as const).map((role) =>
          activityStreamKey(
            input.threadId,
            input.activityAgentId,
            role,
            input.parentToolUseId,
            undefined,
            input.runAttemptId,
          ),
        ),
      ),
    ];
  }

  private closeNarrativeStream(threadId: string, streamKey: string, emit: SdkActivityEmit): void {
    const pending = this.pendingDeltas.get(streamKey);
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingDeltas.delete(streamKey);
    const last = pending
      ? {
          role: pending.role,
          message: pending.message,
          ...(pending.agentId && { agentId: pending.agentId }),
          ...(pending.extras && { extras: pending.extras }),
        }
      : this.lastStreamLine.get(streamKey);
    if (!last) {
      return;
    }
    emit(threadId, "message.delta", last.message, last.role, false, last.agentId, last.extras);
    this.lastStreamLine.delete(streamKey);
  }
}

function readSdkStreamBlockKey(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as { stream_block_key?: unknown }).stream_block_key;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSdkStreamIdentityKey(payload: unknown): string | undefined {
  const messageId = readSdkMessageId(payload);
  if (messageId && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const blockKind = (payload as { blockKind?: unknown }).blockKind;
    if (blockKind === "text" || blockKind === "thinking") {
      return `${blockKind}:message:${messageId}`;
    }
  }
  return readSdkStreamBlockKey(payload);
}

function readSdkMessageId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as { messageId?: unknown }).messageId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSdkTaskReconciliationMetadata(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.sdkKind !== "task_progress" && record.sdkKind !== "task_notification") {
    return undefined;
  }
  const taskId = readString(record.task_id);
  if (!taskId) {
    return undefined;
  }
  const toolUseId = readString(record.tool_use_id);
  const status = readString(record.status);
  const usage =
    record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? record.usage
      : undefined;
  return {
    sdkTaskId: taskId,
    sdkTaskKind: record.sdkKind,
    ...(toolUseId && { sdkTaskToolUseId: toolUseId }),
    ...(status && { sdkTaskStatus: status }),
    ...(typeof record.reason === "string" && { sdkTaskReason: record.reason }),
    ...(usage ? { sdkTaskUsage: usage } : {}),
  };
}

function resolveSdkActivityToolMetadata(event: AgentEventLike): ThreadRunToolMetadata | undefined {
  if (event.type === "tool.started") {
    return resolveSdkToolUseMetadata(event.payload) ?? resolveSdkToolProgressMetadata(event.payload);
  }
  if (event.type === "tool.completed") {
    return resolveSdkToolSummaryMetadata(event.payload);
  }
  if (event.type === "tool.failed") {
    return resolveSdkToolFailedMetadata(event.payload);
  }
  if (event.type === "todo.updated") {
    return resolveSdkTaskProgressToolMetadata(event.payload);
  }
  return undefined;
}

function resolveSdkMcpToolIdentity(
  name: string,
  input: unknown,
): {
  displayName: string;
  toolInput: unknown;
  mcpDiscovery?: { kind: "search" };
} {
  const hubCall = resolveEcoMcpHubToolCall(name, input);
  const hubSearch = resolveEcoMcpHubSearchCall(name, input);
  const proxyCall = hubCall ? undefined : resolvePiMcpProxyCall(name, input);
  const proxyName = proxyCall ? resolvePiMcpProxyToolName(name, input) : undefined;
  const displayName = hubCall?.name ?? proxyName ?? name;
  const toolInput = hubCall?.args ?? proxyCall?.args ?? input;
  const mcpDiscovery =
    hubSearch || (!hubCall && !proxyCall && resolvePiMcpProxyDiscoveryCall(name, input))
      ? { kind: "search" as const }
      : undefined;
  return {
    displayName,
    toolInput,
    ...(mcpDiscovery ? { mcpDiscovery } : {}),
  };
}

/**
 * PI's codemode sandbox issues tool calls from inside the script and marks each one with the script's
 * own call id. The Feed needs that link to keep the script's calls inside the script's card instead of
 * counting them as commands the model issued. It is display nesting, not ownership, so it stays off the
 * event's `parentToolUseId` (Eco's subagent link).
 */
function readSdkNestedToolCallId(record: Record<string, unknown>): string | undefined {
  return readString(record.parent_tool_call_id);
}

function resolveSdkToolSummaryMetadata(payload: unknown): ThreadRunToolMetadata | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "tool_use_summary" && record.type !== "tool_result") {
    return undefined;
  }
  const name = readString(record.tool_name) ?? "Bash";
  const identity = resolveSdkMcpToolIdentity(name, record.input);
  const displayName = identity.displayName;
  const toolInput = identity.toolInput;
  const {
    imageViewCall,
    imageDisplayCall,
    htmlHostCall,
    mcpDiscovery: imageMcpDiscovery,
  } = resolveSdkImageViewAndMcpDiscovery(displayName, toolInput);
  const mcpDiscovery = identity.mcpDiscovery ?? imageMcpDiscovery;
  const skillName = resolveSdkSkillDisplayName(displayName, isRecord(toolInput) ? toolInput : {});
  const skillDetail = skillName ? `读取 ${skillName} 技能` : undefined;
  // Skill reads label by skill name; skip file targets so the card stays "读取 <name> 技能".
  const targets = skillDetail ? {} : resolveThreadRunToolTargets(displayName, toolInput);
  const command =
    skillDetail ??
    readString(record.command) ??
    readString(record.full_command) ??
    readString(record.bash_command) ??
    (targets.readTarget && formatThreadRunReadTargetLabel(targets.readTarget)) ??
    (targets.grepTarget && formatThreadRunGrepTargetLabel(targets.grepTarget)) ??
    resolveSdkToolDisplayDetail(displayName, toolInput);
  const output =
    readToolResultText(record.output) ??
    readToolResultText(record.stdout) ??
    readToolResultText(record.result) ??
    readToolResultText(record.content);
  const outputPreview = output ? createToolOutputPreview(output) : undefined;
  const imageViewMeta = toImageViewMetadata(imageViewCall);
  const toolUseId = readString(record.tool_use_id);
  const parentToolCallId = readSdkNestedToolCallId(record);
  const description =
    name === "Bash"
      ? (readString(record.description) ?? readBashDescriptionFromToolInput(toolInput))
      : undefined;
  const fileChangeFromInput = isFileChangeToolName(displayName)
    ? resolveFileChangeFromToolInput(displayName, toolInput)
    : undefined;
  const fileChange = enrichFileChangeFromToolOutput(
    fileChangeFromInput,
    output ?? record.result ?? record.content,
  );
  const sendMessageInput = displayName === "SendMessage" ? readSendMessageToolInput(toolInput) : undefined;
  const sendMessageResult =
    displayName === "SendMessage"
      ? parseSendMessageToolResult(output ?? record.result ?? record.content)
      : undefined;
  const sendMessageDetail = sendMessageResult
    ? formatSendMessageToolResultSummary(sendMessageResult)
    : undefined;
  const sendMessageOutputPreview =
    displayName === "SendMessage" && sendMessageResult?.resultMessage
      ? createToolOutputPreview(sendMessageResult.resultMessage)
      : undefined;
  const sendMessage =
    sendMessageInput || sendMessageResult
      ? {
          ...(sendMessageInput ?? {}),
          ...(sendMessageResult ?? {}),
        }
      : undefined;
  const webSearch = resolveEcoWebSearchToolMetadata(displayName, toolInput, output);
  const imageDisplayMeta = imageDisplayCall
    ? readImageDisplayMetadataFromToolOutput(output ?? record.result ?? record.content)
    : undefined;
  const htmlHostMeta = htmlHostCall
    ? readHtmlHostMetadataFromToolOutput(output ?? record.result ?? record.content)
    : undefined;
  // PI's codemode: the script is the call and its return value is what the model saw.
  const codemode = resolveCodemodeMetadata({
    name: displayName,
    callInput: toolInput,
    ...(output ? { output } : {}),
    ...(record.codemodeDetails !== undefined ? { details: record.codemodeDetails } : {}),
  });
  return {
    name: displayName,
    ...(command && { detail: command }),
    ...(sendMessageDetail && { detail: sendMessageDetail }),
    ...(webSearch?.query && !command && { detail: webSearch.query }),
    ...(imageViewCall?.ref && !command && !sendMessageDetail && { detail: imageViewCall.ref }),
    ...(imageDisplayMeta?.artifactId &&
      !command &&
      !sendMessageDetail && { detail: imageDisplayMeta.artifactId }),
    ...(htmlHostMeta?.publicUrl && !command && !sendMessageDetail && { detail: htmlHostMeta.publicUrl }),
    ...(outputPreview?.text && { outputPreview: outputPreview.text }),
    ...(sendMessageOutputPreview?.text && { outputPreview: sendMessageOutputPreview.text }),
    ...(outputPreview?.truncated && { outputPreviewTruncated: true }),
    ...(sendMessageOutputPreview?.truncated && { outputPreviewTruncated: true }),
    ...(toolUseId && { toolUseId }),
    ...(description && { description }),
    ...(fileChange && { fileChange }),
    ...(targets.readTarget && { readTarget: targets.readTarget }),
    ...(targets.grepTarget && { grepTarget: targets.grepTarget }),
    ...(sendMessage && Object.keys(sendMessage).length > 0 && { sendMessage }),
    ...(imageViewMeta && { imageView: imageViewMeta }),
    ...(imageDisplayMeta?.artifactId && {
      imageDisplay: {
        artifactId: imageDisplayMeta.artifactId,
        ...(imageDisplayMeta.title ? { title: imageDisplayMeta.title } : {}),
      },
    }),
    ...(htmlHostMeta?.pageId &&
      htmlHostMeta.publicUrl && {
        htmlHost: {
          pageId: htmlHostMeta.pageId,
          publicUrl: htmlHostMeta.publicUrl,
          ...(htmlHostMeta.title ? { title: htmlHostMeta.title } : {}),
          ...(htmlHostMeta.expiresAt ? { expiresAt: htmlHostMeta.expiresAt } : {}),
          ...(typeof htmlHostMeta.canExtend === "boolean" ? { canExtend: htmlHostMeta.canExtend } : {}),
        },
      }),
    ...(mcpDiscovery && { mcpDiscovery }),
    ...(webSearch && { webSearch }),
    ...(parentToolCallId && { parentToolCallId }),
    ...(codemode && { codemode }),
    status: "completed",
  };
}

function resolveSdkToolFailedMetadata(payload: unknown): ThreadRunToolMetadata | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const isToolResultError =
    record.type === "tool_result_error" || (record.type === "tool_result" && record.is_error === true);
  if (
    (record.type !== "tool_permission_denied" && !isToolResultError) ||
    typeof record.tool_name !== "string"
  ) {
    return undefined;
  }
  const name = record.tool_name;
  const identity = resolveSdkMcpToolIdentity(name, record.input);
  const displayName = identity.displayName;
  const toolInput = identity.toolInput;
  const { imageViewCall, mcpDiscovery: imageMcpDiscovery } = resolveSdkImageViewAndMcpDiscovery(
    displayName,
    toolInput,
  );
  const mcpDiscovery = identity.mcpDiscovery ?? imageMcpDiscovery;
  const targets = resolveThreadRunToolTargets(displayName, toolInput);
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.content === "string"
        ? record.content
        : undefined;
  const isExecutionFailure = isToolResultError;
  const nonExecutionKind =
    record.non_execution_kind === "cancelled" ||
    record.non_execution_kind === "denied" ||
    record.non_execution_kind === "interrupted"
      ? record.non_execution_kind
      : undefined;
  const detail =
    nonExecutionKind === "cancelled"
      ? `System cancelled ${name} — not a user denial${message ? `: ${message}` : ""}`
      : message;
  const outputPreview = message ? createToolOutputPreview(message) : undefined;
  const fileChange = isFileChangeToolName(displayName)
    ? resolveFileChangeFromToolInput(displayName, toolInput)
    : undefined;
  const failedImageViewMeta = toImageViewMetadata(imageViewCall);
  const parentToolCallId = readSdkNestedToolCallId(record);
  const failedCodemode = resolveCodemodeMetadata({
    name: displayName,
    callInput: toolInput,
    ...(message ? { output: message } : {}),
    ...(record.codemodeDetails !== undefined ? { details: record.codemodeDetails } : {}),
  });
  return {
    name: displayName,
    ...(detail && { detail }),
    ...(isExecutionFailure && outputPreview?.text && { outputPreview: outputPreview.text }),
    ...(isExecutionFailure && outputPreview?.truncated && { outputPreviewTruncated: true }),
    ...(typeof record.tool_use_id === "string" && { toolUseId: record.tool_use_id }),
    ...(fileChange && { fileChange }),
    ...(targets.readTarget && { readTarget: targets.readTarget }),
    ...(targets.grepTarget && { grepTarget: targets.grepTarget }),
    ...(failedImageViewMeta && { imageView: failedImageViewMeta }),
    ...(mcpDiscovery && { mcpDiscovery }),
    ...(nonExecutionKind && { nonExecutionKind }),
    ...(parentToolCallId && { parentToolCallId }),
    ...(failedCodemode && { codemode: failedCodemode }),
    status: "failed",
  };
}

export function isSdkToolInputPlaceholder(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "tool_use") {
    return false;
  }
  const toolUseId = readString(record.tool_use_id);
  if (!toolUseId) {
    if (record.streaming === true) {
      return true;
    }
    const input = record.input;
    return !input || (typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0);
  }
  if (record.streaming !== true || record.input_complete === true) {
    return false;
  }
  const input = record.input;
  return !input || (typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0);
}

function resolveSdkAgentStatusActivity(
  payload: unknown,
): { type: string; message: string; metadata?: Record<string, unknown> } | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (
    record.type === "rate_limit_event" &&
    record.rate_limit_info &&
    typeof record.rate_limit_info === "object"
  ) {
    const info = record.rate_limit_info as Record<string, unknown>;
    return {
      type: "request.rate_limit",
      message:
        info.status === "rejected"
          ? "Rate limit reached; waiting for quota reset."
          : `Rate limit: ${String(info.status)}`,
      metadata: { activityOrigin: "sdk.rate_limit_event", rateLimitInfo: info },
    };
  }
  if (record.type === "conversation_reset")
    return { type: "sdk.conversation_reset", message: "Conversation context reset.", metadata: record };
  if (record.type !== "system") {
    return undefined;
  }
  if (record.subtype === "informational" && typeof record.content === "string")
    return {
      type: "sdk.notice",
      message: record.content,
      metadata: { activityOrigin: "sdk.informational", level: record.level, tag: record.tag },
    };
  if (record.subtype === "session_state_changed")
    return {
      type: "sdk.session_state",
      message: `Session state: ${String(record.state)}`,
      metadata: { activityOrigin: "sdk.session_state_changed", state: record.state },
    };
  if (record.subtype === "commands_changed")
    return {
      type: "sdk.commands_changed",
      message: "Available commands updated.",
      metadata: { activityOrigin: "sdk.commands_changed", commands: record.commands },
    };
  if (record.subtype === "status") {
    if (record.status === "requesting") {
      return { type: "request.started", message: "Requesting model…" };
    }
    if (record.status === "compacting") {
      return { type: "agent.started", message: "Compacting context…" };
    }
  }
  if (record.subtype === "compact_boundary") {
    return { type: "agent.started", message: "Compacting context…" };
  }
  if (record.subtype === "api_retry") {
    const attempt = typeof record.attempt === "number" ? record.attempt : undefined;
    const maxRetries = typeof record.max_retries === "number" ? record.max_retries : undefined;
    const attemptLabel = attempt ?? "?";
    const maxLabel = maxRetries ?? "?";
    return {
      type: "request.retry_scheduled",
      message: `API retry ${attemptLabel}/${maxLabel}…`,
      metadata: {
        activityOrigin: "sdk.api_retry",
        ...(attempt !== undefined &&
          maxRetries !== undefined && {
            retry: { attempt, maxRetries },
          }),
      },
    };
  }
  return undefined;
}

function readBashDescriptionFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>).description;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The Feed preview needs the path to load the image and the caller's prompt to explain
 * the answer the vision model returned; the call carries both.
 */
function toImageViewMetadata(
  call: ReturnType<typeof resolveEcoImageViewToolCall>,
): ThreadRunImageViewMetadata | undefined {
  return parseThreadRunImageViewMetadata(call);
}

function resolveSdkImageViewAndMcpDiscovery(
  name: string,
  input: unknown,
): {
  displayName: string;
  imageViewCall: ReturnType<typeof resolveEcoImageViewToolCall>;
  imageDisplayCall: ReturnType<typeof resolveEcoImageDisplayToolCall>;
  htmlHostCall: ReturnType<typeof resolveEcoHtmlHostToolCall>;
  mcpDiscovery: ReturnType<typeof resolvePiMcpProxyDiscoveryCall>;
} {
  const imageViewCall = resolveEcoImageViewToolCall(name, input);
  const imageDisplayCall = imageViewCall ? undefined : resolveEcoImageDisplayToolCall(name, input);
  const htmlHostCall =
    imageViewCall || imageDisplayCall ? undefined : resolveEcoHtmlHostToolCall(name, input);
  const displayName = imageViewCall?.name ?? imageDisplayCall?.name ?? htmlHostCall?.name ?? name;
  return {
    displayName,
    imageViewCall,
    imageDisplayCall,
    htmlHostCall,
    mcpDiscovery:
      imageViewCall || imageDisplayCall || htmlHostCall
        ? undefined
        : resolvePiMcpProxyDiscoveryCall(name, input),
  };
}

function resolveSdkToolUseMetadata(payload: unknown): ThreadRunToolMetadata | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "tool_use" || typeof record.tool_name !== "string" || !record.tool_name.trim()) {
    return undefined;
  }
  const name = record.tool_name.trim();
  const identity = resolveSdkMcpToolIdentity(name, record.input);
  const displayName = identity.displayName;
  const toolInput = identity.toolInput;
  const { imageViewCall, mcpDiscovery: imageMcpDiscovery } = resolveSdkImageViewAndMcpDiscovery(
    displayName,
    toolInput,
  );
  const mcpDiscovery = identity.mcpDiscovery ?? imageMcpDiscovery;
  const skillName = resolveSdkSkillDisplayName(displayName, isRecord(toolInput) ? toolInput : {});
  const skillDetail = skillName ? `读取 ${skillName} 技能` : undefined;
  // Skill reads (e.g. pi `read` on SKILL.md) label by skill name; skip file targets so
  // the card does not fall back to "读取 SKILL.md".
  const targets = skillDetail ? {} : resolveThreadRunToolTargets(displayName, toolInput);
  const detail =
    skillDetail ||
    imageViewCall?.path ||
    imageViewCall?.ref ||
    (targets.readTarget && formatThreadRunReadTargetLabel(targets.readTarget)) ||
    (targets.grepTarget && formatThreadRunGrepTargetLabel(targets.grepTarget)) ||
    resolveSdkToolDisplayDetail(displayName, toolInput);
  const toolUseId = readString(record.tool_use_id);
  const parentToolCallId = readSdkNestedToolCallId(record);
  const description = displayName === "Bash" ? readBashDescriptionFromToolInput(toolInput) : undefined;
  const fileChange = isFileChangeToolName(displayName)
    ? resolveFileChangeFromToolInput(displayName, toolInput)
    : undefined;
  const sendMessage = displayName === "SendMessage" ? readSendMessageToolInput(toolInput) : undefined;
  const webSearch = resolveEcoWebSearchToolMetadata(displayName, toolInput);
  const imageViewMeta = toImageViewMetadata(imageViewCall);
  return {
    name: displayName,
    ...(detail && { detail }),
    ...(toolUseId && { toolUseId }),
    ...(description && { description }),
    ...(fileChange && { fileChange }),
    ...(targets.readTarget && { readTarget: targets.readTarget }),
    ...(targets.grepTarget && { grepTarget: targets.grepTarget }),
    ...(sendMessage && { sendMessage }),
    ...(imageViewMeta && { imageView: imageViewMeta }),
    ...(mcpDiscovery && { mcpDiscovery }),
    ...(webSearch && { webSearch }),
    ...(parentToolCallId && { parentToolCallId }),
    status: "started",
  };
}

function resolveSdkToolProgressMetadata(payload: unknown): ThreadRunToolMetadata | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.type !== "tool_progress") {
    return undefined;
  }
  const name = readString(record.tool_name);
  if (!name) {
    return undefined;
  }
  const identity = resolveSdkMcpToolIdentity(name, record.input);
  const displayName = identity.displayName;
  const { imageViewCall, mcpDiscovery: imageMcpDiscovery } = resolveSdkImageViewAndMcpDiscovery(
    displayName,
    identity.toolInput,
  );
  const imageViewMeta = toImageViewMetadata(imageViewCall);
  const mcpDiscovery = identity.mcpDiscovery ?? imageMcpDiscovery;
  const elapsedSeconds =
    typeof record.elapsed_time_seconds === "number" ? record.elapsed_time_seconds : undefined;
  const toolUseId = readString(record.tool_use_id);
  return {
    name: displayName,
    ...(imageViewCall?.path && { detail: imageViewCall.path }),
    ...(imageViewCall?.ref && !imageViewCall.path && { detail: imageViewCall.ref }),
    ...(toolUseId && { toolUseId }),
    ...(elapsedSeconds !== undefined &&
      Number.isFinite(elapsedSeconds) && { durationMs: elapsedSeconds * 1000 }),
    ...(imageViewMeta && { imageView: imageViewMeta }),
    ...(mcpDiscovery && { mcpDiscovery }),
  };
}

function resolveSdkTaskProgressToolMetadata(payload: unknown): ThreadRunToolMetadata | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.sdkKind !== "task_progress") {
    return undefined;
  }
  const name = readString(record.last_tool_name);
  if (!name) {
    return undefined;
  }
  const detail = readString(record.description);
  return {
    name,
    ...(detail && { detail }),
  };
}

function resolveSdkToolDisplayDetail(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const taskDetail = resolveSdkTaskToolDisplayDetail(toolName, record);
  if (taskDetail) {
    return taskDetail;
  }
  if (toolName === "SendMessage") {
    return formatSendMessageToolInputSummary(record);
  }
  if (toolName === "AskUserQuestion") {
    const questions = Array.isArray(record.questions) ? record.questions : undefined;
    const first = questions?.[0];
    if (first && typeof first === "object" && !Array.isArray(first)) {
      const question = readString((first as Record<string, unknown>).question);
      if (question) {
        const short = question.length > 48 ? `${question.slice(0, 45)}…` : question;
        return questions.length > 1 ? `澄清 ${questions.length} 个问题 · ${short}` : short;
      }
    }
    return questions && questions.length > 1 ? `澄清 ${questions.length} 个问题` : "澄清问题";
  }
  const skillName = resolveSdkSkillDisplayName(toolName, record);
  if (skillName) {
    return `读取 ${skillName} 技能`;
  }
  if (toolName === "Agent") {
    const label = normalizeSubagentToolDisplayLabel(
      readString(record.subagent_type) ?? readString(record.agent_type),
    );
    if (!label) {
      return undefined;
    }
    const taskPrompt = readString(record.prompt);
    if (!taskPrompt) {
      return label;
    }
    const summary = taskPrompt.length > 60 ? `${taskPrompt.slice(0, 57)}…` : taskPrompt;
    return `${label} · ${summary}`;
  }
  const filePath = readString(record.file_path) ?? readString(record.path);
  const command =
    readString(record.full_command) ?? readString(record.bash_command) ?? readString(record.command);
  return (
    (filePath ? pathBasename(filePath) : undefined) ??
    command ??
    readString(record.pattern) ??
    readString(record.query) ??
    readString(record.url)
  );
}

function resolveSdkTaskToolDisplayDetail(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName === "TaskCreate") {
    return readFirstSdkString(input, "subject", "activeForm", "active_form", "description");
  }
  if (toolName === "TaskUpdate") {
    const subject = readFirstSdkString(input, "subject", "activeForm", "active_form");
    if (subject) {
      return subject;
    }
    const taskId = readFirstSdkString(input, "taskId", "task_id");
    const status = formatSdkTaskStatus(readFirstSdkString(input, "status"));
    return [taskId ? `#${taskId}` : undefined, status].filter(Boolean).join(" · ") || undefined;
  }
  if (toolName === "TodoWrite" && Array.isArray(input.todos)) {
    return `${input.todos.length} 项`;
  }
  return undefined;
}

function readFirstSdkString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(input[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function formatSdkTaskStatus(status: string | undefined): string | undefined {
  if (!status) {
    return undefined;
  }
  return (
    {
      pending: "待处理",
      in_progress: "进行中",
      completed: "已完成",
      deleted: "已删除",
    }[status] ?? status
  );
}

function normalizeSubagentToolDisplayLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.startsWith("eco_") ? trimmed.slice(4) : trimmed;
  const roleLabels: Record<string, string> = {
    explore: "探索",
    architect: "架构",
    coder: "编码",
    reviewer: "审查",
    tester: "测试",
  };
  return roleLabels[normalized] ?? normalized;
}

function resolveSdkSkillDisplayName(toolName: string, record: Record<string, unknown>): string | undefined {
  const resolved = resolveSkillDisplayName(toolName, record);
  if (resolved) {
    return resolved;
  }
  const candidate =
    readString(record.skill_name) ??
    readString(record.skill) ??
    readString(record.name) ??
    readString(record.display_name);
  if (!candidate) {
    return undefined;
  }
  if (/skill/i.test(toolName) || /skill/i.test(candidate)) {
    return candidate.replace(/\s*技能\s*$/u, "").trim();
  }
  return undefined;
}

function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readToolResultText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const joined = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const text = (entry as Record<string, unknown>).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return joined || undefined;
  }
  return undefined;
}

function resolveEcoWebSearchToolMetadata(
  toolName: string,
  input: unknown,
  output?: string,
): ThreadRunToolMetadata["webSearch"] | undefined {
  const normalized = toolName.trim();
  const isPiOrNativeSearch = normalized === "WebSearch" || normalized.toLowerCase() === "web_search";
  if (!isEcoWebSearchToolName(normalized) && !isPiOrNativeSearch) {
    return undefined;
  }
  const queryFromInput = readEcoWebSearchQuery(input);
  const parsed = output ? parseEcoWebSearchToolOutput(output) : undefined;
  const query = queryFromInput ?? parsed?.query;
  const results = parsed?.results?.length
    ? parsed.results.map((entry) => ({
        title: entry.title,
        url: entry.url,
        ...(entry.description ? { description: entry.description } : {}),
      }))
    : undefined;
  // Native WebSearch with no SERP payload still gets a query card (note-only).
  if (!query && !results && !parsed?.provider) {
    return isPiOrNativeSearch
      ? {
          mode: "search",
          actionType: "search",
        }
      : undefined;
  }
  return {
    mode: "search",
    actionType: "search",
    ...(query ? { query } : {}),
    ...(parsed?.provider ? { provider: parsed.provider } : {}),
    ...(results ? { results } : {}),
  };
}

/** Zed `can_merge_message_chunks`: equal ids merge; a missing id on either side still appends. */
function canMergeAcpMessageIds(existing?: string, incoming?: string): boolean {
  if (existing && incoming) {
    return existing === incoming;
  }
  return true;
}

function readThinkingStartedAtFromExtras(extras?: {
  metadata?: Record<string, unknown>;
}): string | undefined {
  const value = extras?.metadata?.thinkingStartedAt;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function withThinkingStartedAt(
  extras: { tool?: ThreadRunToolMetadata; metadata?: Record<string, unknown> } | undefined,
  role: string,
  previousExtras?: { metadata?: Record<string, unknown> },
): { tool?: ThreadRunToolMetadata; metadata?: Record<string, unknown> } | undefined {
  const startedAt =
    readThinkingStartedAtFromExtras(extras) ??
    readThinkingStartedAtFromExtras(previousExtras) ??
    (role === "thinking" ? new Date().toISOString() : undefined);
  if (!startedAt) {
    return extras;
  }
  return {
    ...extras,
    metadata: {
      ...extras?.metadata,
      thinkingStartedAt: startedAt,
    },
  };
}

function mergeSdkActivityEmitExtras(
  message: string,
  tool?: ThreadRunToolMetadata,
  payload?: unknown,
  allocatedStreamBlockKey?: string,
): { tool?: ThreadRunToolMetadata; metadata?: Record<string, unknown> } | undefined {
  const activityOrigin = classifySdkStreamMessageOrigin(message);
  const sdkStreamBlockKey = allocatedStreamBlockKey ?? readSdkStreamIdentityKey(payload);
  const sdkMessageId = readSdkMessageId(payload);
  const taskMetadata = readSdkTaskReconciliationMetadata(payload);
  const payloadRecord =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const reasoningDisplayFromPayload =
    payloadRecord?.reasoningDisplay === "summary" || payloadRecord?.reasoningDisplay === "raw"
      ? payloadRecord.reasoningDisplay
      : undefined;
  const metadata =
    activityOrigin || sdkStreamBlockKey || sdkMessageId || taskMetadata || reasoningDisplayFromPayload
      ? {
          ...(activityOrigin && { activityOrigin }),
          ...(sdkStreamBlockKey && { sdkStreamBlockKey }),
          ...(sdkMessageId && { sdkMessageId }),
          ...(taskMetadata ?? {}),
          ...(reasoningDisplayFromPayload && { reasoningDisplay: reasoningDisplayFromPayload }),
        }
      : undefined;
  if (!tool && !metadata) {
    return undefined;
  }
  return {
    ...(tool && { tool }),
    ...(metadata && { metadata }),
  };
}
