import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  generateImagesToWorkspace,
  normalizeImageGenerationToolInput,
} from "../src/main/image-generation-client";
import type { ImageGenerationClientConfig } from "../src/main/image-generation-store";
import { ImageGenerationError } from "../src/shared/image-generation";
import { CodexImageBatchError } from "../src/main/codex-image-service";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const pngBase64 = pngBytes.toString("base64");

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function generationRoot(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eco-image-client-"));
  temporaryDirectories.push(directory);
  return directory;
}

function config(
  provider: ImageGenerationClientConfig["provider"],
  overrides?: Partial<ImageGenerationClientConfig>,
): ImageGenerationClientConfig {
  return {
    profileId: "profile-1",
    profileName: "Primary",
    provider,
    endpoint:
      provider === "gemini"
        ? "https://generativelanguage.googleapis.com/v1beta"
        : "https://api.example.com/v1",
    model: provider === "gemini" ? "gemini-image" : "exact-image-model",
    apiKey: "secret-key",
    supportsImageToImage: true,
    ...overrides,
  };
}

test("a partial Codex batch writes completed images into the failed artifact payload", async () => {
  const root = await generationRoot();
  try {
    await generateImagesToWorkspace({
      config: config("codex", { apiKey: "", model: "gpt-image-2" }),
      toolInput: { prompt: "leaf", count: 2 }, generationRoot: root,
      workspacePath: root, threadDirectory: "codex-partial",
      generateCodex: async () => { throw new CodexImageBatchError(
        new ImageGenerationError("usage_limit_reached", "second image limited", 429),
        [{ bytes: pngBytes, mimeType: "image/png" }],
      ); },
    });
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ImageGenerationError);
    const failure = error as ImageGenerationError;
    expect(failure.code).toBe("usage_limit_reached");
    expect(failure.partialImages).toHaveLength(1);
    expect(await fs.readFile(failure.partialImages[0]!.absolutePath)).toEqual(pngBytes);
  }
});

test("OpenAI request preserves model and parameters and writes under the thread directory", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url, init) => {
    requestedUrl = String(url);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const root = await generationRoot();
  const images = await generateImagesToWorkspace({
    config: config("openai"),
    toolInput: {
      prompt: "Draw a blue cube",
      size: "1536x1024",
      quality: "high",
      count: 1,
      output_name: "cube",
    },
    generationRoot: root,
    threadDirectory: "thread-safe",
    workspacePath: root,
  });

  expect(requestedUrl).toBe("https://api.example.com/v1/images/generations");
  expect(requestedBody).toEqual({
    model: "exact-image-model",
    prompt: "Draw a blue cube",
    n: 1,
    size: "1536x1024",
    quality: "high",
  });
  expect(images[0]?.relativePath).toStartWith(
    path.join(".eco", "generated-images", "thread-safe", "cube-1-"),
  );
  expect(await fs.readFile(images[0]!.absolutePath)).toEqual(Buffer.from(pngBase64, "base64"));
});

