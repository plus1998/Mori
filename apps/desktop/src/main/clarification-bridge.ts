import type { ClarificationAnswers, ClarificationRequest } from "../shared/ipc";
import type { ThreadRunToolMetadata } from "../shared/thread-run-events";

/** Stable tool name used to anchor clarification answers next to AskUserQuestion in the feed. */
export const CLARIFICATION_TOOL_NAME = "AskUserQuestion";

export function buildClarificationToolMetadata(
  toolUseId: string,
  status: NonNullable<ThreadRunToolMetadata["status"]>,
): ThreadRunToolMetadata {
  return {
    name: CLARIFICATION_TOOL_NAME,
    toolUseId: toolUseId.trim(),
    status,
  };
}

interface PendingClarification {
  threadId: string;
  request: ClarificationRequest;
  /**
   * Whether the run genuinely waits for this answer.
   *
   * A sync `item/tool/requestUserInput` RPC always awaits its response, but app-server
   * sends `isBlocking: false` when the question does not hold the turn (Default mode)
   * and `true` in Plan mode. Async `agentMessage` questions never block by construction.
   */
  blocking: boolean;
  promise: Promise<ClarificationAnswers>;
  resolve: (answers: ClarificationAnswers) => void;
  reject: (error: Error) => void;
}

const pending = new Map<string, PendingClarification>();

export function registerPendingClarification(
  threadId: string,
  toolUseId: string,
  parsed: {
    questions: ClarificationRequest["questions"];
    delivery?: ClarificationRequest["delivery"];
    blocking?: boolean;
  },
): Promise<ClarificationAnswers> {
  if (pending.has(toolUseId)) {
    return Promise.reject(new Error(`Clarification ${toolUseId} is already pending.`));
  }

  let resolveAnswers!: (answers: ClarificationAnswers) => void;
  let rejectAnswers!: (error: Error) => void;
  const promise = new Promise<ClarificationAnswers>((resolve, reject) => {
    resolveAnswers = resolve;
    rejectAnswers = reject;
  });
  pending.set(toolUseId, {
    threadId,
    request: {
      toolUseId,
      threadId,
      questions: parsed.questions,
      ...(parsed.delivery ? { delivery: parsed.delivery } : {}),
    },
    blocking: parsed.blocking ?? true,
    promise,
    resolve: resolveAnswers,
    reject: rejectAnswers,
  });
  return promise;
}

export function getPendingClarificationWaitForThread(
  threadId: string,
): Promise<ClarificationAnswers> | undefined {
  for (const entry of pending.values()) {
    if (entry.threadId === threadId) {
      return entry.promise;
    }
  }
  return undefined;
}

export function getPendingClarificationForThread(threadId: string): ClarificationRequest | undefined {
  for (const entry of pending.values()) {
    if (entry.threadId === threadId) {
      return entry.request;
    }
  }
  return undefined;
}

export function getPendingClarificationByToolUseId(toolUseId: string): ClarificationRequest | undefined {
  return pending.get(toolUseId)?.request;
}

/**
 * The pending clarification that actually holds up run cleanup / follow-up drain.
 *
 * Non-blocking entries (async Codex questions, `isBlocking: false` sync requests) stay
 * answerable in the panel but must never gate the run or the queue.
 */
export function getPendingBlockingClarificationForThread(
  threadId: string,
): ClarificationRequest | undefined {
  for (const entry of pending.values()) {
    if (entry.threadId === threadId && entry.blocking) {
      return entry.request;
    }
  }
  return undefined;
}

export function hasPendingBlockingClarificationForThread(threadId: string): boolean {
  return getPendingBlockingClarificationForThread(threadId) !== undefined;
}

export function submitClarification(toolUseId: string, answers: ClarificationAnswers): boolean {
  const entry = pending.get(toolUseId);
  if (!entry) {
    return false;
  }
  pending.delete(toolUseId);
  entry.resolve(answers);
  return true;
}

export function cancelClarificationsForThread(threadId: string, reason: string): void {
  for (const [toolUseId, entry] of pending) {
    if (entry.threadId !== threadId) {
      continue;
    }
    pending.delete(toolUseId);
    entry.reject(new Error(reason));
  }
}

export function buildIgnoredClarificationAnswers(request: ClarificationRequest): ClarificationAnswers {
  const skipped = "忽略 — 请根据代码与常见做法推进，并在计划中写明假设";
  return {
    toolUseId: request.toolUseId,
    selections: request.questions.map(() => [skipped]),
  };
}

export function buildAskUserQuestionUpdatedInput(
  request: ClarificationRequest,
  answers: ClarificationAnswers,
  rawInput?: Record<string, unknown>,
): Record<string, unknown> {
  const answersMap: Record<string, string | string[]> = {};

  const rawQuestions = rawInput?.questions;

  for (const [index, question] of request.questions.entries()) {
    const selected = answers.selections[index] ?? [];
    const answerKey = readRawAskUserQuestionKey(rawQuestions, index, question.question);
    if (question.multiSelect) {
      answersMap[answerKey] = selected;
    } else {
      answersMap[answerKey] = selected[0] ?? "";
    }
  }
  const questions =
    Array.isArray(rawQuestions) && rawQuestions.length > 0
      ? rawQuestions
      : request.questions.map((question) => ({
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
            ...(option.recommended ? { recommended: true } : {}),
          })),
          ...(question.header ? { header: question.header } : {}),
          ...(question.multiSelect ? { multiSelect: true } : {}),
        }));

  return {
    questions,
    answers: answersMap,
  };
}

export function formatClarificationAnswersSummary(
  request: ClarificationRequest,
  answers: ClarificationAnswers,
): string {
  const parts = request.questions.map((question, index) => {
    const selected = answers.selections[index] ?? [];
    if (selected.length === 0) {
      return `${question.question} → （未选择）`;
    }
    return `${question.question} → ${selected.join("、")}`;
  });
  return `询问回答：${parts.join("；")}`;
}

function readRawAskUserQuestionKey(rawQuestions: unknown, index: number, fallback: string): string {
  if (!Array.isArray(rawQuestions)) {
    return fallback;
  }
  const entry = rawQuestions[index];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return fallback;
  }
  const question = (entry as { question?: unknown }).question;
  return typeof question === "string" && question.length > 0 ? question : fallback;
}
