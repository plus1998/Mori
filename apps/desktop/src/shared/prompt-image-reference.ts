import { buildCodexAsyncQuestionReplyText, parseCodexAsyncQuestionReplyText } from "./codex-async-questions";
import { composerReferences } from "./composer-references";
import type { PromptImageAttachment } from "./ipc";

export function buildPromptWithImageReferences(input: {
  prompt: string;
  attachments?: readonly PromptImageAttachment[];
}): string {
  const references = (input.attachments ?? [])
    .map((attachment, index) => {
      const filePath = attachment.path?.trim();
      const contentRef = attachment.contentRef?.trim();
      if (filePath) return `- image ${index + 1}: path=${JSON.stringify(filePath)}`;
      if (contentRef) return `- image ${index + 1}: ref=${JSON.stringify(contentRef)}`;
      return undefined;
    })
    .filter((value): value is string => Boolean(value));

  if (references.length === 0) return input.prompt;

  const prompt = input.prompt.trim();
  return [
    ...(prompt ? [prompt, ""] : []),
    "Composer image references are available to the image_view tool.",
    "If an image is relevant, call image_view with its path or ref and choose the prompt that best serves the task.",
    ...references,
  ].join("\n");
}

/** Keep all context inside the complete reply so Codex can still match its question IDs. */
export async function resolveCodexAsyncAnswerPrompt(
  prompt: string,
  resolveReferences: (answer: string) => Promise<string>,
  withWorkLocation: (answer: string) => string,
  attachments?: readonly PromptImageAttachment[],
): Promise<string | undefined> {
  const replies = parseCodexAsyncQuestionReplyText(prompt);
  if (!replies) return undefined;
  const multiAgentIds = new Set(replies.flatMap(({ answer }) =>
    composerReferences(answer).filter(ref => ref.kind === "multi_agents").map(ref => ref.id),
  ));
  if (multiAgentIds.size > 1) throw new Error("每条消息只能选择一个 Multi-Agents 配置，请删除多余引用。");
  const resolved = await Promise.all(replies.map(async (row, index) => {
    const answer = await resolveReferences(row.answer);
    return {
      ...row,
      answer: index === 0
        ? buildPromptWithImageReferences({ prompt: withWorkLocation(answer), ...(attachments ? { attachments } : {}) })
        : answer,
    };
  }));
  return buildCodexAsyncQuestionReplyText(resolved);
}
