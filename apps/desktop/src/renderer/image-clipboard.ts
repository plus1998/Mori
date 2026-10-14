import { MAX_CLIPBOARD_IMAGE_BASE64_CHARS } from "../shared/ipc";
import { copyPngBlobToClipboard } from "./clipboard";

/**
 * Clipboard image plumbing for the image viewer's right-click "copy image".
 *
 * Chromium's clipboard accepts exactly one image format — PNG — so anything else
 * (JPEG / WebP / GIF / SVG / ICO / BMP) has to be decoded and re-encoded before the write.
 * PNG bytes are handed to the clipboard untouched so a copy never loses quality.
 */
export const CLIPBOARD_IMAGE_MIME = "image/png";

/** Chromium silently blanks canvases past ~16k px per side; clamp before drawing instead. */
export const CLIPBOARD_IMAGE_MAX_SIDE = 16_384;

export interface ImageCanvasSize {
  width: number;
  height: number;
}

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release?: () => void;
}

export function normalizeImageMime(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** True when the bytes can go to the clipboard as-is, i.e. they are already PNG. */
export function isClipboardNativeImageMime(mimeType: string | null | undefined): boolean {
  return normalizeImageMime(mimeType) === CLIPBOARD_IMAGE_MIME;
}

/** Canvas size for an image, clamped to `maxSide`; null when the source has no usable size. */
export function fitImageCanvasSize(
  width: number,
  height: number,
  maxSide: number = CLIPBOARD_IMAGE_MAX_SIDE,
): ImageCanvasSize | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return null;
  }
  const sourceWidth = Math.floor(width);
  const sourceHeight = Math.floor(height);
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= maxSide) {
    return { width: sourceWidth, height: sourceHeight };
  }
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/** Read the bytes behind any renderer-visible image source (blob: / data: / http(s):). */
export async function readImageBlob(src: string | null | undefined): Promise<Blob | null> {
  if (!src || typeof fetch !== "function") {
    return null;
  }
  try {
    const response = await fetch(src);
    if (!response.ok) {
      return null;
    }
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

/** Fast path: Chromium decodes every raster format through createImageBitmap. */
async function decodeWithImageBitmap(blob: Blob): Promise<DecodedImage | null> {
  if (typeof createImageBitmap !== "function") {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(blob);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    return null;
  }
}

/** Fallback path: `<img>` also decodes SVG, which createImageBitmap refuses. */
function decodeWithImageElement(blob: Blob): Promise<DecodedImage | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined" || typeof URL?.createObjectURL !== "function") {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const finish = (value: DecodedImage | null) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    image.onload = () => finish({ source: image, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => finish(null);
    image.src = url;
  });
}

/** Re-encode any decodable image blob as PNG, or null when it cannot be rasterized. */
export async function encodeImageBlobAsPng(blob: Blob | null | undefined): Promise<Blob | null> {
  if (!blob || blob.size < 1 || typeof document === "undefined") {
    return null;
  }
  try {
    const decoded = (await decodeWithImageBitmap(blob)) ?? (await decodeWithImageElement(blob));
    if (!decoded) {
      return null;
    }
    try {
      const size = fitImageCanvasSize(decoded.width, decoded.height);
      if (!size) {
        return null;
      }
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) {
        return null;
      }
      context.drawImage(decoded.source, 0, 0, size.width, size.height);
      const png = await canvasToPngBlob(canvas);
      return png && png.size > 32 ? png : null;
    } finally {
      try {
        decoded.release?.();
      } catch {
        // Freeing the decoded frame is best-effort.
      }
    }
  } catch {
    // A canvas that Chromium refuses (out of memory, hostile DOM stub) is a copy failure,
    // not a crash: the caller only ever sees "复制图像失败".
    return null;
  }
}

/** Base64 without building one giant string per chunk boundary (btoa rejects typed arrays). */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 8_192;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Second clipboard door: Electron's main process. `navigator.clipboard.write` refuses when the
 * document is not focused, which is exactly what happens when a menu click arrives while the
 * window is being activated, so the PNG is handed over IPC instead.
 */
async function copyPngViaMainProcess(png: Blob): Promise<boolean> {
  const bridge = typeof window === "undefined" ? undefined : window.eco;
  if (!bridge?.writeImageToClipboard) {
    return false;
  }
  try {
    const pngBase64 = await blobToBase64(png);
    if (!pngBase64 || pngBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
      return false;
    }
    return await bridge.writeImageToClipboard({ pngBase64 });
  } catch {
    return false;
  }
}

/** Copy image bytes to the system clipboard, re-encoding to PNG only when required. */
export async function copyImageBlobToClipboard(blob: Blob | null | undefined): Promise<boolean> {
  if (!blob || blob.size < 1) {
    return false;
  }
  if (isClipboardNativeImageMime(blob.type)) {
    // Already PNG: try the bytes as they are, so a copy never loses quality.
    return (await copyPngBlobToClipboard(blob)) || (await copyPngViaMainProcess(blob));
  }
  const png = await encodeImageBlobAsPng(blob);
  if (!png) {
    return false;
  }
  return (await copyPngBlobToClipboard(png)) || (await copyPngViaMainProcess(png));
}

/** Copy the image behind a viewer `src` to the system clipboard. */
export async function copyImageSourceToClipboard(src: string | null | undefined): Promise<boolean> {
  return copyImageBlobToClipboard(await readImageBlob(src));
}
