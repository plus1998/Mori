import type { PromptImageAttachment } from "../shared/ipc";
import { isPromptImageContentRef } from "./prompt-image-file-store";

/** Schedules own immutable CAS references, never a disposable composer spool path. */
export function normalizeSchedulingAttachments(value: unknown): PromptImageAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error("定时消息最多支持 20 张图片。");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("定时图片格式无效。");
    const a = entry as PromptImageAttachment;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(a.mediaType) ||
        !isPromptImageContentRef(a.contentRef) || !Number.isSafeInteger(a.byteLength) ||
        a.byteLength! <= 0 || a.byteLength! > 20 * 1024 * 1024) {
      throw new Error("定时图片缺少有效的持久引用，请先完成图片上传。");
    }
    return { mediaType: a.mediaType, contentRef: a.contentRef!.trim(), byteLength: a.byteLength! };
  });
}

export async function verifySchedulingAttachments(
  value: unknown,
  read: (ref: string) => Promise<{ mediaType: string; byteLength: number }>,
): Promise<PromptImageAttachment[]> {
  const attachments = normalizeSchedulingAttachments(value);
  for (const attachment of attachments) {
    const stored = await read(attachment.contentRef!);
    if (stored.mediaType !== attachment.mediaType || stored.byteLength !== attachment.byteLength)
      throw new Error("定时图片与已上传的内容不一致。");
  }
  return attachments;
}
