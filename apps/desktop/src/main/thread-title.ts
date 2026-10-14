import {
  canRegenerateThreadTitle,
  coreOwnsSessionTitle,
  isPendingThreadTitle,
  LEGACY_PENDING_THREAD_TITLES,
  PENDING_THREAD_TITLE_EN,
  PENDING_THREAD_TITLE_ZH,
  pendingThreadTitles,
} from "../shared/thread-title-pending";
import type { AnthropicProxyRoute } from "./anthropic-proxy";
import { postAuxiliaryBridgeRequest, resolveRouteApiCompat } from "./bridge-auxiliary-request";
import { logUpstreamError } from "./upstream-log";

export {
  canRegenerateThreadTitle,
  coreOwnsSessionTitle,
  isPendingThreadTitle,
  LEGACY_PENDING_THREAD_TITLES,
  PENDING_THREAD_TITLE_EN,
  PENDING_THREAD_TITLE_ZH,
  pendingThreadTitles,
};

const ANTHROPIC_STRUCTURED_OUTPUTS_BETA = "structured-outputs-2025-11-13";
const TITLE_TIMEOUT_MS = 90_000;
export const TITLE_PROMPT_MAX_CHARS = 8_000;
export const TITLE_OUTPUT_MAX_CHARS = 42;
/** @deprecated Prefer resolvePendingThreadTitle(locale). */
export const pendingThreadTitle = PENDING_THREAD_TITLE_ZH;

export function resolvePendingThreadTitle(locale: string): string {
  return locale.trim().toLowerCase().startsWith("zh") ? PENDING_THREAD_TITLE_ZH : PENDING_THREAD_TITLE_EN;
}

