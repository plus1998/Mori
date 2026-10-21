/** Structured API error metadata carried on OTLP / thread events (not parsed from UI stream text). */

export interface ThreadApiErrorInfo {
  statusCode?: number;
  code?: string;
  /** User-facing summary (Chinese when mapped, otherwise cleaned upstream text). */
  message: string;
  model?: string;
  /** Codex app-server's structured `turn.error.codexErrorInfo`, retained verbatim. */
  codexErrorInfo?: unknown;
  /** Codex app-server's structured `turn.error.additionalDetails`, retained verbatim. */
  additionalDetails?: string;
  /** Complete structured `turn.error` object when available. */
  rawTurnError?: unknown;
  param?: string;
  logicalRequestId?: string;
  providerRequestId?: string;
  responseId?: string;
  accountId?: string;
  threadId?: string;
  turnId?: string;
  runAttemptId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorFromJson(value: unknown): { message?: string; code?: string } {
  if (!isRecord(value)) {
    return {};
  }

  const directMessage =
    typeof value.message === "string" && value.message.trim() ? value.message.trim() : undefined;
  const directCode = typeof value.code === "string" && value.code.trim() ? value.code.trim() : undefined;
  const directType = typeof value.type === "string" && value.type.trim() ? value.type.trim() : undefined;

  if (isRecord(value.error)) {
    const nestedMessage =
      typeof value.error.message === "string" && value.error.message.trim()
        ? value.error.message.trim()
        : undefined;
    const nestedCode =
      typeof value.error.code === "string" && value.error.code.trim()
        ? value.error.code.trim()
        : typeof value.error.type === "string" && value.error.type.trim()
          ? value.error.type.trim()
          : undefined;
    return compactErrorFields({
      message: nestedMessage ?? directMessage,
      code: nestedCode ?? directCode ?? directType,
    });
  }

  if (isRecord(value.response) && isRecord(value.response.error)) {
    const responseError = value.response.error;
    const responseMessage =
      typeof responseError.message === "string" && responseError.message.trim()
        ? responseError.message.trim()
        : undefined;
    const responseCode =
      typeof responseError.code === "string" && responseError.code.trim()
        ? responseError.code.trim()
        : undefined;
    return compactErrorFields({
      message: responseMessage ?? directMessage,
      code: responseCode ?? directCode ?? directType,
    });
  }

  return compactErrorFields({
    message: directMessage,
    code: directCode ?? directType,
  });
}

function compactErrorFields(input: { message?: string | undefined; code?: string | undefined }): {
  message?: string;
  code?: string;
} {
  const result: { message?: string; code?: string } = {};
  if (input.message) {
    result.message = input.message;
  }
  if (input.code) {
    result.code = input.code;
  }
  return result;
}

function stripSseArtifacts(text: string): string {
  const sseIndex = text.search(/\bevent:\s*[\w.-]+/i);
  if (sseIndex >= 0) {
    return text.slice(0, sseIndex).trim();
  }
  const dataIndex = text.search(/\bdata:\s*\{/i);
  if (dataIndex >= 0) {
    return text.slice(0, dataIndex).trim();
  }
  return text.trim();
}

function extractLeadingStatusCode(text: string): { statusCode?: number; rest: string } {
  const match = text.match(/^(\d{3})\s+([\s\S]*)$/);
  if (!match?.[1]) {
    return { rest: text.trim() };
  }
  return {
    statusCode: Number.parseInt(match[1], 10),
    rest: match[2]?.trim() ?? "",
  };
}

function extractJsonPayload(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

/** Parse SDK structured `error` attribute from stream/tool payloads. */
export function parseSdkApiErrorAttribute(raw: string, model?: string): ThreadApiErrorInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const withoutSse = stripSseArtifacts(trimmed);
  const { statusCode, rest } = extractLeadingStatusCode(withoutSse);
  const jsonText = extractJsonPayload(rest);

  let code: string | undefined;
  let rawMessage: string | undefined;
  let structured: Partial<ThreadApiErrorInfo> = {};

  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      const extracted = readErrorFromJson(parsed);
      code = extracted.code;
      rawMessage = extracted.message;
      structured = readStructuredApiErrorExtras(parsed);
    } catch {
      // ignore malformed JSON
    }
  }

  if (!rawMessage) {
    // The JSON payload carried no error fields, so this is not an API error
    // envelope and the text around it is the message. Falling back to the text
    // *after* the payload (as this used to) showed users mid-sentence fragments
    // for any internal error that embeds JSON — e.g. the history-target
    // conflict message, whose own JSON blobs sit in the middle of the sentence.
    const cleaned = stripSseArtifacts(rest || withoutSse);
    rawMessage = cleaned || undefined;
  }

  if (!statusCode && !code && !rawMessage) {
    return null;
  }

  const draft: ThreadApiErrorInfo = {
    message: rawMessage ?? "API 请求失败",
    ...(model && { model }),
    ...(statusCode !== undefined && { statusCode }),
    ...(code && { code }),
    ...structured,
  };
  return {
    ...draft,
    message: formatApiErrorUserMessage(draft),
  };
}

