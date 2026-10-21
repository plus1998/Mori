import type { AcpAskQuestionHandler, AcpAskQuestionRequest } from "@eco/runtime";
import type { ClarificationAnswers, ClarificationQuestion, ClarificationRequest } from "../shared/ipc";
import {
  buildClarificationToolMetadata,
  buildIgnoredClarificationAnswers,
  formatClarificationAnswersSummary,
  registerPendingClarification,
} from "./clarification-bridge.js";

/** Cursor CLI freeform option id (when present on the wire). */
export const ACP_ASK_QUESTION_FREEFORM_OPTION_ID = "__freeform_other__";

export type AcpAskQuestionMappedOption = {
  id: string;
  label: string;
};

export type AcpAskQuestionMappedItem = {
  id: string;
  prompt: string;
  options: AcpAskQuestionMappedOption[];
  allowMultiple: boolean;
};

export type AcpAskQuestionMapped = {
  request: ClarificationRequest;
  questions: AcpAskQuestionMappedItem[];
};

export type AcpAskQuestionBridgeEmitType = "clarification.requested" | "clarification.answered";

export interface AcpAskQuestionBridgeDeps {
  emit: (
    type: AcpAskQuestionBridgeEmitType,
    message: string,
    clarification: ClarificationRequest,
    toolStatus: "started" | "completed",
  ) => void;
  updateThreadRunning: () => void;
  registerPending?: (
    threadId: string,
    toolUseId: string,
    questions: ClarificationRequest["questions"],
  ) => Promise<ClarificationAnswers>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAcpAskQuestionQuestions(raw: unknown): AcpAskQuestionMappedItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: AcpAskQuestionMappedItem[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `q${index}`;
    const prompt =
      typeof entry.prompt === "string" && entry.prompt.trim()
        ? entry.prompt.trim()
        : typeof entry.question === "string" && entry.question.trim()
          ? entry.question.trim()
          : "";
    if (!prompt) {
      continue;
    }
    const options: AcpAskQuestionMappedOption[] = [];
    if (Array.isArray(entry.options)) {
      for (const [optionIndex, option] of entry.options.entries()) {
        if (!isRecord(option)) {
          continue;
        }
        const label = typeof option.label === "string" ? option.label.trim() : "";
        if (!label) {
          continue;
        }
        const optionId =
          typeof option.id === "string" && option.id.trim() ? option.id.trim() : `opt${optionIndex}`;
        options.push({ id: optionId, label });
      }
    }
    if (options.length === 0) {
      continue;
    }
    questions.push({
      id,
      prompt,
      options,
      allowMultiple: entry.allowMultiple === true || entry.multiSelect === true,
    });
  }
  return questions;
}

export function mapAcpAskQuestionToClarification(
  threadId: string,
  request: AcpAskQuestionRequest,
): AcpAskQuestionMapped | undefined {
  const toolUseId = request.toolCallId.trim();
  if (!toolUseId) {
    return undefined;
  }
  const questions = parseAcpAskQuestionQuestions(request.questions);
  if (questions.length === 0) {
    return undefined;
  }
  const clarificationQuestions: ClarificationQuestion[] = questions.map((question) => ({
    question: question.prompt,
    ...(typeof request.title === "string" && request.title.trim() ? { header: request.title.trim() } : {}),
    options: question.options.map((option) => ({ label: option.label })),
    ...(question.allowMultiple ? { multiSelect: true } : {}),
    allowCustom: true,
  }));
  return {
    request: {
      toolUseId,
      threadId,
      questions: clarificationQuestions,
    },
    questions,
  };
}

export function isIgnoredClarificationAnswers(
  request: ClarificationRequest,
  answers: ClarificationAnswers,
): boolean {
  const ignored = buildIgnoredClarificationAnswers(request);
  if (answers.selections.length !== ignored.selections.length) {
    return false;
  }
  return answers.selections.every((selection, index) => {
    const expected = ignored.selections[index] ?? [];
    return selection.length === expected.length && selection.every((value, i) => value === expected[i]);
  });
}

/**
 * Map Eco clarification labels (or freeform text) back to Cursor option ids.
 * Matched labels → option.id; unmatched freeform text is sent as selectedOptionIds
 * so the agent still receives the user's words (official wire has no freeform_text).
 */
export function mapClarificationAnswersToAcpAskQuestion(
  mapped: AcpAskQuestionMapped,
  answers: ClarificationAnswers,
): Array<{ questionId: string; selectedOptionIds: string[] }> {
  return mapped.questions.map((question, index) => {
    const selected = answers.selections[index] ?? [];
    const selectedOptionIds: string[] = [];
    for (const value of selected) {
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      const byLabel = question.options.find((option) => option.label === trimmed);
      if (byLabel) {
        selectedOptionIds.push(byLabel.id);
        continue;
      }
      const byId = question.options.find((option) => option.id === trimmed);
      if (byId) {
        selectedOptionIds.push(byId.id);
        continue;
      }
      const freeform = question.options.find((option) => option.id === ACP_ASK_QUESTION_FREEFORM_OPTION_ID);
      if (freeform && (trimmed === freeform.label || trimmed === freeform.id)) {
        selectedOptionIds.push(freeform.id);
        continue;
      }
      // Official wire has no freeform_text — pass custom text as an option id so Cursor still sees it.
      selectedOptionIds.push(trimmed);
    }
    return {
      questionId: question.id,
      selectedOptionIds,
    };
  });
}

export function createAcpAskQuestionHandler(
  threadId: string,
  deps: AcpAskQuestionBridgeDeps,
): AcpAskQuestionHandler {
  const registerPending =
    deps.registerPending ??
    ((tid, toolUseId, questions) => registerPendingClarification(tid, toolUseId, { questions }));
  return async (request) => {
    const mapped = mapAcpAskQuestionToClarification(threadId, request);
    if (!mapped) {
      return {
        outcome: "skipped",
        reason: "ACP cursor/ask_question had no usable questions",
      };
    }

    deps.updateThreadRunning();
    // Park before UI emit so submit cannot race an empty pending map.
    const answersPromise = registerPending(threadId, mapped.request.toolUseId, mapped.request.questions);
    deps.emit("clarification.requested", "主代理需要你回答几个问题。", mapped.request, "started");

    try {
      const answers = await answersPromise;
      deps.updateThreadRunning();

      if (isIgnoredClarificationAnswers(mapped.request, answers)) {
        deps.emit("clarification.answered", "已跳过澄清问题。", mapped.request, "completed");
        return { outcome: "skipped", reason: "user dismissed clarification" };
      }

      const acpAnswers = mapClarificationAnswersToAcpAskQuestion(mapped, answers);
      deps.emit(
        "clarification.answered",
        formatClarificationAnswersSummary(mapped.request, answers),
        mapped.request,
        "completed",
      );
      return { outcome: "answered", answers: acpAnswers };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/cancel/i.test(message)) {
        return { outcome: "cancelled" };
      }
      return { outcome: "skipped", reason: message };
    }
  };
}
