import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  type GeneratedImageFile,
  IMAGE_GENERATION_REQUEST_TIMEOUT_MS,
  ImageGenerationError,
  type ImageGenerationProvider,
  type ImageGenerationToolInput,
} from "../shared/image-generation";
import type { ImageGenerationClientConfig } from "./image-generation-store";
import { CodexImageBatchError } from "./codex-image-service";

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024;
const OPENAI_MAX_INPUT_IMAGES = 16;
const GEMINI_MAX_INPUT_IMAGES = 3;
const OPENAI_SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const GEMINI_SIZES = new Set(["1K", "2K", "4K"]);
const GEMINI_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

export interface ImagePayload {
  bytes: Buffer;
  mimeType: string;
}

export interface LoadedInputImage {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

type NormalizedToolInput = Required<Pick<ImageGenerationToolInput, "prompt" | "count">> &
  Omit<ImageGenerationToolInput, "prompt" | "count">;

export async function generateImagesToWorkspace(input: {
  config: ImageGenerationClientConfig;
  toolInput: ImageGenerationToolInput;
  generationRoot: string;
  threadDirectory: string;
  workspacePath: string;
  signal?: AbortSignal;
  generateCodex?: (
    input: ImageGenerationToolInput,
    images: LoadedInputImage[],
    signal?: AbortSignal,
    route?: "codex" | "chatgpt_web",
  ) => Promise<ImagePayload[]>;
}): Promise<GeneratedImageFile[]> {
  const args = normalizeToolInput(input.toolInput, input.config.provider, input.config.supportsImageToImage);
  const inputImages =
    args.input_images && args.input_images.length > 0
      ? await loadInputImages(args.input_images, input.workspacePath, input.config.provider)
      : [];
  let payloads: ImagePayload[];
  try {
    payloads =
      input.config.provider === "codex" || input.config.provider === "chatgpt_web"
        ? input.generateCodex
          ? await input.generateCodex(args, inputImages, input.signal, input.config.provider)
          : (() => {
              throw new ImageGenerationError("codex_unavailable", "Codex 登录生图服务尚未初始化。");
            })()
        : input.config.provider === "gemini"
          ? await generateGemini(input.config, args, inputImages, input.signal)
          : await generateOpenAi(input.config, args, inputImages, input.signal);
  } catch (error) {
    if (error instanceof CodexImageBatchError) {
      const partial = await writeImages(error.payloads, {
        generationRoot: input.generationRoot,
        threadDirectory: input.threadDirectory,
        ...(args.output_name ? { outputName: args.output_name } : {}),
      });
      throw new ImageGenerationError(
        error.code,
        error.message,
        error.providerStatus,
        error.requestId,
        partial,
      );
    }
    throw error;
  }
  if (payloads.length === 0) {
    throw new ImageGenerationError("empty_response", "供应商未返回任何图片。");
  }
  return writeImages(payloads, {
    generationRoot: input.generationRoot,
    threadDirectory: input.threadDirectory,
    ...(args.output_name ? { outputName: args.output_name } : {}),
  });
}

export function normalizeImageGenerationToolInput(
  input: ImageGenerationToolInput,
  providerOrConfig: ImageGenerationClientConfig | ImageGenerationClientConfig["provider"],
): ImageGenerationToolInput {
  if (typeof providerOrConfig === "string") {
    return normalizeToolInput(input, providerOrConfig, true);
  }
  return normalizeToolInput(input, providerOrConfig.provider, providerOrConfig.supportsImageToImage);
}

function normalizeToolInput(
  input: ImageGenerationToolInput,
  provider: ImageGenerationProvider,
  supportsImageToImage: boolean,
): NormalizedToolInput {
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) throw new ImageGenerationError("invalid_prompt", "prompt 不能为空。");
  if (prompt.length > 32_000) {
    throw new ImageGenerationError("invalid_prompt", "prompt 不能超过 32000 个字符。");
  }
  const count = input.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) {
    throw new ImageGenerationError("unsupported_parameter", "count 必须是 1 到 4 的整数。");
  }
  const size = input.size?.trim();
  const aspectRatio = input.aspect_ratio?.trim();
  const inputImages = normalizeInputImagePaths(input.input_images);
  if (inputImages.length > 0 && !supportsImageToImage) {
    throw new ImageGenerationError(
      "unsupported_parameter",
      "当前创意绘画 Profile 未开启图片编辑，不能传入 input_images。",
    );
  }
  if (provider === "gemini") {
    if (count !== 1) {
      throw new ImageGenerationError("unsupported_parameter", "Gemini 渠道首版只支持 count=1。");
    }
    if (size && !GEMINI_SIZES.has(size.toUpperCase())) {
      throw new ImageGenerationError("unsupported_parameter", "Gemini size 仅支持 1K、2K 或 4K。");
    }
    if (aspectRatio && !GEMINI_ASPECT_RATIOS.has(aspectRatio)) {
      throw new ImageGenerationError(
        "unsupported_parameter",
        `Gemini aspect_ratio 不受支持：${aspectRatio}。`,
      );
    }
    if (input.quality !== undefined) {
      throw new ImageGenerationError("unsupported_parameter", "Gemini 渠道不支持 quality 参数。");
    }
  } else {
    if (size && (provider === "openai" || provider === "codex") && !OPENAI_SIZES.has(size)) {
      throw new ImageGenerationError(
        "unsupported_parameter",
        "OpenAI size 仅支持 auto、1024x1024、1536x1024 或 1024x1536。",
      );
    }
    if (aspectRatio) {
      throw new ImageGenerationError("unsupported_parameter", "OpenAI-style 渠道不支持 aspect_ratio 参数。");
    }
  }
  const outputName = input.output_name?.trim();
  if (outputName && (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(outputName) || outputName.includes(".."))) {
    throw new ImageGenerationError(
      "invalid_output_name",
      "output_name 只能包含字母、数字、点、下划线和连字符，且不能包含路径片段。",
    );
  }
  return {
    prompt,
    count,
    ...(size ? { size: provider === "gemini" ? size.toUpperCase() : size } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(input.quality ? { quality: input.quality } : {}),
    ...(outputName ? { output_name: outputName } : {}),
    ...(inputImages.length > 0 ? { input_images: inputImages } : {}),
  };
}

function normalizeInputImagePaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ImageGenerationError("unsupported_parameter", "input_images 必须是字符串路径数组。");
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new ImageGenerationError("unsupported_parameter", "input_images 只能包含非空字符串路径。");
    }
    paths.push(entry.trim());
  }
  return paths;
}

async function loadInputImages(
  imagePaths: string[],
  workspacePath: string,
  provider: ImageGenerationProvider,
): Promise<LoadedInputImage[]> {
  const maxCount = provider === "gemini" ? GEMINI_MAX_INPUT_IMAGES : OPENAI_MAX_INPUT_IMAGES;
  if (imagePaths.length > maxCount) {
    throw new ImageGenerationError(
      "unsupported_parameter",
      provider === "gemini"
        ? `Gemini 图片编辑最多支持 ${GEMINI_MAX_INPUT_IMAGES} 张参考图。`
        : `OpenAI-style 图片编辑最多支持 ${OPENAI_MAX_INPUT_IMAGES} 张参考图。`,
    );
  }
  const workspaceRoot = path.resolve(workspacePath);
  const loaded: LoadedInputImage[] = [];
  for (const rawPath of imagePaths) {
    const absolutePath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(workspaceRoot, rawPath);
    if (absolutePath !== workspaceRoot && !absolutePath.startsWith(`${workspaceRoot}${path.sep}`)) {
      throw new ImageGenerationError("invalid_input_path", `参考图必须位于当前工作区内：${rawPath}`);
    }
    let linkStat;
    try {
      linkStat = await fs.lstat(absolutePath);
    } catch {
      throw new ImageGenerationError("invalid_input_path", `参考图不存在：${rawPath}`);
    }
    if (linkStat.isSymbolicLink()) {
      throw new ImageGenerationError("invalid_input_path", `不允许使用符号链接作为参考图：${rawPath}`);
    }
    if (!linkStat.isFile()) {
      throw new ImageGenerationError("invalid_input_path", `参考图不是普通文件：${rawPath}`);
    }
    const realPath = await fs.realpath(absolutePath);
    // The root is resolved the same way the file is: on macOS `/var` (and therefore every
    // temp directory) is a symlink to `/private/var`, so comparing a resolved path against
    // an unresolved root rejects a reference image that is plainly inside the workspace.
    const realRoot = await fs.realpath(workspaceRoot).catch(() => workspaceRoot);
    if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
      throw new ImageGenerationError("invalid_input_path", `参考图解析后逃逸了工作区：${rawPath}`);
    }
    if (linkStat.size > MAX_INPUT_IMAGE_BYTES) {
      throw new ImageGenerationError("image_too_large", `参考图超过 50 MB 限制：${rawPath}`);
    }
    const bytes = await fs.readFile(absolutePath);
    if (bytes.length > MAX_INPUT_IMAGE_BYTES) {
      throw new ImageGenerationError("image_too_large", `参考图超过 50 MB 限制：${rawPath}`);
    }
    const mimeType = detectImageMime(bytes);
    if (!mimeType) {
      throw new ImageGenerationError("invalid_image", `参考图必须是 PNG、JPEG 或 WebP：${rawPath}`);
    }
    loaded.push({
      bytes,
      mimeType,
      fileName: path.basename(absolutePath),
    });
  }
  return loaded;
}

