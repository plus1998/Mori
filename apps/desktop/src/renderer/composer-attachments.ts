import type {
  PromptImageAttachment,
  PromptImageReadChunkRequest,
  PromptImageReadChunkResult,
} from "../shared/ipc";
import {
  createImageObjectUrlFromBase64,
  createImageObjectUrlFromBytes,
  revokeImageObjectUrl,
} from "./image-object-url";

export const COMPOSER_MAX_IMAGES = 5;
export const COMPOSER_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const ALLOWED_MEDIA_TYPES = new Set<PromptImageAttachment["mediaType"]>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const PROMPT_IMAGE_CONTENT_REF_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROMPT_IMAGE_READ_CHUNK_BYTES = 64 * 1024;

export interface ComposerImageAttachment {
  id: string;
  mediaType: PromptImageAttachment["mediaType"];
  path?: string;
  contentRef?: string;
  byteLength?: number;
  data?: string;
  previewUrl: string;
}

export type PromptImageChunkReader = (
  request: PromptImageReadChunkRequest,
) => Promise<PromptImageReadChunkResult>;

export function isAllowedImageMediaType(mediaType: string): mediaType is PromptImageAttachment["mediaType"] {
  return ALLOWED_MEDIA_TYPES.has(mediaType as PromptImageAttachment["mediaType"]);
}

export async function readImageFileAsAttachment(file: File): Promise<ComposerImageAttachment | null> {
  if (!file.type.startsWith("image/") || !isAllowedImageMediaType(file.type)) {
    return null;
  }
  if (file.size > COMPOSER_MAX_IMAGE_BYTES) {
    return null;
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > COMPOSER_MAX_IMAGE_BYTES) {
    return null;
  }
  const data = arrayBufferToBase64(buffer);
  return {
    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mediaType: file.type,
    data,
    previewUrl: createImageObjectUrlFromBytes(file.type, buffer),
  };
}

export function toPromptImageAttachments(
  attachments: readonly ComposerImageAttachment[],
): PromptImageAttachment[] {
  return attachments.map((attachment) => {
    const path = attachment.path?.trim();
    const contentRef = attachment.contentRef?.trim();
    if (path) {
      if (contentRef && !isPromptImageContentRef(contentRef)) {
        throw new Error("Composer image attachment has an invalid content reference.");
      }
      return {
        mediaType: attachment.mediaType,
        path,
        ...(contentRef ? { contentRef } : {}),
        ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
      };
    }
    if (contentRef) {
      if (!isPromptImageContentRef(contentRef)) {
        throw new Error("Composer image attachment has an invalid content reference.");
      }
      return {
        mediaType: attachment.mediaType,
        contentRef,
        ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
      };
    }
    const data = attachment.data?.trim();
    if (!data) {
      throw new Error("Composer image attachment is missing file data.");
    }
    return {
      mediaType: attachment.mediaType,
      ...(attachment.contentRef ? { contentRef: attachment.contentRef } : {}),
      ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
      data,
    };
  });
}

/**
 * Resolve durable queue/draft references into renderer-owned preview bytes.
 * The content reference remains on the attachment so sending does not depend
 * on copying the full image back through the renderer.
 */
export async function hydrateComposerImageAttachments(
  attachments: readonly ComposerImageAttachment[],
  contextKey: string,
  readChunk: PromptImageChunkReader,
): Promise<ComposerImageAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => {
      const data = attachment.data?.trim();
      if (data) {
        return attachment.previewUrl
          ? attachment
          : { ...attachment, data, previewUrl: createImageObjectUrlFromBase64(attachment.mediaType, data) };
      }
      // A local (fresh paste/drop) attachment already owns renderer preview bytes; the
      // durable reference is only needed for sending, so never re-read it just to rebuild
      // a preview. Re-reading also races the staged reference becoming durable.
      if (attachment.previewUrl) {
        return attachment;
      }
      const contentRef = attachment.contentRef?.trim();
      if (!contentRef) {
        return attachment;
      }
      if (!isPromptImageContentRef(contentRef)) {
        throw new Error("Composer image attachment has an invalid content reference.");
      }
      const resolved = await readPromptImageData({
        contextKey,
        contentRef,
        mediaType: attachment.mediaType,
        readChunk,
      });
      return {
        ...attachment,
        data: resolved.data,
        byteLength: attachment.byteLength ?? resolved.byteLength,
        previewUrl: createImageObjectUrlFromBase64(attachment.mediaType, resolved.data),
      };
    }),
  );
}

