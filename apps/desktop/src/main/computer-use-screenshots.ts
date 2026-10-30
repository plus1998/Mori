import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpToolCallResult } from "./mcp-streamable-http";

type ScreenshotReference = { type: "text"; text: string };

/** Replace screenshot attachments, including structured copies, before any kernel receives them. */
export async function saveComputerUseScreenshots(
  result: McpToolCallResult,
  directory: string,
): Promise<McpToolCallResult> {
  const references = new Map<string, Promise<ScreenshotReference>>();
  const replace = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(replace));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string") {
      const key = `${record.mimeType}:${record.data}`;
      let reference = references.get(key);
      if (!reference) {
        reference = saveScreenshot(directory, record.data, record.mimeType);
        references.set(key, reference);
      }
      return reference;
    }
    return Object.fromEntries(
      await Promise.all(Object.entries(record).map(async ([key, item]) => [key, await replace(item)])),
    );
  };
  return (await replace(result)) as McpToolCallResult;
}

async function saveScreenshot(
  directory: string,
  data: string,
  mimeType: string,
): Promise<ScreenshotReference> {
  try {
    const extensions: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    const extension = Object.hasOwn(extensions, mimeType) ? extensions[mimeType] : undefined;
    if (!extension) throw new Error(`Unsupported screenshot MIME type: ${mimeType}`);
    const imagePath = path.resolve(directory, `${randomUUID()}.${extension}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(imagePath, Buffer.from(data, "base64"), { mode: 0o600, flag: "wx" });
    return {
      type: "text",
      text: `截图已保存：${JSON.stringify(imagePath)}。如需分析，请调用 eco_image_view:view_image，传入该 path 和具体的 prompt。`,
    };
  } catch (error) {
    // The action may already have executed: report the screenshot failure without
    // changing isError or encouraging an accidental repeat of a click/key press.
    return {
      type: "text",
      text: `截图保存失败，无法转交 image_view：${error instanceof Error ? error.message : String(error)}。工具原执行状态保持不变，请勿仅因此重复操作。`,
    };
  }
}
