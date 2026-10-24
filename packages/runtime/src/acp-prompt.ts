export const ACP_IMAGE_CAPABILITY_MISSING = "Cursor ACP 未声明图片输入能力，无法发送附件。";
export const ACP_IMAGE_ATTACHMENT_INVALID = "ACP 图片附件无效：缺少 data 或 mimeType 不受支持。";
export const ACP_PROMPT_EMPTY = "ACP prompt is empty";

const ALLOWED_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type AcpPromptImageAttachment = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
};

export type AcpPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: AcpPromptImageAttachment["mediaType"]; data: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentSupportsImagePrompt(initializeResult: {
  agentCapabilities?: { promptCapabilities?: unknown };
}): boolean {
  const caps = initializeResult.agentCapabilities?.promptCapabilities;
  return isRecord(caps) && caps.image === true;
}

export function buildAcpPromptBlocks(input: {
  prompt: string;
  attachments?: readonly AcpPromptImageAttachment[];
  imageSupported: boolean;
}): AcpPromptContentBlock[] {
  const text = input.prompt.trim();
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    if (!text) {
      throw new Error(ACP_PROMPT_EMPTY);
    }
    return [{ type: "text", text }];
  }
  if (!input.imageSupported) {
    throw new Error(ACP_IMAGE_CAPABILITY_MISSING);
  }
  const images: AcpPromptContentBlock[] = [];
  for (const attachment of attachments) {
    const data = attachment.data?.trim();
    if (!data || !ALLOWED_MEDIA_TYPES.has(attachment.mediaType)) {
      throw new Error(ACP_IMAGE_ATTACHMENT_INVALID);
    }
    images.push({
      type: "image",
      mimeType: attachment.mediaType,
      data,
    });
  }
  return text ? [{ type: "text", text }, ...images] : images;
}
