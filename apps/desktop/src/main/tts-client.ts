import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type GeneratedAudioFile, TTS_REQUEST_TIMEOUT_MS, TtsError, type TtsToolInput } from "../shared/tts";
import type { TtsClientConfig } from "./tts-store";

export const MAX_TTS_AUDIO_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil((MAX_TTS_AUDIO_BYTES * 4) / 3) + 1024 * 1024;

export function normalizeTtsToolInput(input: TtsToolInput): TtsToolInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TtsError("invalid_input", "语音参数必须是对象。");
  const allowed = new Set(["text", "voice", "style", "output_name"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TtsError("invalid_input", `不支持的语音参数：${key}`);
  }
  function required(value: unknown, label: string, max: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new TtsError("invalid_input", `${label}不能为空且不能超过 ${max} 个字符。`);
    }
    return value.trim();
  }
  const text = required(input.text, "朗读文本", 32000);
  const voice = required(input.voice, "音色", 256);
  const style = required(input.style, "表达风格", 4000);
  if (
    input.output_name !== undefined &&
    (typeof input.output_name !== "string" || !/^[\p{L}\p{N}_-]{1,80}$/u.test(input.output_name))
  ) {
    throw new TtsError("invalid_input", "output_name 只允许 1..80 个字母、数字、下划线或连字符。");
  }
  return {
    text,
    voice,
    style,
    ...(input.output_name !== undefined ? { output_name: input.output_name } : {}),
  };
}