test("OpenAI image-to-image uses /images/edits multipart with image[] files", async () => {
  let requestedUrl = "";
  let contentType = "";
  let form: FormData | undefined;
  globalThis.fetch = (async (url, init) => {
    requestedUrl = String(url);
    contentType = String((init?.headers as Record<string, string>)?.["Content-Type"] ?? "");
    form = init?.body as FormData;
    return new Response(JSON.stringify({ data: [{ b64_json: pngBase64 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const root = await generationRoot();
  const reference = path.join(root, "source.png");
  await fs.writeFile(reference, pngBytes);

  await generateImagesToWorkspace({
    config: config("openai"),
    toolInput: {
      prompt: "Make it sunset",
      input_images: ["source.png"],
      size: "1024x1024",
      quality: "high",
      count: 1,
    },
    generationRoot: root,
    threadDirectory: "thread-edit",
    workspacePath: root,
  });

  expect(requestedUrl).toBe("https://api.example.com/v1/images/edits");
  expect(contentType).not.toContain("application/json");
  expect(form?.get("model")).toBe("exact-image-model");
  expect(form?.get("prompt")).toBe("Make it sunset");
  expect(form?.get("n")).toBe("1");
  expect(form?.get("size")).toBe("1024x1024");
  expect(form?.get("quality")).toBe("high");
  const image = form?.get("image[]");
  expect(image).toBeInstanceOf(Blob);
});

test("Gemini image-to-image puts inlineData parts before the text prompt", async () => {
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { data: pngBase64, mimeType: "image/png" } }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const root = await generationRoot();
  await fs.writeFile(path.join(root, "ref.png"), pngBytes);

  await generateImagesToWorkspace({
    config: config("gemini"),
    toolInput: { prompt: "Cartoonize", input_images: [path.join(root, "ref.png")], count: 1 },
    generationRoot: root,
    threadDirectory: "thread-gemini-edit",
    workspacePath: root,
  });

  const contents = requestedBody.contents as Array<{ parts: Array<Record<string, unknown>> }>;
  expect(contents[0]?.parts).toEqual([
    { inlineData: { mimeType: "image/png", data: pngBase64 } },
    { text: "Cartoonize" },
  ]);
});

test("Gemini request uses imageConfig without inventing OpenAI fields", async () => {
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url, init) => {
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { data: pngBase64, mimeType: "image/png" } }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const root = await generationRoot();
  await generateImagesToWorkspace({
    config: config("gemini"),
    toolInput: { prompt: "Portrait", size: "2k", aspect_ratio: "3:4", count: 1 },
    generationRoot: root,
    threadDirectory: "thread-gemini",
    workspacePath: root,
  });
  expect(requestedBody).toEqual({
    contents: [{ role: "user", parts: [{ text: "Portrait" }] }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig: { imageSize: "2K", aspectRatio: "3:4" },
    },
  });
});

test("provider-specific unsupported parameters fail with a stable error code", () => {
  for (const [provider, input] of [
    ["gemini", { prompt: "x", quality: "high" }],
    ["openai", { prompt: "x", aspect_ratio: "1:1" }],
    ["openai", { prompt: "x", size: "512x512" }],
  ] as const) {
    try {
      normalizeImageGenerationToolInput(input, provider);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ImageGenerationError);
      expect((error as ImageGenerationError).code).toBe("unsupported_parameter");
    }
  }
});

test("input_images are rejected when the profile disables image-to-image", () => {
  try {
    normalizeImageGenerationToolInput(
      { prompt: "edit", input_images: ["a.png"] },
      config("openai", { supportsImageToImage: false }),
    );
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ImageGenerationError);
    expect((error as ImageGenerationError).code).toBe("unsupported_parameter");
  }
});

test("reference images accept external absolute, relative and symlink paths", async () => {
  const root = await generationRoot();
  const outside = await generationRoot();
  const reference = path.join(outside, "reference.png");
  const link = path.join(root, "reference-link.png");
  await fs.writeFile(reference, pngBytes);
  await fs.symlink(reference, link);
  for (const referencePath of [reference, path.relative(root, reference), link]) {
    let received = false;
    await generateImagesToWorkspace({
      config: config("codex"),
      toolInput: { prompt: "x", input_images: [referencePath] },
      generationRoot: root,
      threadDirectory: "thread-edit",
      workspacePath: root,
      generateCodex: async (_input, images) => {
        expect(images[0]?.bytes).toEqual(pngBytes);
        received = true;
        return [{ bytes: pngBytes, mimeType: "image/png" }];
      },
    });
    expect(received).toBe(true);
  }
});

test("invalid image bytes are returned as an Agent-visible stable error", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("not-image").toString("base64") }] }), {
      status: 200,
    })) as typeof fetch;
  const root = await generationRoot();
  try {
    await generateImagesToWorkspace({
      config: config("openai_compatible"),
      toolInput: { prompt: "x" },
      generationRoot: root,
      threadDirectory: "thread-error",
      workspacePath: root,
    });
    throw new Error("expected invalid image failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ImageGenerationError);
    expect((error as ImageGenerationError).code).toBe("invalid_image");
  }
});
