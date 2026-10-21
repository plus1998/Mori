import type { CodexAsyncQuestionsInput } from "@eco/runtime";
import { buildClarificationToolMetadata, formatClarificationAnswersSummary } from "./clarification-bridge";
import type { ThreadRunToolMetadata } from "../shared/thread-run-events";
import type { AcceptedConversationMessageSchedule } from "./conversation-v2-request";
import { describeFollowUpDelivery } from "../shared/conversation-message-delivery";
import {
  buildCodexAsyncClarificationRequest,
  buildCodexAsyncQuestionReplies,
  buildCodexAsyncQuestionReplyText,
  codexAsyncQuestionDedupeKey,
  type CodexAsyncQuestionRefs,
} from "../shared/codex-async-questions";
import type {
  ClarificationAnswers,
  ClarificationAsyncDelivery,
  ClarificationRequest,
  ThreadFollowUpEnqueueRequest,
  ThreadFollowUpMutationResult,
  ThreadStatus,
  ThreadSummary,
} from "../shared/ipc";

/**
 * Codex async questions (`request_user_input_async`) against Eco's clarification panel.
 *
 * The question rides on an `agentMessage` item while the turn keeps running, so it is shown
 * through the clarification UI but must never gate the run: it registers as a non-blocking
 * pending entry, and the answer is delivered as an ordinary conversation message — Codex
 * `turn/steer` while the turn runs, a normal continuation after it ends.
 */

export interface CodexAsyncQuestionBridgeDeps {
  getThread(threadId: string): ThreadSummary | undefined;
  emitEvent(
    threadId: string,
    type: string,
    message: string,
    role: "main" | "system",
    extras?: { clarification?: ClarificationRequest; tool?: ThreadRunToolMetadata },
  ): void;
  registerPending(
    threadId: string,
    toolUseId: string,
    parsed: { questions: ClarificationRequest["questions"]; delivery: "async"; blocking: false },
  ): Promise<ClarificationAnswers>;
  getPending(toolUseId: string): ClarificationRequest | undefined;
  submitPending(toolUseId: string, answers: ClarificationAnswers): boolean;
  headHistoryRevision(threadId: string): number;
  enqueueFollowUp(request: ThreadFollowUpEnqueueRequest): Promise<ThreadFollowUpMutationResult>;
  sendMessage(input: {
    principalId: string;
    conversationId: string;
    clientCommandId: string;
    text: string;
  }): { messageId: string; turnId: string };
  scheduleAcceptedMessage(input: {
    conversationId: string;
    messageId: string;
    turnId: string;
    text: string;
  }): Promise<ClarificationAsyncDelivery>;
  errorMessage(error: unknown): string;
  logDiag?(event: string, payload: Record<string, unknown>): void;
}

/** Bounded so a long session cannot accumulate every question it ever saw. */
const TRACK_LIMIT = 512;

let deps: CodexAsyncQuestionBridgeDeps | undefined;
const refsByToolUseId = new Map<string, CodexAsyncQuestionRefs>();
/** thread + turn + message id of every async question message already shown. */
const seenQuestionKeys = new Set<string>();
/** outcome per derived command id, so a replayed submit reports what really happened. */
const deliveryByCommandId = new Map<string, ClarificationAsyncDelivery>();
/** async questions the user dropped; their resolution is a dismissal, not an answer. */
const dismissedToolUseIds = new Set<string>();

export function configureCodexAsyncQuestionBridge(next: CodexAsyncQuestionBridgeDeps): void {
  deps = next;
}

/** Reset all per-process state. Tests only. */
export function resetCodexAsyncQuestionBridge(): void {
  refsByToolUseId.clear();
  seenQuestionKeys.clear();
  deliveryByCommandId.clear();
  dismissedToolUseIds.clear();
}

function requireDeps(): CodexAsyncQuestionBridgeDeps {
  if (!deps) {
    throw new Error("Codex async question bridge is not configured.");
  }
  return deps;
}

function rememberBounded<T>(store: Map<string, T> | Set<string>, key: string, value?: T): void {
  if (store instanceof Map) {
    store.set(key, value as T);
  } else {
    store.add(key);
  }
  while (store.size > TRACK_LIMIT) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    store.delete(oldest);
  }
}