export function resolveFailedThreadTitle(prompt: string, locale: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ")
    .trim();
  if (!firstLine) {
    return resolvePendingThreadTitle(locale);
  }
  return firstLine.length > TITLE_OUTPUT_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_OUTPUT_MAX_CHARS - 3)}...`
    : firstLine;
}

const THREAD_TITLE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

const THREAD_TITLE_SYSTEM_PROMPT = [
  '你是会话标题生成器。根据用户任务概括意图，只输出 JSON：{"title":"..."}。',
  "中文不超过 18 个字，英文 3-7 个词，sentence case。",
  `标题总长度不超过 ${TITLE_OUTPUT_MAX_CHARS} 个字符。`,
  "使用与用户消息相同的语言。",
  "不要解释、不要引号包裹 JSON、不要 markdown、不要照抄用户原文。",
  "不要输出拒绝、道歉或能力限制类语句。",
  "不要输出思考过程，只输出 JSON。",
].join(" ");

type Fetcher = typeof fetch;

/** Reject model refusals / internal capability messages (Codex #11396 class of bugs). */
const TITLE_REFUSAL_PATTERN =
  /(?:对不起|抱歉|无法|不能|只能生成|I\s*(?:can't|cannot)|I\s*am\s*unable|unable\s+to)/i;

/** Reject runtime status text accidentally returned by a shared auxiliary route. */
const TITLE_OPERATIONAL_FAILURE_PATTERN =
  /(?:(?:辅助模型|审批模型)[^\n]{0,24}(?:审批)?(?:失败|不可用)|(?:会话)?标题(?:生成)?失败|自动审批[^\n]{0,24}失败|review_failed_closed|auxiliary model[^\n]{0,24}(?:failed|unavailable)|approval[^\n]{0,24}(?:failed|error))/i;

/** Reject structured-artifact garbage sometimes appended to titles (Codex #17627). */
const TITLE_GARBAGE_SUFFIX_PATTERN = /[\]})'"]{3,}$/;

function truncateTitlePrompt(prompt: string): { text: string; truncated: boolean } {
  const trimmed = prompt.trim();
  if (trimmed.length <= TITLE_PROMPT_MAX_CHARS) {
    return { text: trimmed, truncated: false };
  }
  return { text: trimmed.slice(0, TITLE_PROMPT_MAX_CHARS), truncated: true };
}

export function buildThreadTitleUserMessage(prompt: string): string {
  const { text, truncated } = truncateTitlePrompt(prompt);
  const parts = [
    "请为下面的编码任务或问题生成一个简短的概括性标题。",
    "中文不超过 18 个字，英文 3-7 个词。",
    `标题总长度不超过 ${TITLE_OUTPUT_MAX_CHARS} 个字符。`,
    '只返回 JSON：{"title":"..."}。',
    "",
    text,
  ];
  if (truncated) {
    parts.push("", "（任务内容已在上方截断）");
  }
  return parts.join("\n");
}

export function buildThreadTitleRequestBody(
  titleRoute: AnthropicProxyRoute,
  prompt: string,
  useStructuredOutput: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: titleRoute.modelId,
    temperature: 0,
    thinking: { type: "disabled" },
    system: THREAD_TITLE_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildThreadTitleUserMessage(prompt),
      },
    ],
  };
  if (titleRoute.maxOutputTokens !== undefined && titleRoute.maxOutputTokens > 0) {
    body.max_tokens = titleRoute.maxOutputTokens;
  }
  if (useStructuredOutput) {
    body.output_format = {
      type: "json_schema",
      schema: THREAD_TITLE_JSON_SCHEMA,
    };
  }
  return body;
}

export function resolveThreadTitleRoute(
  routes: readonly AnthropicProxyRoute[],
): AnthropicProxyRoute | undefined {
  return routes.find((entry) => entry.role === "auxiliary");
}

export function parseThreadTitleJson(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }

  const candidates = [...new Set([trimmed, ...extractJsonObjectCandidates(trimmed)])];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed) && typeof parsed.title === "string") {
        const title = parsed.title.trim();
        if (title) {
          return title;
        }
      }
    } catch {
      // try next candidate
    }
  }

  return undefined;
}

export async function summarizeThreadTitle(
  routes: readonly AnthropicProxyRoute[],
  prompt: string,
  fetcher: Fetcher = fetch,
  onTitleDelta?: (preview: string) => void,
): Promise<string | undefined> {
  const titleRoute = resolveThreadTitleRoute(routes);
  if (!titleRoute) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  try {
    const structured = await requestThreadTitle(
      titleRoute,
      prompt,
      fetcher,
      controller.signal,
      true,
      onTitleDelta,
    );
    if (structured !== undefined) {
      return structured;
    }
    return requestThreadTitle(titleRoute, prompt, fetcher, controller.signal, false, onTitleDelta);
  } catch (error) {
    logUpstreamError("thread-title-fetch-error", {
      role: titleRoute.role,
      provider: titleRoute.provider.name,
      modelId: titleRoute.modelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

/** @deprecated Use summarizeThreadTitle. */
export const summarizeThreadTitleWithCoder = summarizeThreadTitle;

export function sanitizeThreadTitle(title: string | undefined, prompt: string): string | undefined {
  const cleaned = (title ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^标题\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return undefined;
  }

  if (
    TITLE_REFUSAL_PATTERN.test(cleaned) ||
    TITLE_OPERATIONAL_FAILURE_PATTERN.test(cleaned) ||
    TITLE_GARBAGE_SUFFIX_PATTERN.test(cleaned)
  ) {
    return undefined;
  }

  if (normalizeTitle(cleaned) === normalizeTitle(prompt)) {
    return undefined;
  }

  if (isPendingThreadTitle(cleaned)) {
    return undefined;
  }

  return cleaned.length > TITLE_OUTPUT_MAX_CHARS
    ? `${cleaned.slice(0, TITLE_OUTPUT_MAX_CHARS - 3)}...`
    : cleaned;
}

export function shouldReplaceAutoThreadTitle(currentTitle: string): boolean {
  return canRegenerateThreadTitle(currentTitle, false);
}

/** Collapse whitespace and cap length. Empty / non-string → undefined. */
export function normalizeAcpSessionTitle(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.length > TITLE_OUTPUT_MAX_CHARS
    ? `${cleaned.slice(0, TITLE_OUTPUT_MAX_CHARS - 3)}...`
    : cleaned;
}

/** Best-effort title preview while JSON is still streaming. */
export function previewThreadTitleFromStream(text: string | undefined): string | undefined {
  const fromJson = parseThreadTitleJson(text);
  if (fromJson) {
    return TITLE_OPERATIONAL_FAILURE_PATTERN.test(fromJson) ? undefined : fromJson;
  }

  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }

  const partialMatch = trimmed.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (partialMatch?.[1]) {
    const partial = partialMatch[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
    if (partial) {
      return partial.length > TITLE_OUTPUT_MAX_CHARS
        ? `${partial.slice(0, TITLE_OUTPUT_MAX_CHARS - 3)}...`
        : partial;
    }
  }

  return undefined;
}

async function requestThreadTitle(
  titleRoute: AnthropicProxyRoute,
  prompt: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  useStructuredOutput: boolean,
  onTitleDelta?: (preview: string) => void,
): Promise<string | undefined> {
  const tryStructuredOutput = useStructuredOutput && resolveRouteApiCompat(titleRoute) === "anthropic";
  let lastPreview = "";
  const result = await postAuxiliaryBridgeRequest({
    route: titleRoute,
    anthropicBody: buildThreadTitleRequestBody(titleRoute, prompt, tryStructuredOutput),
    signal,
    ...(tryStructuredOutput && {
      anthropicExtraHeaders: { "anthropic-beta": ANTHROPIC_STRUCTURED_OUTPUTS_BETA },
    }),
    logEventPrefix: "thread-title",
    fetcher,
    ...(onTitleDelta && {
      onTextDelta: (_delta, text) => {
        const preview = previewThreadTitleFromStream(text);
        if (!preview || preview === lastPreview) {
          return;
        }
        lastPreview = preview;
        onTitleDelta(preview);
      },
    }),
  });

  if (!result.ok) {
    return undefined;
  }

  const rawTitle = parseThreadTitleJson(result.text);
  const sanitized = sanitizeThreadTitle(rawTitle, prompt);
  if (!sanitized) {
    logUpstreamError("thread-title-invalid", {
      role: titleRoute.role,
      provider: titleRoute.provider.name,
      modelId: titleRoute.modelId,
      structuredOutput: tryStructuredOutput,
      reason: !result.text?.trim()
        ? "empty-extracted-text"
        : TITLE_REFUSAL_PATTERN.test((rawTitle ?? "").split("\n")[0] ?? "")
          ? "refusal-pattern"
          : "empty-after-sanitize",
      extractedText: result.text,
      rawTitle,
    });
  }
  return sanitized;
}

/** Recover title JSON when upstream ignores thinking:disabled and only emits thinking blocks. */
export function extractTitleJsonFromThinking(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    return undefined;
  }

  const chunks: string[] = [];
  for (const block of body.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      chunks.push(block.thinking);
      continue;
    }
    if (block.type === "redacted_thinking") {
    }
  }
  const joined = chunks.join("\n").trim();
  return joined ? joined : undefined;
}

export function extractTitleText(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    return undefined;
  }

  const chunks: string[] = [];
  for (const block of body.content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      chunks.push(block.text);
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
    }
  }
  return chunks.join("\n").trim() || undefined;
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (start < 0) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
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
    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      candidates.push(text.slice(start, index + 1));
      start = -1;
    }
  }

  return candidates;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
