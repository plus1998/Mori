import { createDecipheriv } from "node:crypto";
import type { PromptImageAttachment } from "../shared/ipc";
import { PROMPT_IMAGE_UPLOAD_MAX_BYTES } from "./prompt-image-file-store";

export const WECHAT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

export interface WechatInboundImage {
  aeskey?: string;
  media?: { full_url?: string; encrypt_query_param?: string; aes_key?: string };
}

function imageDownloadUrl(image: WechatInboundImage): URL {
  const fullUrl = image.media?.full_url;
  const param = image.media?.encrypt_query_param ?? "";
  if (!fullUrl && !param) throw new Error("微信未提供图片下载地址。");
  const url = URL.parse(fullUrl || `${WECHAT_CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(param)}`);
  if (!url || url.protocol !== "https:" || !url.hostname.endsWith(".weixin.qq.com") ||
    url.username || url.password || url.port)
    throw new Error("微信返回了不受信任的图片下载地址。");
  return url;
}

function imageKey(image: WechatInboundImage): Buffer | undefined {
  // iLink puts the raw hex key on ImageItem, or base64 of raw bytes / hex on CDNMedia.
  if (image.aeskey) {
    if (/^[0-9a-f]{32}$/i.test(image.aeskey)) return Buffer.from(image.aeskey, "hex");
  } else {
    const encoded = image.media?.aes_key;
    if (!encoded) return undefined;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      const decoded = Buffer.from(encoded, "base64");
      if (decoded.length === 16) return decoded;
      if (decoded.length === 32) {
        const hex = decoded.toString("latin1");
        if (/^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(hex, "hex");
      }
    }
  }
  throw new Error("微信图片解密密钥无效。");
}

function imageMediaType(bytes: Buffer): PromptImageAttachment["mediaType"] {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  const gifHeader = bytes.toString("latin1", 0, 6);
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") return "image/gif";
  if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP")
    return "image/webp";
  throw new Error("微信图片格式无法识别；支持 JPEG、PNG、GIF 和 WebP。");
}

export async function downloadWechatImage(
  image: WechatInboundImage,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mediaType: PromptImageAttachment["mediaType"] }> {
  const url = imageDownloadUrl(image);
  const key = imageKey(image);
  const limit = PROMPT_IMAGE_UPLOAD_MAX_BYTES + (key ? 16 : 0);
  const timeout = AbortSignal.timeout(30_000);
  const downloadSignal = AbortSignal.any([signal, timeout]);
  const networkError = (cause: unknown) =>
    new Error(timeout.aborted ? "微信图片下载超时。" : "无法从微信 CDN 下载图片。", { cause });
  const response = await fetch(url, { signal: downloadSignal, redirect: "error" }).catch((cause) => {
    throw networkError(cause);
  });
  if (!response.ok || Number(response.headers.get("content-length")) > limit) {
    void response.body?.cancel().catch(() => {});
    if (!response.ok) throw new Error(`微信图片下载失败（HTTP ${response.status}）。`);
    throw new Error("微信图片不能超过 20 MB。");
  }
  if (!response.body) throw new Error("微信 CDN 未返回图片内容。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read().catch((cause) => { throw networkError(cause); });
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error("微信图片不能超过 20 MB。");
      chunks.push(chunk.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let bytes = Buffer.concat(chunks, size);
  if (key) {
    try {
      const decipher = createDecipheriv("aes-128-ecb", key, null);
      bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
    } catch (cause) {
      throw new Error("微信图片解密失败，请重新发送图片。", { cause });
    }
  }
  if (bytes.length > PROMPT_IMAGE_UPLOAD_MAX_BYTES) throw new Error("微信图片不能超过 20 MB。");
  return { bytes, mediaType: imageMediaType(bytes) };
}