/**
 * Show one async question message in the clarification panel.
 *
 * Deduped on thread + turn + message id: app-server emits the same item on `item/started`
 * and `item/completed`, and a resumed thread can replay it, but it is one question.
 */
export function handleCodexAsyncQuestions(input: CodexAsyncQuestionsInput): void {
  const bridge = requireDeps();
  if (!bridge.getThread(input.ecoThreadId)) {
    return;
  }
  const dedupeKey = codexAsyncQuestionDedupeKey({
    ecoThreadId: input.ecoThreadId,
    turnId: input.turnId,
    itemId: input.itemId,
  });
  if (seenQuestionKeys.has(dedupeKey) || refsByToolUseId.has(input.itemId)) {
    return;
  }

  const { request, refs } = buildCodexAsyncClarificationRequest({
    ecoThreadId: input.ecoThreadId,
    messageId: input.itemId,
    questions: input.questions,
  });
  rememberBounded(seenQuestionKeys, dedupeKey);
  rememberBounded(refsByToolUseId, input.itemId, refs);

  const answersPromise = bridge.registerPending(input.ecoThreadId, input.itemId, {
    questions: request.questions,
    delivery: "async",
    blocking: false,
  });
  bridge.emitEvent(
    input.ecoThreadId,
    "clarification.requested",
    request.questions.length === 1
      ? "Codex 需要你回答一个问题（本轮会继续执行）。"
      : `Codex 需要你回答 ${request.questions.length} 个问题（本轮会继续执行）。`,
    "main",
    {
      clarification: request,
      tool: buildClarificationToolMetadata(input.itemId, "started"),
    },
  );
  void answersPromise.then(
    (answers) => {
      if (dismissedToolUseIds.delete(input.itemId)) {
        refsByToolUseId.delete(input.itemId);
        bridge.emitEvent(
          input.ecoThreadId,
          "clarification.dismissed",
          "问题已忽略，Codex 不会收到回答。",
          "system",
          { tool: buildClarificationToolMetadata(input.itemId, "completed") },
        );
        return;
      }
      bridge.emitEvent(
        input.ecoThreadId,
        "clarification.answered",
        formatClarificationAnswersSummary(request, answers),
        "main",
        { tool: buildClarificationToolMetadata(input.itemId, "completed") },
      );
    },
    (error: unknown) => {
      // Run cleanup / cancel dropped the panel before an answer arrived. The question is
      // gone, so its reply addressing must go too instead of pointing at nothing.
      refsByToolUseId.delete(input.itemId);
      dismissedToolUseIds.delete(input.itemId);
      bridge.emitEvent(
        input.ecoThreadId,
        "clarification.dismissed",
        `问题已取消：${bridge.errorMessage(error)}`,
        "system",
        { tool: buildClarificationToolMetadata(input.itemId, "failed") },
      );
    },
  );
}

/** Mark an async question as dropped so its resolution reads as a dismissal, not an answer. */
export function markCodexAsyncQuestionDismissed(toolUseId: string): void {
  if (refsByToolUseId.has(toolUseId)) {
    rememberBounded(dismissedToolUseIds, toolUseId);
  }
}

/** True when the toolUseId belongs to an async question this process is tracking. */
export function isTrackedCodexAsyncQuestion(toolUseId: string): boolean {
  return refsByToolUseId.has(toolUseId);
}

/**
 * Release the pending entry so its awaiting handler (blocking RPC) or panel sees the answer.
 *
 * The answer itself is already recorded in the V2 command, so a missing entry means the
 * question was already released or cancelled by cleanup — never that the answer was lost.
 */
export function releasePendingClarification(toolUseId: string, answers: ClarificationAnswers): void {
  const bridge = requireDeps();
  if (bridge.submitPending(toolUseId, answers)) {
    return;
  }
  bridge.logDiag?.("clarification.release_missing_pending", { toolUseId });
}

/** Build the reply before command acceptance so recovery never depends on in-memory refs. */
export function prepareAsyncClarificationReply(input: {
  threadId: string;
  toolUseId: string;
  answers: ClarificationAnswers;
}): string | undefined {
  const bridge = requireDeps();
  const pending = bridge.getPending(input.toolUseId);
  if (pending?.delivery !== "async") return undefined;
  if (pending.threadId !== input.threadId) throw new Error("Async question belongs to another conversation.");
  const refs = refsByToolUseId.get(input.toolUseId);
  if (!refs) throw new Error("Async question reply addressing is missing; refusing to drop the answer.");
  const replies = buildCodexAsyncQuestionReplies({ refs: refs.refs, answers: input.answers });
  if (replies.length !== refs.refs.length) throw new Error("Every async question requires an answer.");
  return buildCodexAsyncQuestionReplyText(replies);
}

