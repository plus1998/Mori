import type { ConversationDetailItem } from "@eco/shared";

export interface ClarificationHistoryRow {
  question: string;
  answer?: string;
}

export function readClarificationHistoryContent(detail: ConversationDetailItem): Record<string, unknown> {
  const content: unknown = JSON.parse(detail.content ?? "null");
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error(`Conversation V2 clarification detail ${detail.itemId} is invalid.`);
  }
  return content as Record<string, unknown>;
}

export function clarificationHistoryRows(
  request: Record<string, unknown> | undefined,
  resolved?: Record<string, unknown>,
): ClarificationHistoryRow[] {
  const clarification = request?.clarification as { questions?: Array<{ question?: unknown }> } | undefined;
  const questions =
    clarification?.questions?.flatMap((item) => (typeof item.question === "string" ? [item.question] : [])) ??
    [];
  const answers = resolved?.answers as { selections?: string[][] } | undefined;
  if (answers?.selections && questions.length > 0) {
    return questions.map((question, index) => ({
      question,
      answer: (answers.selections![index] ?? []).join("、"),
    }));
  }
  if (!resolved) return questions.map((question) => ({ question }));
  const message = typeof resolved.message === "string" ? resolved.message : "";
  if (!message.startsWith("澄清回答：")) return [];
  let rest = message.slice("澄清回答：".length);
  if (questions.length > 0) {
    // Historical answers are text. Match the recorded question boundaries so punctuation
    // inside a freeform answer does not accidentally create another question.
    const rows: ClarificationHistoryRow[] = [];
    for (const [index, question] of questions.entries()) {
      const prefix = `${question} → `;
      if (!rest.startsWith(prefix))
        throw new Error("Recorded clarification answer does not match its question.");
      rest = rest.slice(prefix.length);
      const next = questions[index + 1];
      const end = next === undefined ? rest.length : rest.indexOf(`；${next} → `);
      if (end < 0) throw new Error("Recorded clarification answer is missing its next question.");
      rows.push({ question, answer: rest.slice(0, end) });
      rest = rest.slice(end + 1);
    }
    return rows;
  }
  return parseClarificationAnswersSummary(message) ?? [];
}

export function parseClarificationAnswersSummary(text: string): ClarificationHistoryRow[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("澄清回答：")) return null;
  return trimmed
    .slice("澄清回答：".length)
    .split("；")
    .filter(Boolean)
    .map((part) => {
      const [question = "", ...answer] = part.split(/\s*→\s*/u);
      return { question: question.trim(), answer: answer.join(" → ").trim() };
    });
}
