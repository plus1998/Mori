import type { ThreadSummary } from "../shared/ipc";
import type { ConversationV2Store } from "./conversation-v2-store";

const REDACTED = "[REDACTED]";
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip ANSI escapes before matching sensitive field names.
const TERMINAL_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Only error text crosses this boundary; never export provider envelopes, inputs or credentials. */
export function redactThreadError(value: string): { message: string; truncated: boolean } {
  const redacted = value
    .replace(TERMINAL_ESCAPE, "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:https?|wss?|socks5h?|file):\/\/[^\s<>"'`]+/gi, "[URL_REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(
      /(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(["']?(?:authorization|proxy-authorization|x-[\w-]*(?:key|secret|token)|mcp-session-id)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n,;}]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|token|session[_-]?id|client[_-]?secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, REDACTED)
    .replace(/(^|[\s("'=])(?:\/[\w.~-][^\s"'<>]*|[A-Za-z]:[\\/][^\s"'<>]+)/gm, "$1[PATH_REDACTED]")
    // Stack frames and escape sequences add no diagnostic facts and can carry local paths.
    .replace(/^\s*at\s+.*$/gm, "")
    .trim();
  return { message: redacted.slice(0, 2000), truncated: redacted.length > 2000 };
}

export function threadErrorDetail(text: string, source: "summary" | "notice" | "tool") {
  // Classify the sanitized text so credentials, URL paths and stack frames cannot influence the diagnosis.
  const safe = redactThreadError(text);
  const message = safe.message;
  const mcpSessionFailure = message
    .split("\n")
    .some(
      (line) =>
        /mcp[\s_-]*session/i.test(line) &&
        /missing|invalid|expired|not found|terminated|过期|无效|缺失|不存在/i.test(line),
    );
  const category = mcpSessionFailure
    ? "mcp_session"
    : /(?:fetch failed|econnrefused|econnreset|etimedout|socket hang up|【连接失败】|连接.*(?:模型|上游)|(?:模型|上游).*连接)/i.test(
          message,
        )
      ? source === "tool"
        ? "tool_connection"
        : "model_connection"
      : /(?:\b(?:401|403)\b|unauthorized|authentication|API Key.*(?:无效|错误)|鉴权|认证失败)/i.test(message)
        ? "authentication"
        : /(?:\b429\b|rate.?limit|quota|限流|配额)/i.test(message)
          ? "rate_limit"
          : /(?:配置|未启用|未开启|not configured|configuration)/i.test(message)
            ? "configuration"
            : "unknown";
  const status = message.match(
    /(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?["']?\s*[:=]?\s*)([45]\d{2})\b/i,
  )?.[1];
  const code = message.match(
    /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CERT_HAS_EXPIRED)\b/i,
  )?.[1];
  return {
    category,
    ...safe,
    ...(status ? { httpStatus: Number(status) } : {}),
    ...(code ? { code: code.toUpperCase() } : {}),
  };
}

export function currentThreadError(thread: Pick<ThreadSummary, "status" | "message">) {
  return thread.status === "failed" || thread.status === "blocked"
    ? thread.message.trim()
      ? threadErrorDetail(thread.message, "summary")
      : null
    : null;
}

/** Extract diagnostic text from tool output without serializing arbitrary output objects. */
function toolErrorText(raw: string | null): string | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const extract = (item: unknown, depth = 0): string | undefined => {
    if (depth > 6) return undefined;
    if (typeof item === "string") {
      // MCP text blocks sometimes contain a JSON error envelope. Apply the same field allowlist.
      try {
        const parsed: unknown = JSON.parse(item);
        if (parsed && typeof parsed === "object") return extract(parsed, depth + 1);
      } catch {
        /* Plain error text. */
      }
      return item;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.message === "string") return extract(record.message, depth + 1);
    if (typeof record.text === "string") return extract(record.text, depth + 1);
    if (record.error !== undefined) return extract(record.error, depth + 1);
    if (Array.isArray(record.content))
      return (
        record.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => extract(part.text, depth + 1))
          .filter(Boolean)
          .join("\n") || undefined
      );
    return undefined;
  };
  return extract(value);
}

/** Authorization belongs to the service's existing work-thread guard, before this function is called. */
export function readThreadErrors(thread: ThreadSummary, store: ConversationV2Store) {
  const facts = store.failureDetails(thread.id);
  return {
    threadId: thread.id,
    status: thread.status,
    currentError: currentThreadError(thread),
    currentErrorMissing:
      (thread.status === "failed" || thread.status === "blocked") && !thread.message.trim(),
    historyRevision: facts.historyRevision,
    readSeq: facts.readSeq,
    latestRun: facts.latestRun,
    recentErrors: facts.errors.map((row) => {
      const text = row.source === "tool" ? toolErrorText(row.text) : row.text;
      const detail = text ? threadErrorDetail(text, row.source) : null;
      return {
        id: row.id,
        source: row.source,
        runId: row.run_id,
        occurredAt: row.occurred_at,
        ...(row.tool_name ? { toolName: redactThreadError(row.tool_name).message.slice(0, 200) } : {}),
        detail: detail ? { ...detail, truncated: Boolean(row.truncated) || detail.truncated } : null,
        ...(!text ? { detailUnavailable: "未保存可公开的错误文本，或工具错误超过读取上限。" } : {}),
      };
    }),
    hasMore: facts.hasMore,
    scope: "recent_history; historical failures do not imply the current run failed",
  };
}