/**
 * Send an async answer into the Codex conversation.
 *
 * The caller has already persisted the answer through the V2 command acceptance, so this
 * only moves it into the stream the run reads: a live turn takes it as a follow-up (Codex
 * `turn/steer` mid-turn, normal drain after the run), an idle thread takes it as a plain
 * continuation. `commandIdempotencyKey` comes from the submitting command, so a replayed
 * submit cannot post the same answer twice while a deliberate retry still can.
 *
 * Returns undefined for anything that is not a tracked async question — a blocking
 * `item/tool/requestUserInput` is answered by the RPC response itself.
 */
export async function deliverAsyncClarificationAnswers(input: {
  threadId: string;
  toolUseId: string;
  answers: ClarificationAnswers;
  commandIdempotencyKey: string;
  principalId?: string;
  acceptedMessage?: AcceptedConversationMessageSchedule;
}): Promise<ClarificationAsyncDelivery | undefined> {
  const bridge = requireDeps();
  const refs = refsByToolUseId.get(input.toolUseId);
  if (!refs && !input.acceptedMessage) {
    return undefined;
  }
  const commandId = `async-clarification:${input.commandIdempotencyKey}`;
  const settled = deliveryByCommandId.get(commandId);
  if (settled) {
    return settled;
  }
  const remember = (delivery: ClarificationAsyncDelivery): ClarificationAsyncDelivery => {
    // `unknown` stays uncached: a deliberate resend must be able to try again.
    if (delivery.state !== "unknown") {
      rememberBounded(deliveryByCommandId, commandId, delivery);
    }
    return delivery;
  };

  const thread = bridge.getThread(input.threadId);
  if (!thread) {
    return { state: "unknown", message: "对话不存在，回答未投递。" };
  }
  if (input.acceptedMessage && input.acceptedMessage.conversationId !== input.threadId) {
    throw new Error("Async answer acceptance belongs to another conversation.");
  }
  const replyText =
    input.acceptedMessage?.text ??
    buildCodexAsyncQuestionReplyText(
      buildCodexAsyncQuestionReplies({ refs: refs!.refs, answers: input.answers }),
    );
  const principalId = input.principalId ?? "desktop-local";

  try {
    if (shouldDeliverAsyncAnswerThroughFollowUpQueue(thread)) {
      const result = await bridge.enqueueFollowUp({
        principalId,
        clientCommandId: commandId,
        threadId: thread.id,
        prompt: replyText,
        // Live turn: the answer must reach it mid-turn; the row otherwise falls back to
        // the ordinary drain once the run ends instead of being dropped.
        followUpDeliveryMode: "steer",
        expectedHistoryRevision: bridge.headHistoryRevision(thread.id),
      });
      return remember(describeFollowUpDelivery(result.followUp));
    }

    const accepted =
      input.acceptedMessage ??
      bridge.sendMessage({
        principalId,
        conversationId: thread.id,
        clientCommandId: commandId,
        text: replyText,
      });
    const delivery = await bridge.scheduleAcceptedMessage({
      conversationId: thread.id,
      messageId: accepted.messageId,
      turnId: accepted.turnId,
      text: replyText,
    });
    return remember({ ...delivery, followUpMessageId: accepted.messageId });
  } catch (error) {
    // The answer is persisted, but nothing confirms the run read it. Reporting "delivered"
    // here would be a guess, and the UI must not resend on its own.
    return remember({ state: "unknown", message: bridge.errorMessage(error) });
  }
}

/**
 * Live runs take a follow-up receipt for steer; a finished thread schedules its accepted
 * answer directly. Ordinary queue pause does not change the answer's delivery intent.
 * `awaiting_plan` is live but not running — its row waits for the plan decision like any
 * other queued message.
 */
function shouldDeliverAsyncAnswerThroughFollowUpQueue(thread: {
  status: ThreadStatus;
  followUpQueuePaused?: boolean | undefined;
}): boolean {
  return (
    thread.status === "running" ||
    thread.status === "queued" ||
    thread.status === "awaiting_plan"
  );
}
