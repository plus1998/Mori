import type { AnthropicProxyRoute } from "./anthropic-proxy";
import { postAuxiliaryBridgeRequest } from "./bridge-auxiliary-request";
import type { StatelessModelPrompt } from "./bridge-auxiliary-request";
import type { CommitDiffContext } from "./git-operations";
import { logUpstreamError } from "./upstream-log";

const COMMIT_MESSAGE_TIMEOUT_MS = 90_000;
const COMMIT_MESSAGE_MAX_CHARS = 2_000;

const COMMIT_REFUSAL_PATTERN = /(?:对不起|抱歉|无法|不能|I\s*(?:can't|cannot)|I\s*am\s*unable|unable\s+to)/i;

type Fetcher = typeof fetch;

export function buildCommitMessageUserMessage(context: CommitDiffContext, instructions?: string): string {
  const trimmedInstructions = instructions?.trim();
  const parts = [
    "请根据以下 Git 变更生成一条提交信息。",
    "使用 Conventional Commits 风格：type(scope): subject，必要时附 2-4 条简短 bullet body。",
    `提交信息总长度不超过 ${COMMIT_MESSAGE_MAX_CHARS} 个字符。`,
    "只输出最终 commit message 正文，不要引号、不要 markdown 代码块、不要解释。",
    ...(trimmedInstructions ? ["", "## 提交指令", trimmedInstructions] : []),
    "",
    "## Staged files",
    context.stagedNameStatus || "(empty)",
    "",
    "## Staged stat",
    context.stagedStat || "(empty)",
    "",
    "## Staged patch",
    context.stagedPatch || "(empty)",
  ];
  if (context.stagedPatchTruncated) {
    parts.push("", "（staged patch 已在上方截断）");
  }
  if (context.unstagedNameStatus) {
    parts.push("", "## Unstaged files", context.unstagedNameStatus);
  }
  if (context.unstagedPatch) {
    parts.push("", "## Unstaged patch", context.unstagedPatch);
    if (context.unstagedPatchTruncated) {
      parts.push("", "（unstaged patch 已在上方截断）");
    }
  }
  if (context.recentCommits) {
    parts.push("", "## Recent commits (style reference)", context.recentCommits);
  }
  return parts.join("\n");
}

export function buildCommitMessageRequestBody(
  route: AnthropicProxyRoute,
  context: CommitDiffContext,
  instructions?: string,
): StatelessModelPrompt {
  const trimmedInstructions = instructions?.trim();
  const systemParts = [
    "你是 Git 提交信息生成器。",
    "根据 diff 概括变更意图，遵循 Conventional Commits。",
    "第一行是简短 subject；如需 body，用空行分隔后用 - 开头的 bullet。",
    `提交信息总长度不超过 ${COMMIT_MESSAGE_MAX_CHARS} 个字符。`,
    "不要输出拒绝、道歉或能力限制类语句。",
    "不要输出思考过程，只输出 commit message 正文。",
    ...(trimmedInstructions ? [`遵循以下用户提交指令：${trimmedInstructions}`] : []),
  ];
  const body: StatelessModelPrompt = {
    temperature: 0,
    disableThinking: true,
    system: systemParts.join(" "),
    messages: [
      {
        role: "user",
        content: buildCommitMessageUserMessage(context, instructions),
      },
    ],
  };
  if (route.maxOutputTokens !== undefined && route.maxOutputTokens > 0) {
    body.maxTokens = route.maxOutputTokens;
  }
  return body;
}

export async function summarizeCommitMessage(
  route: AnthropicProxyRoute,
  context: CommitDiffContext,
  fetcher: Fetcher = fetch,
  instructions?: string,
  onTextDelta?: (text: string) => void,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMIT_MESSAGE_TIMEOUT_MS);
  try {
    const result = await postAuxiliaryBridgeRequest({
      route,
      prompt: buildCommitMessageRequestBody(route, context, instructions),
      signal: controller.signal,
      logEventPrefix: "git-commit-message",
      fetcher,
      ...(onTextDelta && {
        onTextDelta: (_delta, text) => {
          onTextDelta(text);
        },
      }),
    });
    if (!result.ok) {
      return undefined;
    }
    const sanitized = sanitizeCommitMessage(result.text);
    if (!sanitized?.trim()) {
      logUpstreamError("git-commit-message-invalid", {
        role: route.role,
        provider: route.provider.name,
        modelId: route.modelId,
        reason: !result.text?.trim()
          ? "empty-extracted-text"
          : COMMIT_REFUSAL_PATTERN.test((result.text ?? "").split("\n")[0] ?? "")
            ? "refusal-pattern"
            : "empty-after-sanitize",
        extractedText: result.text,
      });
    }
    return sanitized;
  } catch (error) {
    logUpstreamError("git-commit-message-fetch-error", {
      role: route.role,
      provider: route.provider.name,
      modelId: route.modelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export function sanitizeCommitMessage(message: string | undefined): string | undefined {
  const normalized = (message ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (COMMIT_REFUSAL_PATTERN.test(normalized.split("\n")[0] ?? "")) {
    return undefined;
  }
  if (normalized.length > COMMIT_MESSAGE_MAX_CHARS) {
    return normalized.slice(0, COMMIT_MESSAGE_MAX_CHARS);
  }
  return normalized;
}

export function extractCommitMessageText(body: unknown): string | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