async function generateOpenAi(
  config: ImageGenerationClientConfig,
  args: NormalizedToolInput,
  inputImages: LoadedInputImage[],
  signal?: AbortSignal,
): Promise<ImagePayload[]> {
  const base = config.endpoint.replace(/\/images\/(?:generations|edits)\/?$/i, "");
  if (inputImages.length > 0) {
    const endpoint = `${base}/images/edits`;
    const form = new FormData();
    form.append("model", config.model);
    form.append("prompt", args.prompt);
    form.append("n", String(args.count));
    if (args.size) form.append("size", args.size);
    if (args.quality) form.append("quality", args.quality);
    for (const image of inputImages) {
      form.append(
        "image[]",
        new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
        image.fileName,
      );
    }
    const response = await providerFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: form,
      },
      signal,
    );
    return readOpenAiImagePayloads(response, args.count, signal);
  }

  const endpoint = `${base}/images/generations`;
  const body = {
    model: config.model,
    prompt: args.prompt,
    n: args.count,
    ...(args.size ? { size: args.size } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
  };
  const response = await providerFetch(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    signal,
  );
  return readOpenAiImagePayloads(response, args.count, signal);
}

async function readOpenAiImagePayloads(
  response: Response,
  expectedCount: number,
  signal?: AbortSignal,
): Promise<ImagePayload[]> {
  const json = await readProviderJson(response);
  if (!response.ok) throw providerHttpError(response, json);
  const data = Array.isArray(json.data) ? json.data : undefined;
  if (!data) throw new ImageGenerationError("invalid_response", "OpenAI-style 响应缺少 data 数组。");
  const images: ImagePayload[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    if (typeof entry.b64_json === "string" && entry.b64_json) {
      images.push(validateImagePayload(Buffer.from(entry.b64_json, "base64"), undefined));
      continue;
    }
    if (typeof entry.url === "string" && entry.url) {
      images.push(await fetchProviderImage(entry.url, signal));
    }
  }
  if (images.length !== expectedCount) {
    throw new ImageGenerationError(
      "partial_response",
      `供应商请求 ${expectedCount} 张图片，但只返回 ${images.length} 张。`,
    );
  }
  return images;
}

async function generateGemini(
  config: ImageGenerationClientConfig,
  args: NormalizedToolInput,
  inputImages: LoadedInputImage[],
  signal?: AbortSignal,
): Promise<ImagePayload[]> {
  const base = config.endpoint.replace(/\/models(?:\/.*)?$/i, "");
  const endpoint = `${base}/models/${encodeURIComponent(config.model)}:generateContent`;
  const imageConfig = {
    ...(args.size ? { imageSize: args.size } : {}),
    ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
  };
  const parts: Array<Record<string, unknown>> = [
    ...inputImages.map((image) => ({
      inlineData: {
        mimeType: image.mimeType,
        data: image.bytes.toString("base64"),
      },
    })),
    { text: args.prompt },
  ];
  const response = await providerFetch(
    endpoint,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
        },
      }),
    },
    signal,
  );
  const json = await readProviderJson(response);
  if (!response.ok) throw providerHttpError(response, json);
  const images: ImagePayload[] = [];
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts))
      continue;
    for (const part of candidate.content.parts) {
      if (!isRecord(part)) continue;
      const inline = isRecord(part.inlineData)
        ? part.inlineData
        : isRecord(part.inline_data)
          ? part.inline_data
          : undefined;
      if (!inline || typeof inline.data !== "string") continue;
      images.push(
        validateImagePayload(
          Buffer.from(inline.data, "base64"),
          typeof inline.mimeType === "string"
            ? inline.mimeType
            : typeof inline.mime_type === "string"
              ? inline.mime_type
              : undefined,
        ),
      );
    }
  }
  if (images.length !== 1) {
    throw new ImageGenerationError(
      "invalid_response",
      `Gemini 返回了 ${images.length} 张图片，预期为 1 张。`,
    );
  }
  return images;
}

