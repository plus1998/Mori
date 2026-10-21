import fs from "node:fs/promises";
import path from "node:path";

export const IMAGE_VIEW_MAX_BYTES = 20 * 1024 * 1024;

export type ImageViewReadFailureCode =
  | "invalid_path"
  | "not_found"
  | "symbolic_link"
  | "not_file"
  | "too_large"
  | "unsupported_type";

export class ImageViewReadError extends Error {
  constructor(readonly code: ImageViewReadFailureCode) {
    super(code);
    this.name = "ImageViewReadError";
  }
}

export interface ImageViewFileData {
  dataBase64: string;
  mimeType:
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp"
    | "image/svg+xml"
    | "image/x-icon"
    | "image/bmp";
  path: string;
  fileName: string;
  bytes: number;
  width: number;
  height: number;
}

export async function readImageViewFile(inputPath: string): Promise<ImageViewFileData> {
  const imagePath = inputPath.trim();
  if (!imagePath || !path.isAbsolute(imagePath)) {
    throw new ImageViewReadError("invalid_path");
  }

  let fileStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    fileStat = await fs.lstat(imagePath);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      throw new ImageViewReadError("not_found");
    }
    throw error;
  }
  if (fileStat.isSymbolicLink()) {
    throw new ImageViewReadError("symbolic_link");
  }
  if (!fileStat.isFile()) {
    throw new ImageViewReadError("not_file");
  }
  if (fileStat.size > IMAGE_VIEW_MAX_BYTES) {
    throw new ImageViewReadError("too_large");
  }

  const data = await fs.readFile(imagePath);
  if (data.length > IMAGE_VIEW_MAX_BYTES) {
    throw new ImageViewReadError("too_large");
  }
  const mimeType = detectSupportedImageMimeType(data);
  if (!mimeType) {
    throw new ImageViewReadError("unsupported_type");
  }
  const dimensions = readImageDimensions(data, mimeType);
  if (!dimensions) {
    throw new ImageViewReadError("unsupported_type");
  }

  return {
    dataBase64: data.toString("base64"),
    mimeType,
    path: imagePath,
    fileName: path.basename(imagePath),
    bytes: data.length,
    ...dimensions,
  };
}

export function detectSupportedImageMimeType(bytes: Buffer): ImageViewFileData["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const signature6 = bytes.subarray(0, 6).toString("ascii");
  if (signature6 === "GIF87a" || signature6 === "GIF89a") {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  // ICO detection: starts with 00 00 01 00
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return "image/x-icon";
  }
  // BMP detection: starts with "BM"
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }
  // SVG detection: check for XML declaration or SVG tag
  const head = bytes.subarray(0, 1024).toString("utf8").trim();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")) {
    return "image/svg+xml";
  }
  return undefined;
}

export function inspectImageBuffer(data: Buffer): {
  mimeType: ImageViewFileData["mimeType"];
  bytes: number;
  width: number;
  height: number;
} {
  if (data.length > IMAGE_VIEW_MAX_BYTES) {
    throw new ImageViewReadError("too_large");
  }
  const mimeType = detectSupportedImageMimeType(data);
  if (!mimeType) {
    throw new ImageViewReadError("unsupported_type");
  }
  const dimensions = readImageDimensions(data, mimeType);
  if (!dimensions) {
    throw new ImageViewReadError("unsupported_type");
  }
  return { mimeType, bytes: data.length, ...dimensions };
}

export function readImageDimensions(
  bytes: Buffer,
  mimeType: ImageViewFileData["mimeType"],
): { width: number; height: number } | undefined {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return validDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  }
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return validDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  }
  if (mimeType === "image/jpeg") {
    return readJpegDimensions(bytes);
  }
  if (mimeType === "image/webp") {
    return readWebpDimensions(bytes);
  }
  if (mimeType === "image/x-icon") {
    return readIcoDimensions(bytes);
  }
  if (mimeType === "image/bmp") {
    return readBmpDimensions(bytes);
  }
  if (mimeType === "image/svg+xml") {
    return readSvgDimensions(bytes);
  }
  return undefined;
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === undefined) {
      return undefined;
    }
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (startOfFrameMarkers.has(marker)) {
      return validDimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) {
      return undefined;
    }
    offset += 2 + segmentLength;
  }
  return undefined;
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const chunkType = bytes.subarray(12, 16).toString("ascii");
  if (chunkType === "VP8X" && bytes.length >= 30) {
    return validDimensions(readUInt24LE(bytes, 24) + 1, readUInt24LE(bytes, 27) + 1);
  }
  if (chunkType === "VP8 " && bytes.length >= 30) {
    return validDimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (chunkType === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const byte1 = bytes[21] ?? 0;
    const byte2 = bytes[22] ?? 0;
    const byte3 = bytes[23] ?? 0;
    const byte4 = bytes[24] ?? 0;
    const width = 1 + (((byte2 & 0x3f) << 8) | byte1);
    const height = 1 + (((byte4 & 0x0f) << 10) | (byte3 << 2) | ((byte2 & 0xc0) >> 6));
    return validDimensions(width, height);
  }
  return undefined;
}

function readIcoDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  // ICO header: 6 bytes (reserved 2, type 2, count 2)
  // Then directory entries: 16 bytes each
  // Entry structure: width(1), height(1), colorCount(1), reserved(1), planes(2), bitCount(2), bytesInRes(4), imageOffset(4)
  if (bytes.length < 6) return undefined;
  const count = bytes.readUInt16LE(4);
  if (count === 0 || bytes.length < 22) return undefined;
  // First image entry starts at offset 6
  const width = bytes[6] ?? 0; // 0 means 256
  const height = bytes[7] ?? 0; // 0 means 256
  return validDimensions(width === 0 ? 256 : width, height === 0 ? 256 : height);
}

function readBmpDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  // BMP header: 'BM' + file size(4) + reserved(4) + offset(4) + header size(4) + width(4) + height(4)
  if (bytes.length < 30) return undefined;
  const width = bytes.readInt32LE(18);
  const height = Math.abs(bytes.readInt32LE(22)); // Can be negative for top-down
  return validDimensions(width, height);
}

function readSvgDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const content = bytes.toString("utf8");
  // Try to parse width and height from SVG attributes
  // Format: width="100" height="200" or width="100px" height="200px"
  const widthMatch = content.match(/width=["']([^"']+)["']/);
  const heightMatch = content.match(/height=["']([^"']+)["']/);
  if (widthMatch && heightMatch) {
    const width = parseFloat(widthMatch[1] ?? "");
    const height = parseFloat(heightMatch[1] ?? "");
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return validDimensions(Math.round(width), Math.round(height));
    }
  }
  // Try viewBox: viewBox="0 0 100 200"
  const viewBoxMatch = content.match(/viewBox=["']([^"']+)["']/);
  if (viewBoxMatch) {
    const parts = (viewBoxMatch[1] ?? "").split(/[\s,]+/).map(Number);
    const width = parts[2] ?? Number.NaN;
    const height = parts[3] ?? Number.NaN;
    if (parts.length === 4 && Number.isFinite(width) && Number.isFinite(height)) {
      return validDimensions(Math.round(width), Math.round(height));
    }
  }
  // Default dimensions for SVG if not specified
  return { width: 100, height: 100 };
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function validDimensions(width: number, height: number): { width: number; height: number } | undefined {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : undefined;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
