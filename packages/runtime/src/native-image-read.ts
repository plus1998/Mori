import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const IMAGE_READ_DISABLED_REASON =
  "当前 Agent 模型已关闭视觉，禁止直接读取图片。请使用已配置且支持图片的 image_view，或在提供商的模型设置中启用视觉。";

/** Inspect only the file signature; renamed raster files must obey the same policy. */
export async function isNativeImageFile(filePath: string, cwd: string): Promise<boolean> {
  if (/\.(png|jpe?g|gif|webp|bmp|ico|tiff?|avif|hei[cf])$/i.test(filePath)) return true;
  const expanded = filePath.startsWith("~/") ? path.join(homedir(), filePath.slice(2)) : filePath;
  let file: FileHandle | undefined;
  try {
    file = await open(path.resolve(cwd, expanded), "r");
    const header = Buffer.alloc(32);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    return (
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
      /^(GIF87a|GIF89a)/.test(bytes.toString("ascii")) ||
      (bytes.length >= 18 &&
        bytes.toString("ascii", 0, 2) === "BM" &&
        [12, 40, 52, 56, 64, 108, 124].includes(bytes.readUInt32LE(14))) ||
      (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") ||
      bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) ||
      bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
      bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])) ||
      (bytes.toString("ascii", 4, 8) === "ftyp" &&
        /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(bytes.toString("ascii", 8, 12)))
    );
  } catch (error) {
    // Leave missing files/directories to the native reader's own error handling.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "ENOTDIR", "EISDIR"].includes(String(error.code))
    )
      return false;
    throw error;
  } finally {
    await file?.close();
  }
}