export function fromPromptImageAttachments(
  attachments: readonly PromptImageAttachment[],
): ComposerImageAttachment[] {
  return attachments.map((attachment, index) => {
    const data = attachment.data?.trim() ?? "";
    const path = attachment.path?.trim();
    return {
      id: `img_edit_${index}_${Math.random().toString(36).slice(2, 8)}`,
      mediaType: attachment.mediaType,
      ...(path ? { path } : {}),
      ...(attachment.contentRef ? { contentRef: attachment.contentRef } : {}),
      ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
      ...(data ? { data } : {}),
      previewUrl: data ? createImageObjectUrlFromBase64(attachment.mediaType, data) : "",
    };
  });
}

export function revokeComposerAttachmentPreview(
  attachment: ComposerImageAttachment | null | undefined,
): void {
  revokeImageObjectUrl(attachment?.previewUrl);
}

export function revokeComposerAttachmentPreviews(
  attachments: readonly ComposerImageAttachment[] | null | undefined,
): void {
  if (!attachments) {
    return;
  }
  for (const attachment of attachments) {
    revokeComposerAttachmentPreview(attachment);
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function isPromptImageContentRef(value: string): boolean {
  return PROMPT_IMAGE_CONTENT_REF_PATTERN.test(value.trim());
}

async function readPromptImageData(input: {
  contextKey: string;
  contentRef: string;
  mediaType: PromptImageAttachment["mediaType"];
  readChunk: PromptImageChunkReader;
}): Promise<{ data: string; byteLength: number }> {
  const contextKey = input.contextKey.trim();
  if (!contextKey) {
    throw new Error("Composer image context is required to load the preview.");
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let byteLength = 0;
  let expectedTotalBytes: number | undefined;

  while (true) {
    const chunk = await input.readChunk({
      contextKey,
      contentRef: input.contentRef,
      mediaType: input.mediaType,
      offset,
      maxBytes: PROMPT_IMAGE_READ_CHUNK_BYTES,
    });
    if (chunk.contentRef !== input.contentRef || chunk.mediaType !== input.mediaType) {
      throw new Error("Prompt image preview response does not match the requested attachment.");
    }
    if (chunk.offset !== offset || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes <= 0) {
      throw new Error("Prompt image preview response has an invalid offset or size.");
    }
    if (expectedTotalBytes === undefined) {
      expectedTotalBytes = chunk.totalBytes;
    } else if (expectedTotalBytes !== chunk.totalBytes) {
      throw new Error("Prompt image preview response changed size while loading.");
    }
    const bytes = base64ToBytes(chunk.data);
    if (bytes.length === 0 || chunk.nextOffset !== offset + bytes.length) {
      throw new Error("Prompt image preview response has invalid chunk data.");
    }
    chunks.push(bytes);
    byteLength += bytes.length;
    if (byteLength > chunk.totalBytes || chunk.nextOffset > chunk.totalBytes) {
      throw new Error("Prompt image preview response exceeds its declared size.");
    }
    if (chunk.complete) {
      if (byteLength !== chunk.totalBytes || chunk.nextOffset !== chunk.totalBytes) {
        throw new Error("Prompt image preview ended before all bytes were received.");
      }
      break;
    }
    offset = chunk.nextOffset;
  }

  const bytes = new Uint8Array(byteLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return { data: bytesToBase64(bytes), byteLength };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }
  return btoa(binary);
}
