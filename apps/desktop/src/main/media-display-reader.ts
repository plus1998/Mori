import fs from "node:fs/promises";
import path from "node:path";
import { MEDIA_DISPLAY_MAX_BYTES } from "../shared/image-display";
import { ImageViewReadError, inspectImageBuffer } from "./image-view-reader";

export interface DisplayMediaBytes {
  data: Buffer;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}

/** Detect media from its container bytes; an extension alone cannot make a file playable. */
export function inspectDisplayMedia(data: Buffer, mimeHint?: string): DisplayMediaBytes {
  if (data.length > MEDIA_DISPLAY_MAX_BYTES) throw new ImageViewReadError("too_large");
  const head = data.subarray(0, 4096);
  const ascii = head.toString("latin1");
  let mimeType: string | undefined;
  if (data.length >= 12 && ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") {
    mimeType = "audio/wav";
  } else if (data.length >= 12 && ascii.slice(4, 8) === "ftyp") {
    const brand = ascii.slice(8, 12);
    // AVIF/HEIF also use ftyp; do not mistake image containers for video.
    if (/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash|qt  |M4A |M4B |f4a )$/.test(brand)) {
      mimeType =
        /^(?:M4A |M4B |f4a )$/.test(brand) || mimeHint === "audio/mp4"
          ? "audio/mp4"
          : brand === "qt  "
            ? "video/quicktime"
            : "video/mp4";
    }
  } else if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && ascii.includes("webm")) {
    mimeType = mimeHint === "audio/webm" ? "audio/webm" : "video/webm";
  } else if (ascii.startsWith("OggS")) {
    if (ascii.includes("OpusHead") || ascii.includes("vorbis") || ascii.includes("Speex")) {
      mimeType = "audio/ogg";
    }
  } else if (ascii.startsWith("fLaC")) {
    mimeType = "audio/flac";
  } else if (
    data.length >= 4 &&
    (ascii.startsWith("ID3") ||
      (data[0] === 0xff &&
        (data[1]! & 0xe0) === 0xe0 &&
        (data[1]! & 0x06) !== 0 &&
        (data[2]! & 0xf0) !== 0 &&
        (data[2]! & 0xf0) !== 0xf0))
  ) {
    mimeType = "audio/mpeg";
  } else if (data.length >= 7 && data[0] === 0xff && (data[1]! & 0xf6) === 0xf0) {
    mimeType = "audio/aac";
  }
  if (mimeType) return { data, mimeType, bytes: data.length };
  const inspected = inspectImageBuffer(data);
  return { data, ...inspected };
}

export async function readDisplayMediaFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<DisplayMediaBytes> {
  signal?.throwIfAborted();
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ImageViewReadError("not_found");
    throw error;
  }
  if (stat.isSymbolicLink()) throw new ImageViewReadError("symbolic_link");
  if (!stat.isFile()) throw new ImageViewReadError("not_file");
  if (stat.size > MEDIA_DISPLAY_MAX_BYTES) throw new ImageViewReadError("too_large");
  const mimeHint = /\.(?:m4a|m4b)$/i.test(path.extname(filePath))
    ? "audio/mp4"
    : /\.(?:weba)$/i.test(path.extname(filePath))
      ? "audio/webm"
      : undefined;
  return inspectDisplayMedia(await fs.readFile(filePath, { signal }), mimeHint);
}
