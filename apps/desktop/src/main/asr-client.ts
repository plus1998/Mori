import { asrDataUrlByteLength, MAX_ASR_DATA_URL_BYTES } from "../shared/asr-limits";
import {
  type AsrApiMode,
  type AsrClientConfig,
  normalizeAsrApiMode,
  normalizeAsrEndpoint,
} from "./asr-settings-store";

export interface AsrTranscribeRequest {
  audioWavBase64: string;
  mimeType?: string;
  filename?: string;
}

export interface AsrTranscribeResult {
  text: string;
}

export const DEFAULT_ASR_TIMEOUT_MS = 4 * 60 * 1000;

export function asrRequestPath(apiMode: AsrApiMode): string {
  return apiMode === "audio_transcriptions" ? "/audio/transcriptions" : "/chat/completions";
}

export function buildAsrRequestBody(
  config: AsrClientConfig,
  audioWavBase64: string,
  mimeType = "audio/wav",
): Record<string, unknown> {
  return {
    model: config.model,
    messages: [
      // Qwen ASR OpenAI-compatible API requires system content as [{ text }], not a plain string.
      ...(config.systemPrompt ? [{ role: "system", content: [{ text: config.systemPrompt }] }] : []),
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: { data: `data:${mimeType};base64,${audioWavBase64}` },
          },
        ],
      },
    ],
    stream: false,
    asr_options: { enable_itn: false },
  };
}

export function buildAsrTranscriptionsFormData(config: AsrClientConfig, audioWavBase64: string, mimeType = "audio/wav", filename = "audio.wav"): FormData {
  const bytes = Uint8Array.from(Buffer.from(audioWavBase64, "base64"));
  const form = new FormData();
  // File keeps filename/content-type on Electron/Node multipart more reliably than bare Blob.
  const file = new File([bytes], filename, { type: mimeType });
  form.append("file", file);
  form.append("model", config.model);
  if (config.systemPrompt) {
    form.append("prompt", config.systemPrompt);
  }
  return form;
}

function parseAsrApiError(payload: Record<string, unknown> | undefined, status: number): Error {
  const apiMessage =
    payload && typeof payload.error === "object" && payload.error
      ? (payload.error as Record<string, unknown>).message
      : undefined;
  return new Error(
    typeof apiMessage === "string" ? `ASR API 错误：${apiMessage}` : `ASR 请求失败（HTTP ${status}）。`,
  );
}

function parseChatCompletionsText(payload: Record<string, unknown> | undefined): string {
  const choices = payload?.choices;
  const content =
    Array.isArray(choices) &&
    choices[0] &&
    typeof choices[0] === "object" &&
    (choices[0] as Record<string, unknown>).message &&
    typeof (choices[0] as Record<string, unknown>).message === "object"
      ? ((choices[0] as Record<string, unknown>).message as Record<string, unknown>).content
      : undefined;
  return Array.isArray(content)
    ? content
        .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
    : typeof content === "string"
      ? content
      : typeof payload?.output_text === "string"
        ? payload.output_text
        : "";
}

function parseTranscriptionsText(payload: Record<string, unknown> | undefined): string {
  return typeof payload?.text === "string" ? payload.text : "";
}

export async function transcribeAsr(
  config: AsrClientConfig,
  request: AsrTranscribeRequest,
  options: { fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<AsrTranscribeResult> {
  if (
    !request.audioWavBase64 ||
    asrDataUrlByteLength(request.audioWavBase64) > MAX_ASR_DATA_URL_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(request.audioWavBase64)
  ) {
    throw new Error("录音数据无效。");
  }
  const apiMode = normalizeAsrApiMode(config.apiMode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS);
  try {
    const url = `${normalizeAsrEndpoint(config.endpoint)}${asrRequestPath(apiMode)}`;
    const response =
      apiMode === "audio_transcriptions"
        ? await (options.fetch ?? fetch)(url, {
            method: "POST",
            headers: { authorization: `Bearer ${config.apiKey}` },
            body: buildAsrTranscriptionsFormData(config, request.audioWavBase64, request.mimeType, request.filename),
            signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
          })
        : await (options.fetch ?? fetch)(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify(buildAsrRequestBody(config, request.audioWavBase64, request.mimeType)),
            signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
          });
    const rawText = await response.text().catch(() => "");
    let payload: Record<string, unknown> | undefined;
    try {
      payload = rawText ? (JSON.parse(rawText) as Record<string, unknown>) : undefined;
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      throw parseAsrApiError(payload, response.status);
    }
    const normalizedContent =
      apiMode === "audio_transcriptions"
        ? parseTranscriptionsText(payload)
        : parseChatCompletionsText(payload);
    if (!normalizedContent.trim()) {
      throw new Error("ASR 返回为空或格式无效。");
    }
    return { text: normalizedContent.trim() };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("ASR 请求超时。");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
