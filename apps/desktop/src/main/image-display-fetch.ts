import { MEDIA_DISPLAY_MAX_BYTES } from "../shared/image-display";
import { ImageViewReadError } from "./image-view-reader";

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchImageDisplayUrl(
  url: string,
  signal?: AbortSignal,
): Promise<{ data: Buffer; mimeType?: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS media URLs are supported.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    controller.abort(signal.reason);
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/*,video/*,audio/*,*/*;q=0.8",
        "User-Agent": "Mori-MediaDisplay/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (Number(response.headers.get("content-length")) > MEDIA_DISPLAY_MAX_BYTES) {
      await response.body?.cancel();
      throw new ImageViewReadError("too_large");
    }
    if (!response.body) throw new Error("Empty media response.");
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MEDIA_DISPLAY_MAX_BYTES) {
          await reader.cancel();
          throw new ImageViewReadError("too_large");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return { data: Buffer.concat(chunks, total), ...(mimeType ? { mimeType } : {}) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
