/**
 * What an activity event says, and whether it may be recorded at all.
 *
 * An event with no text of its own is normally noise — a status flip, an empty stream chunk —
 * and is dropped. Two kinds are not: the ones whose payload lives in extras (a plan, an
 * approval request) and the ones whose payload is metadata (`tool.writing` says what is being
 * written, not a sentence about it). The last group is why this is a rule instead of a
 * `if (!message) return`.
 */
import { isMetadataOnlyThreadLiveEvent } from "./thread-run-event-normalizer";

export interface EmitThreadEventMessageDecision {
  /** Nothing to record and nothing in extras: do not touch the thread. */
  drop: boolean;
  /** What the durable row carries. */
  persistedMessage: string;
  /** What the live event carries, with no placeholder standing in for real content. */
  liveMessage: string;
}

/** The extras a thread event can carry its payload in instead of a sentence. */
export interface StructuredThreadEventExtras {
  plan?: unknown;
  planApproval?: unknown;
  clarification?: unknown;
  bashApproval?: unknown;
  followUp?: unknown;
  subagentSessions?: readonly unknown[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * A plan, an approval, a question or a batch of subagents is the event's subject: the row is worth
 * keeping even though nothing about it reads as a sentence. Bridged events carry some of these
 * inside `metadata` rather than on the extras themselves, so both places are looked at.
 */
export function hasStructuredThreadEventExtras(extras: StructuredThreadEventExtras | undefined): boolean {
  const metadata = extras?.metadata ?? {};
  return Boolean(
    extras?.plan ||
      extras?.planApproval ||
      extras?.clarification ||
      extras?.bashApproval ||
      extras?.followUp ||
      extras?.subagentSessions?.length ||
      metadata.plan ||
      metadata.planApproval ||
      metadata.clarification ||
      metadata.followUp,
  );
}

export function resolveEmitThreadEventMessage(input: {
  type: string;
  /** Already repaired and trimmed. */
  message: string;
  stream: boolean;
  /** A plan, approval or follow-up the event carries instead of a sentence. */
  hasStructuredExtras: boolean;
  hasPlan: boolean;
}): EmitThreadEventMessageDecision {
  const { type, message, stream } = input;
  const isSilentFollowUpEvent = type.startsWith("thread.follow_up.");
  const isMetadataOnlyEvent = isMetadataOnlyThreadLiveEvent(type);
  const allowEmptyStream = stream && message.length === 0;
  // Every `thread.*` row counts as a status flip, which covers the usage / context / subagent
  // timing rows the Feed hides: they are still recorded, they just have nothing to say.
  const drop =
    !message &&
    !allowEmptyStream &&
    !isMetadataOnlyEvent &&
    !input.hasStructuredExtras &&
    !type.startsWith("thread.");
  const persistedMessage = isSilentFollowUpEvent
    ? ""
    : message || (type.startsWith("thread.") ? "状态已更新" : "");
  return {
    drop,
    persistedMessage,
    liveMessage:
      persistedMessage ||
      (input.hasPlan ? "计划已就绪" : isMetadataOnlyEvent || isSilentFollowUpEvent ? "" : "状态已更新"),
  };
}