async function providerFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), IMAGE_GENERATION_REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageGenerationError("timeout", "创意绘画请求超时或已取消。");
    }
    throw new ImageGenerationError(
      "network_error",
      `创意绘画网络请求失败：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

async function readProviderJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value)) return value;
  } catch {
    // Report a bounded response below.
  }
  if (!response.ok) {
    return { error: { message: text.slice(0, 2_000) || `HTTP ${response.status}` } };
  }
  throw new ImageGenerationError("invalid_response", `供应商返回了非 JSON 响应：${text.slice(0, 300)}`);
}

function providerHttpError(response: Response, json: Record<string, unknown>): ImageGenerationError {
  const error = isRecord(json.error) ? json.error : undefined;
  const message =
    (typeof error?.message === "string" && error.message.trim()) ||
    (typeof json.message === "string" && json.message.trim()) ||
    `HTTP ${response.status}`;
  const code =
    response.status === 401 || response.status === 403
      ? "auth_failed"
      : response.status === 429
        ? "rate_limited"
        : "provider_error";
  const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
  return new ImageGenerationError(code, message.slice(0, 2_000), response.status, requestId);
}

async function fetchProviderImage(url: string, signal?: AbortSignal): Promise<ImagePayload> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageGenerationError("invalid_response", "供应商返回了无效图片 URL。");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ImageGenerationError("unsafe_image_url", "供应商图片 URL 必须是 HTTP 或 HTTPS 地址。");
  }
  const response = await providerFetch(parsed.toString(), { method: "GET" }, signal);
  if (!response.ok) {
    throw new ImageGenerationError("image_download_failed", `下载供应商图片失败：HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES) {
    throw new ImageGenerationError("image_too_large", "供应商图片超过 64 MB 限制。");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return validateImagePayload(bytes, response.headers.get("content-type") ?? undefined);
}

function validateImagePayload(bytes: Buffer, declaredMime?: string): ImagePayload {
  if (bytes.length === 0) throw new ImageGenerationError("invalid_response", "供应商返回了空图片。");
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new ImageGenerationError("image_too_large", "供应商图片超过 64 MB 限制。");
  const detected = detectImageMime(bytes);
  if (!detected)
    throw new ImageGenerationError("invalid_image", "供应商返回的数据不是受支持的 PNG、JPEG 或 WebP 图片。");
  if (
    declaredMime &&
    declaredMime.split(";")[0]?.trim() &&
    !declaredMime.toLowerCase().includes(detected.split("/")[1]!)
  ) {
    throw new ImageGenerationError("invalid_image", "供应商图片 MIME 与文件内容不一致。");
  }
  return { bytes, mimeType: detected };
}

async function writeImages(
  payloads: ImagePayload[],
  input: { generationRoot: string; threadDirectory: string; outputName?: string },
): Promise<GeneratedImageFile[]> {
  const outputDir = path.resolve(input.generationRoot, ".eco", "generated-images", input.threadDirectory);
  const allowedRoot = path.resolve(input.generationRoot, ".eco", "generated-images");
  if (outputDir !== allowedRoot && !outputDir.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new ImageGenerationError("invalid_output_path", "图片输出路径逃逸了工作目录。");
  }
  await fs.mkdir(outputDir, { recursive: true });
  const written: GeneratedImageFile[] = [];
  try {
    for (const [index, payload] of payloads.entries()) {
      const ext =
        payload.mimeType === "image/png" ? "png" : payload.mimeType === "image/jpeg" ? "jpg" : "webp";
      const prefix = input.outputName ?? `image-${Date.now()}`;
      const name = `${prefix}-${index + 1}-${randomUUID().slice(0, 8)}.${ext}`;
      const absolutePath = path.join(outputDir, name);
      const tempPath = `${absolutePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, payload.bytes, { flag: "wx" });
      await fs.rename(tempPath, absolutePath);
      written.push({
        absolutePath,
        relativePath: path.relative(input.generationRoot, absolutePath),
        mimeType: payload.mimeType,
        bytes: payload.bytes.length,
      });
    }
    return written;
  } catch (error) {
    throw new ImageGenerationError(
      "write_failed",
      `保存图片失败：${error instanceof Error ? error.message : String(error)}`,
      undefined,
      undefined,
      written,
    );
  }
}

function detectImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
