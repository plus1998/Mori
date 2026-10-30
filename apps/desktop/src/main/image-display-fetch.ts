import { IMAGE_VIEW_MAX_BYTES } from "./image-view-reader";

const FETCH_TIMEOUT_MS = 30_000;

export async function fetchImageDisplayUrl(url: string, signal?: AbortSignal): Promise<{ data: Buffer }> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS image URLs are supported.");
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
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "User-Agent": "Mori-ImageDisplay/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`Unexpected content-type: ${contentType}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > IMAGE_VIEW_MAX_BYTES) {
      throw new Error("Image exceeds 20 MB limit.");
    }
    return { data: Buffer.from(arrayBuffer) };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}