function readStructuredApiErrorExtras(value: unknown): Partial<ThreadApiErrorInfo> {
  if (!isRecord(value)) return {};
  const error = isRecord(value.error) ? value.error : undefined;
  const response = isRecord(value.response) ? value.response : undefined;
  const responseError = response && isRecord(response.error) ? response.error : undefined;
  const source = error ?? responseError ?? value;
  const additionalDetails =
    typeof source.additionalDetails === "string" && source.additionalDetails.trim()
      ? source.additionalDetails
      : undefined;
  const param =
    typeof source.param === "string" && source.param.trim()
      ? source.param.trim()
      : typeof value.param === "string" && value.param.trim()
        ? value.param.trim()
        : undefined;
  return {
    ...(source.codexErrorInfo !== undefined
      ? { codexErrorInfo: source.codexErrorInfo }
      : {}),
    ...(additionalDetails ? { additionalDetails } : {}),
    ...(isRecord(value.turn) && isRecord(value.turn.error)
      ? { rawTurnError: value.turn.error }
      : {}),
    ...(param ? { param } : {}),
    ...readOptionalStructuredString(source, "logicalRequestId"),
    ...readOptionalStructuredString(source, "providerRequestId"),
    ...readOptionalStructuredString(source, "responseId"),
    ...readOptionalStructuredString(source, "accountId"),
    ...readOptionalStructuredString(source, "threadId"),
    ...readOptionalStructuredString(source, "turnId"),
    ...readOptionalStructuredString(source, "runAttemptId"),
  };
}

function readOptionalStructuredString(
  source: Record<string, unknown>,
  key:
    | "logicalRequestId"
    | "providerRequestId"
    | "responseId"
    | "accountId"
    | "threadId"
    | "turnId"
    | "runAttemptId",
): Partial<ThreadApiErrorInfo> {
  const value = source[key];
  return typeof value === "string" && value.trim() ? { [key]: value.trim() } : {};
}

export function formatApiErrorUserMessage(info: ThreadApiErrorInfo): string {
  const code = info.code?.toLowerCase();
  const status = info.statusCode;
  const normalized = info.message.toLowerCase();

  if (
    normalized.includes("unsupported input item type: agent_message") ||
    normalized.includes("unsupported content part type: encrypted_content")
  ) {
    return "当前 Provider 不支持 Codex 子代理的加密 agent_message；请改用 PI/Claude 或支持 Codex Multi-Agent 的 Responses Provider。";
  }

  if (code === "upstream_error" || (status === 502 && !info.message)) {
    return "上游模型服务暂时不可用，请稍后重试或切换 Provider。";
  }
  if (code === "model_not_found") {
    return "模型不存在或无权访问，请检查 Provider 配置与模型 ID。";
  }
  if (code === "subscription_sharing_usage_limit_exceeded") {
    return "该账号的 ChatGPT 订阅用量受限，本轮已停止";
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return "上游模型请求过于频繁，请稍后重试或切换 Provider。";
  }
  if (
    status === 529 ||
    code === "overloaded_error" ||
    code === "overloaded" ||
    info.message.toLowerCase().includes("overloaded")
  ) {
    return "上游模型过载，请稍后重试或切换 Provider。";
  }
  if (status === 503 || status === 504) {
    return "上游模型服务暂时不可用，请稍后重试。";
  }
  if (status === 401 || status === 403) {
    return "上游模型 API 认证失败，请检查 API Key 与 Provider 配置。";
  }

  const raw = info.message.trim();
  if (!raw || raw === "API 请求失败") {
    if (status) {
      return `上游模型请求失败（HTTP ${status}）。`;
    }
    return "上游模型请求失败，请稍后重试。";
  }

  const normalizedRaw = raw.toLowerCase();
  if (normalizedRaw.includes("upstream request failed")) {
    return "上游模型服务暂时不可用，请稍后重试或切换 Provider。";
  }
  if (normalizedRaw.includes("model not found")) {
    return "模型不存在或无权访问，请检查 Provider 配置与模型 ID。";
  }
  if (normalizedRaw.includes("rate limit") || normalizedRaw.includes("too many requests")) {
    return "上游模型请求过于频繁，请稍后重试或切换 Provider。";
  }

  return raw;
}

export function formatApiErrorActivitySummary(info: ThreadApiErrorInfo): string {
  if (info.statusCode !== undefined) {
    return `API error · ${info.statusCode} · ${info.message}`;
  }
  return `API error · ${info.message}`;
}

export function apiErrorDedupeKey(info: ThreadApiErrorInfo): string {
  return [info.model ?? "", info.statusCode ?? "", info.code ?? "", info.message].join("|");
}

/** Best-effort parse for legacy persisted lines that only stored raw SDK error text. */
export function parseLegacyApiErrorActivityMessage(message: string): ThreadApiErrorInfo | null {
  const trimmed = message.trim();
  const prefixMatch = trimmed.match(/^API error(?:\s*\(([^)]+)\))?\s*[:·]\s*/i);
  if (!prefixMatch) {
    return null;
  }
  const model = prefixMatch[1]?.trim();
  const payload = trimmed.slice(prefixMatch[0].length).trim();
  const cleanPrefix = payload.match(/^(\d{3})\s*·\s*(.+)$/);
  if (cleanPrefix?.[1] && cleanPrefix[2]) {
    return {
      statusCode: Number.parseInt(cleanPrefix[1], 10),
      message: cleanPrefix[2].trim(),
      ...(model && { model }),
    };
  }
  return parseSdkApiErrorAttribute(payload, model);
}
