import { COMPOSER_MAX_IMAGE_BYTES, isAllowedImageMediaType } from "./composer-attachments";

export function readDroppedWebImageSource(transfer: Pick<DataTransfer, "getData">): string | undefined {
  const html = transfer.getData("text/html");
  if (html) {
    // Template contents are inert, including any images or scripts from the drag source.
    const template = document.createElement("template");
    template.innerHTML = html;
    const image = template.content.querySelector("img");
    if (image) return image.getAttribute("src")?.trim() ?? "";
    return undefined;
  }

  const uri = transfer.getData("text/uri-list").split(/\r?\n/)
    .map(line => line.trim()).find(line => line && !line.startsWith("#"));
  if (uri && (/^data:image\//i.test(uri) || /\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(uri))) {
    return uri;
  }
  return undefined;
}

export async function readDroppedWebImage(source: string): Promise<File> {
  const url = new URL(source);
  if (!["https:", "http:", "data:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Unsupported dropped image URL.");
  }
  const response = await fetch(url, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(15_000),
  });
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!response.ok || !isAllowedImageMediaType(mediaType) ||
      Number(response.headers.get("content-length")) > COMPOSER_MAX_IMAGE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("The dropped URL did not return a supported image within the size limit.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > COMPOSER_MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("The dropped image exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("The dropped image is empty.");
  return new File(chunks, "web-image", { type: mediaType });
}
