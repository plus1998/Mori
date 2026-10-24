import type { PromptImageAttachment, PromptImageStageRequest, PromptImageStageResult } from "../shared/ipc";
import type { ComposerImageAttachment } from "./composer-attachments";

/** Keep uploaded images across a lost-response retry; persist CAS metadata only. */
export async function stageScheduledMessageImages(
  images: readonly ComposerImageAttachment[], contextKey: string,
  stage: (request: PromptImageStageRequest) => Promise<PromptImageStageResult>,
  uploaded: Map<string, PromptImageAttachment>,
): Promise<PromptImageAttachment[]> {
  const result: PromptImageAttachment[] = [];
  for (const image of images) {
    if (image.contentRef && image.byteLength) {
      result.push({ mediaType: image.mediaType, contentRef: image.contentRef, byteLength: image.byteLength });
      continue;
    }
    let stored = uploaded.get(image.id);
    if (!stored) {
      if (!image.data) throw new Error("图片缺少原始内容，请重新添加图片。 / Image content is missing; add the image again.");
      const saved = await stage({ contextKey, imageId: `schedule_${image.id}`, mediaType: image.mediaType, data: image.data });
      stored = { mediaType: image.mediaType, contentRef: saved.contentRef, byteLength: saved.byteLength };
      uploaded.set(image.id, stored);
    }
    result.push(stored);
  }
  return result;
}
