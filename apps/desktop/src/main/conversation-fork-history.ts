import { createHash } from "node:crypto";
import type {
  ConversationAgent,
  ConversationDetailItem,
  ConversationEventInput,
  ConversationMessage,
  ConversationRun,
  ConversationToolCall,
} from "@eco/shared";
import type { ThreadRunEvent } from "../shared/thread-run-events";

export interface ConversationForkHistory {
  sourceThreadId: string;
  sourceHeadSeq: number;
  codexTurnIds?: Record<string, string>;
  target: ConversationMessage;
  /** Present for an inclusive assistant-turn fork; its user has the stable native identity. */
  boundaryUser?: ConversationMessage;
  messages: ConversationMessage[];
  runs: ConversationRun[];
  runPayloads: Record<string, Record<string, unknown>>;
  tools: ConversationToolCall[];
  details: ConversationDetailItem[];
  agents: ConversationAgent[];
  sources: ThreadRunEvent[];
}

export function forkHistoryId(childId: string, id: string): string {
  return `fork_${createHash("sha256").update(`${childId}:${id}`).digest("hex")}`;
}

/** Copy current read models, never replay tombstoned/abandoned source history. */
export function buildForkHistoryEvents(
  history: ConversationForkHistory,
  childId: string,
  userIds: Record<string, string>,
): ConversationEventInput[] {
  const ids = new Map<string, string>();
  ids.set(history.sourceThreadId, childId);
  const remember = (id: string | undefined) => {
    if (id) ids.set(id, forkHistoryId(childId, id));
  };
  for (const message of history.messages) {
    remember(message.messageId);
    remember(message.turnId);
    remember(message.runId);
    remember(message.historyTarget?.activityLineId);
  }
  for (const run of history.runs) {
    remember(run.runId);
    remember(run.turnId);
  }
  for (const tool of history.tools) {
    remember(tool.toolCallId);
    remember(tool.parentToolCallId);
  }
  for (const agent of history.agents) remember(agent.agentId);
  for (const detail of history.details) remember(detail.itemId);
  for (const source of history.sources) {
    remember(source.id);
    remember(source.streamKey);
  }
  const id = (value: string | undefined) =>
    value ? (ids.get(value) ?? forkHistoryId(childId, value)) : undefined;
  const result: ConversationEventInput[] = [];
  type DraftEvent = {
    [K in keyof Omit<ConversationEventInput, "conversationId" | "eventId" | "sourceEventKey">]:
      | ConversationEventInput[K]
      | undefined;
  };
  const append = (kind: string, sourceId: string, input: DraftEvent) =>
    result.push(
      Object.fromEntries(
        Object.entries({
          ...input,
          conversationId: childId,
          eventId: forkHistoryId(childId, `${kind}:${sourceId}`),
          sourceEventKey: `fork:${kind}:${sourceId}`,
        }).filter(([, value]) => value !== undefined),
      ) as unknown as ConversationEventInput,
    );
  for (const run of history.runs)
    append("run", run.runId, {
      type:
        run.status === "completed"
          ? "run.completed"
          : run.status === "failed"
            ? "run.failed"
            : run.status === "cancelled"
              ? "run.cancelled"
              : "run.interrupted",
      runId: id(run.runId),
      turnId: id(run.turnId),
      occurredAt: run.endedAt ?? run.startedAt ?? history.target.occurredAt ?? new Date().toISOString(),
      payload: {
        ...(remapForkReferences(history.runPayloads[run.runId] ?? {}, ids) as Record<string, unknown>),
        authority: "lifecycle",
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        timingQuality: run.timingQuality,
      },
    });
  for (const agent of history.agents)
    append("agent", agent.agentId, {
      type:
        agent.status === "failed"
          ? "agent.failed"
          : agent.status === "cancelled"
            ? "agent.cancelled"
            : agent.status === "completed"
              ? "agent.completed"
              : "agent.interrupted",
      agentId: id(agent.agentId),
      agentInstanceId: id(agent.agentId),
      runId: id(agent.runId),
      parentAgentInstanceId: id(agent.parentAgentInstanceId),
      parentToolCallId: id(agent.parentToolCallId),
      occurredAt: agent.endedAt ?? history.target.occurredAt ?? new Date().toISOString(),
      payload: {
        ...Object.fromEntries(Object.entries(agent).filter(([key]) => key !== "todoId")),
        agentId: id(agent.agentId),
        conversationId: childId,
        runId: id(agent.runId),
        parentAgentInstanceId: id(agent.parentAgentInstanceId),
        parentToolCallId: id(agent.parentToolCallId),
        status: agent.status,
      },
    });
  for (const message of history.messages) {
    const activityLineId = id(message.historyTarget?.activityLineId ?? message.messageId);
    const userMessageId = userIds[message.messageId];
    if (message.role === "user" && !userMessageId) throw new Error("分叉历史缺少已验证的用户消息身份。");
    append("message", message.messageId, {
      type: "message.created",
      messageId: id(message.messageId),
      turnId: id(message.turnId),
      runId: id(message.runId),
      agentId: id(message.agentId),
      agentInstanceId: id(message.agentInstanceId),
      occurredAt: message.occurredAt ?? history.target.occurredAt ?? new Date().toISOString(),
      payload: {
        role: message.role,
        channel: message.channel,
        body: message.body,
        status: message.status,
        providerRole: message.providerRole,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(message.role === "user" ? { historyTarget: { activityLineId, userMessageId } } : {}),
      },
    });
  }
  for (const tool of history.tools)
    append("tool", tool.toolCallId, {
      type: tool.status === "failed" ? "tool.failed" : "tool.completed",
      toolCallId: id(tool.toolCallId),
      runId: id(tool.runId),
      agentId: id(tool.agentId),
      agentInstanceId: id(tool.agentInstanceId),
      parentAgentInstanceId: id(tool.parentAgentInstanceId),
      parentToolCallId: id(tool.parentToolCallId),
      occurredAt: tool.occurredAt ?? history.target.occurredAt ?? new Date().toISOString(),
      payload: {
        name: tool.name,
        status: tool.status,
        input: tool.input,
        output: tool.output,
        providerRole: tool.providerRole,
      },
    });
  for (const detail of history.details) {
    // Interactive requests and runtime ownership are deliberately not inherited.
    if (/approval|clarification|plan\.(ready|pending)/.test(detail.type)) continue;
    let content = detail.content;
    if (content) {
      try {
        content = JSON.stringify(remapForkReferences(JSON.parse(content), ids));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    append("detail", detail.itemId, {
      type: "detail.upserted",
      runId: id(detail.runId),
      toolCallId: id(detail.toolCallId),
      agentId: id(detail.agentId),
      agentInstanceId: id(detail.agentInstanceId),
      parentAgentInstanceId: id(detail.parentAgentInstanceId),
      parentToolCallId: id(detail.parentToolCallId),
      occurredAt: history.target.occurredAt ?? new Date().toISOString(),
      payload: {
        itemId: id(detail.itemId),
        detailType: detail.type,
        content,
        ref: detail.ref ? (ids.get(detail.ref) ?? detail.ref) : undefined,
      },
    });
  }
  for (const source of history.sources) {
    const mapped = remapForkReferences(source, ids) as ThreadRunEvent;
    const originalMessageId =
      typeof source.metadata?.conversationV2MessageId === "string"
        ? source.metadata.conversationV2MessageId
        : undefined;
    const userMessageId = originalMessageId ? userIds[originalMessageId] : undefined;
    const storedSource = {
      ...mapped,
      id: id(source.id),
      threadId: childId,
      sequence: 0,
      metadata: {
        ...mapped.metadata,
        ...(userMessageId
          ? {
              rewindTarget: {
                activityLineId: id(
                  history.messages.find((message) => message.messageId === originalMessageId)?.historyTarget
                    ?.activityLineId ?? originalMessageId,
                ),
                userMessageId,
              },
            }
          : {}),
      },
    };
    append("source", source.id, {
      type: "noop",
      occurredAt: source.observedAt,
      runId: id(source.runAttemptId),
      ...(originalMessageId ? { messageId: id(originalMessageId) } : {}),
      payload: {
        reason: "runtime.input",
        source: storedSource,
        ...(originalMessageId ? {} : { message: source.message }),
      },
    });
  }
  return result;
}

const ID_KEYS = new Set([
  "id",
  "messageId",
  "turnId",
  "runId",
  "runAttemptId",
  "retryOfRunId",
  "regenerationOfRunId",
  "threadId",
  "conversationId",
  "requestId",
  "agentId",
  "agentInstanceId",
  "parentAgentId",
  "parentAgentInstanceId",
  "parentToolCallId",
  "parentToolUseId",
  "toolCallId",
  "toolUseId",
  "itemId",
  "streamKey",
  "activityLineId",
  "conversationV2MessageId",
]);
function remapForkReferences(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => remapForkReferences(item, ids));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      ID_KEYS.has(key) && typeof item === "string" && ids.has(item)
        ? ids.get(item)
        : remapForkReferences(item, ids),
    ]),
  );
}
