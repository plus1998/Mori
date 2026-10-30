import { nativeImage } from "electron";
import { ImageDisplayError } from "./image-display-store";

export function createImageDisplayThumbnail(bytes: Buffer) {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new ImageDisplayError("unsupported_type", "无法解码图片缩略图。");
  const size = image.getSize();
  const scale = Math.min(1, 64 / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const data = image.resize({ width, height, quality: "good" }).toPNG();
  return { data, width, height };
}
