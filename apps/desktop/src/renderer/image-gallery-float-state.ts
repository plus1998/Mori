/**
 * 右侧图片画廊悬浮窗的队列状态。
 *
 * 展示图片工具（display_image）与创意绘画工具（create_image）每次被调用时，
 * 对应的图片会被排入队列；悬浮窗可前后浏览，关闭当前一张只移除对应项。
 * 队列清空或用户整体关闭后，图片仍保留在 workspace cards 面板中。
 */

export type ImageGalleryItemKind = "display" | "generation";

export interface ImageGalleryQueueItem {
  /** 稳定唯一键：展示图片用产物 ID，创意绘画用产物 ID + 图片序号。 */
  key: string;
  kind: ImageGalleryItemKind;
  artifactId: string;
  /** 创意绘画产物内的图片下标（0 起）；展示图片产物没有下标。 */
  imageIndex?: number;
}

export function imageGalleryDisplayItem(artifactId: string): ImageGalleryQueueItem {
  return { key: `display:${artifactId}`, kind: "display", artifactId };
}

export function imageGalleryGenerationItem(artifactId: string, imageIndex: number): ImageGalleryQueueItem {
  return {
    key: `generation:${artifactId}:${imageIndex}`,
    kind: "generation",
    artifactId,
    imageIndex,
  };
}

/** 追加新的队列项，按键去重（重复事件不会重复入队）。 */
export function appendImageGalleryItems(
  queue: readonly ImageGalleryQueueItem[],
  items: readonly ImageGalleryQueueItem[],
): ImageGalleryQueueItem[] {
  const seen = new Set(queue.map((item) => item.key));
  const next = [...queue];
  for (const item of items) {
    if (!seen.has(item.key)) {
      seen.add(item.key);
      next.push(item);
    }
  }
  return next;
}

/** 关闭指定图片；未指定时关闭第一张，队列为空即整体收起。 */
export function advanceImageGalleryQueue(
  queue: readonly ImageGalleryQueueItem[],
  key = queue[0]?.key,
): ImageGalleryQueueItem[] {
  return queue.filter((item) => item.key !== key);
}
