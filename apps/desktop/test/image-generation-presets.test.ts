import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  generateImagesToWorkspace,
  normalizeImageGenerationToolInput,
} from "../src/main/image-generation-client";
import type { ImageGenerationClientConfig } from "../src/main/image-generation-store";
import {
  imagePresetParameters,
  isValidCustomImageSize,
  supportsCustomImageDimensions,
} from "../src/shared/image-generation-presets";

const config: ImageGenerationClientConfig = {
  profileId: "preset",
  profileName: "Preset",
  provider: "openai",
  model: "gpt-image-2",
  endpoint: "https://example.com/v1",
  chatModel: "",
  apiKey: "test",
  supportsImageToImage: true,
};

test("resolution presets produce real dimensions and align GPT image sizes explicitly", () => {
  expect(imagePresetParameters("chatgpt_web", "16:9", "1080P")).toEqual({ size: "1920x1080" });
  expect(imagePresetParameters("codex", "16:9", "1080P")).toEqual({ size: "1920x1088" });
  expect(imagePresetParameters("openai", "16:9", "2K")).toEqual({ size: "2560x1440" });
  expect(imagePresetParameters("openai", "9:16", "4K")).toEqual({ size: "2160x3840" });
  expect(imagePresetParameters("openai_compatible", "3:4", "1080P")).toEqual({ size: "1080x1440" });
  expect(imagePresetParameters("gemini", "3:4", "1080P")).toEqual({ size: "1K", aspect_ratio: "3:4" });
  expect(imagePresetParameters("gemini", "21:9", "4K")).toEqual({ size: "4K", aspect_ratio: "21:9" });
});

test("modern image presets pass provider validation while legacy models retain their limits", () => {
  for (const provider of ["openai", "codex"] as const) {
    for (const resolution of ["1080P", "2K", "4K"] as const) {
      const params = imagePresetParameters(provider, "16:9", resolution);
      const input = { prompt: "A landscape", ...params };
      expect(normalizeImageGenerationToolInput(input, { ...config, provider })).toMatchObject(input);
    }
  }
  expect(() =>
    normalizeImageGenerationToolInput(
      { prompt: "x", size: "3840x2160" },
      {
        ...config,
        model: "gpt-image-1.5",
      },
    ),
  ).toThrow("当前模型");
  expect(supportsCustomImageDimensions("gpt-image-2.6-flare")).toBe(true);
  expect(supportsCustomImageDimensions("gpt-image-2-2026-04-21")).toBe(true);
  expect(supportsCustomImageDimensions("gpt-image-1.5")).toBe(false);
});

test("impossible and oversized presets fail instead of silently substituting another size", () => {
  for (const size of ["1920x1080", "512x512", "4096x2160", "3840x3840", "3840x1024"]) {
    expect(isValidCustomImageSize(size)).toBe(false);
    expect(() => normalizeImageGenerationToolInput({ prompt: "x", size }, config)).toThrow();
  }
  expect(isValidCustomImageSize(imagePresetParameters("openai", "21:9", "4K").size)).toBe(false);
  expect(isValidCustomImageSize("3840x2160")).toBe(true);
});

test("4K dimensions and reference bytes reach the image edit request without substitution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-image-preset-"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  let size: FormDataEntryValue | null = null;
  let reference: Uint8Array | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe("/images/edits");
      const body = await request.formData();
      size = body.get("size");
      reference = new Uint8Array(await (body.get("image[]") as File).arrayBuffer());
      return Response.json({ data: [{ b64_json: png.toString("base64") }] });
    },
  });
  try {
    const inputPath = path.join(root, "reference.png");
    await fs.writeFile(inputPath, png);
    const result = await generateImagesToWorkspace({
      config: { ...config, endpoint: String(server.url).replace(/\/$/, "") },
      toolInput: {
        prompt: "Use the reference",
        input_images: [inputPath],
        ...imagePresetParameters("openai", "16:9", "4K"),
      },
      workspacePath: root,
      generationRoot: root,
      threadDirectory: "preset",
    });
    expect(size).toBe("3840x2160");
    expect(reference).toEqual(new Uint8Array(png));
    const image = result[0];
    if (!image) throw new Error("Expected a generated image");
    expect(await fs.readFile(image.absolutePath)).toEqual(png);
  } finally {
    server.stop(true);
    await fs.rm(root, { recursive: true, force: true });
  }
});
