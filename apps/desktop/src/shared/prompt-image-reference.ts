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