export async function generateSpeechToWorkspace(input: {
  config: TtsClientConfig;
  toolInput: TtsToolInput;
  generationRoot: string;
  threadDirectory: string;
  signal?: AbortSignal;
}): Promise<GeneratedAudioFile[]> {
  const args = normalizeTtsToolInput(input.toolInput);
  const { config } = input;
  if (!/^thread-[a-f0-9]+$/.test(input.threadDirectory))
    throw new TtsError("invalid_output_path", "语音会话目录无效。");
  const root = await fs.realpath(input.generationRoot);
  const signal = AbortSignal.any([
    AbortSignal.timeout(TTS_REQUEST_TIMEOUT_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  function ensureActive(): void {
    if (signal.aborted) {
      throw new TtsError(
        input.signal?.aborted ? "cancelled" : "timeout",
        input.signal?.aborted ? "语音生成已取消。" : "语音生成请求超时。",
      );
    }
  }
  ensureActive();
  let bytes: Buffer;
  let mimeType: string;
  try {
    const gemini = config.provider === "gemini";
    const response = await fetch(
      `${config.baseUrl.replace(/\/+$/, "")}/${gemini ? "interactions" : "audio/speech"}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(gemini ? { "x-goog-api-key": config.apiKey } : { Authorization: `Bearer ${config.apiKey}` }),
        },
        body: JSON.stringify(
          gemini
            ? {
                model: config.model,
                input: [
                  {
                    type: "user_input",
                    content: [
                      {
                        type: "text",
                        text: args.text,
                        annotations: [{ type: "speech_metadata", style: args.style }],
                      },
                    ],
                  },
                ],
                response_format: { type: "audio", mime_type: "audio/wav" },
                generation_config: { speech_config: [{ voice: args.voice }] },
                stream: false,
                store: false,
              }
            : {
                model: config.model,
                input: args.text,
                voice: args.voice,
                instructions: args.style,
                response_format: "mp3",
              },
        ),
        signal,
      },
    );
    if (!response.ok) {
      const raw = (await readBoundedBody(response, 16 * 1024)).toString("utf8");
      let message = raw;
      try {
        const json = JSON.parse(raw);
        if (typeof json.error?.message === "string") message = json.error.message;
      } catch {
        /* Preserve the provider's error body. */
      }
      const code = [401, 403].includes(response.status)
        ? "auth_failed"
        : response.status === 429
          ? "rate_limited"
          : "provider_error";
      throw new TtsError(
        code,
        message.slice(0, 2000) || `HTTP ${response.status}`,
        response.status,
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    if (gemini) {
      const raw = await readBoundedBody(response, MAX_JSON_BYTES);
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new TtsError("invalid_response", "Gemini 返回了无效 JSON。");
      }
      if (!isRecord(json) || (json.status !== undefined && json.status !== "completed")) {
        throw new TtsError("invalid_response", "Gemini 未完成语音生成。");
      }
      const blocks: Record<string, unknown>[] = [];
      if (Array.isArray(json.steps)) {
        for (const step of json.steps) {
          if (!isRecord(step) || !Array.isArray(step.content)) continue;
          for (const block of step.content) {
            if (isRecord(block) && block.type === "audio") blocks.push(block);
          }
        }
      }
      if (blocks.length !== 1 || typeof blocks[0]?.data !== "string") {
        throw new TtsError("invalid_response", `Gemini 返回了 ${blocks.length} 个音频块，预期为 1 个。`);
      }
      const block = blocks[0];
      if (block.mime_type !== "audio/wav")
        throw new TtsError("invalid_audio", `Gemini 返回了非 WAV 音频：${String(block.mime_type)}`);
      bytes = decodeAudioBase64(block.data as string);
      mimeType = "audio/wav";
    } else {
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (
        contentType !== "audio/mpeg" &&
        contentType !== "audio/mp3" &&
        contentType !== "application/octet-stream"
      ) {
        throw new TtsError(
          "invalid_audio",
          `兼容接口返回了非 MP3 响应：${contentType ?? "缺少 Content-Type"}`,
        );
      }
      bytes = await readBoundedBody(response, MAX_TTS_AUDIO_BYTES);
      mimeType = "audio/mpeg";
    }
    validateAudio(bytes, mimeType);
  } catch (error) {
    if (error instanceof TtsError) throw error;
    if (signal.aborted)
      throw new TtsError(
        input.signal?.aborted ? "cancelled" : "timeout",
        input.signal?.aborted ? "语音生成已取消。" : "语音生成请求超时。",
      );
    throw new TtsError(
      "network_error",
      `语音生成请求失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  ensureActive();
  const tempSuffix = `.${randomUUID()}.tmp`;
  let tempPath: string | undefined;
  try {
    let realDir = root;
    for (const segment of [".eco", "generated-audio", input.threadDirectory]) {
      const directory = path.join(realDir, segment);
      await fs.mkdir(directory, { recursive: true });
      realDir = await fs.realpath(directory);
      if (!realDir.startsWith(`${root}${path.sep}`))
        throw new TtsError("invalid_output_path", "语音输出目录逃逸了工作目录。");
    }
    const absolutePath = path.join(
      realDir,
      `${args.output_name ?? "speech"}-${randomUUID()}.${mimeType === "audio/wav" ? "wav" : "mp3"}`,
    );
    tempPath = `${absolutePath}${tempSuffix}`;
    await fs.writeFile(tempPath, bytes, { flag: "wx" });
    ensureActive();
    await fs.rename(tempPath, absolutePath);
    return [{ absolutePath, relativePath: path.relative(root, absolutePath), mimeType, bytes: bytes.length }];
  } catch (error) {
    if (tempPath) await fs.rm(tempPath, { force: true });
    if (error instanceof TtsError) throw error;
    throw new TtsError(
      "write_failed",
      `保存语音失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new TtsError("response_too_large", "语音响应超过大小限制。");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TtsError("invalid_response", "供应商返回了空响应。");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new TtsError("response_too_large", "语音响应超过大小限制。");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
function decodeAudioBase64(value: string): Buffer {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new TtsError("invalid_audio", "语音 Base64 编码无效。");
  return Buffer.from(value, "base64");
}
function validateAudio(bytes: Buffer, mime: string): void {
  if (bytes.length === 0 || bytes.length > MAX_TTS_AUDIO_BYTES)
    throw new TtsError("invalid_audio", "音频为空或超过 64 MB。");
  if (mime === "audio/wav") {
    if (
      bytes.length < 44 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WAVE" ||
      bytes.readUInt32LE(4) + 8 !== bytes.length
    )
      throw new TtsError("invalid_audio", "供应商返回了无效 WAV 文件。");
    let blockAlign = 0;
    let dataBytes = 0;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4);
      const length = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + length > bytes.length) throw new TtsError("invalid_audio", "WAV 数据块不完整。");
      if (type === "fmt ") {
        if (length < 16) throw new TtsError("invalid_audio", "WAV 格式数据块无效。");
        blockAlign = bytes.readUInt16LE(start + 12);
      }
      if (type === "data") dataBytes += length;
      offset = start + length + (length % 2);
    }
    if (offset !== bytes.length || blockAlign === 0 || dataBytes === 0 || dataBytes % blockAlign !== 0) {
      throw new TtsError("invalid_audio", "WAV 缺少有效的格式或音频数据。");
    }
  } else if (
    bytes.length < 4 ||
    !(bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
  ) {
    throw new TtsError("invalid_audio", "供应商返回的数据不是 MP3。");
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
