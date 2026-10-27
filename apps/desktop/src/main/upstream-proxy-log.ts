import fs from "node:fs";
import path from "node:path";
import { formatCostUsd, formatTokenCount, type ParsedUsage } from "@eco/runtime";
import { API_COMPAT_THEME, type UpstreamApiCompat } from "../shared/api-compat";
import { getUpstreamLogFilePath, parseJsonForLog, truncateForLog } from "./upstream-log";

const UPSTREAM_LOG_PREFIX = "[eco-upstream]";
const PROXY_CALL_PHASE = "proxy-call";

interface CountTokensBurstBucket {
  role: string;
  count: number;
  tokenValues: number[];
}

let countTokensBurstBuckets = new Map<string, CountTokensBurstBucket>();
let countTokensFlushTimer: ReturnType<typeof setTimeout> | undefined;

const COUNT_TOKENS_FLUSH_MS = 400;

export interface UpstreamProxyProtocolSummary {
  client: "anthropic-messages";
  upstream: UpstreamApiCompat;
  converted: boolean;
  path: string;
}

export interface UpstreamProxyCallTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface UpstreamProxyCallBilling {
  ecoCostUsd: number;
  plannerTokenCostUsd: number;
  savedUsd: number;
  sourceReportedCostUsd: number;
}

export type UpstreamProxyOperation = "messages" | "count_tokens" | "other";

export interface UpstreamProxyCallLog {
  at: string;
  ok: boolean;
  elapsedMs: number;
  role: string;
  provider: { id: string; name: string };
  model: { sdk?: string; upstream: string; alias: string };
  operation: UpstreamProxyOperation;
  clientPath: string;
  upstreamUrl: string;
  protocol: UpstreamProxyProtocolSummary;
  http: { status: number; streaming: boolean };
  tokens?: UpstreamProxyCallTokens;
  billing?: UpstreamProxyCallBilling | null;
  error?: string | null;
  debug?: {
    /** SDK → local proxy (Anthropic shape). */
    clientRequest?: unknown;
    /** Wire payload sent to provider (may differ after conversion). */
    upstreamRequest?: unknown;
    responseBody?: unknown;
  };
}

export function resolveProxyOperation(requestUrl: string | undefined): UpstreamProxyOperation {
  const path = requestUrl?.split("?")[0] ?? "";
  if (path.includes("/count_tokens")) {
    return "count_tokens";
  }
  if (path === "/v1/messages" || path.endsWith("/v1/messages")) {
    return "messages";
  }
  return "other";
}

export function normalizeClientPath(requestUrl: string | undefined): string {
  const path = requestUrl?.split("?")[0] ?? "/";
  return path || "/";
}

export function operationLabel(operation: UpstreamProxyOperation): string {
  switch (operation) {
    case "count_tokens":
      return "计 Token（/v1/messages/count_tokens）";
    case "messages":
      return "对话（/v1/messages）";
    default:
      return "其他";
  }
}

export function buildProtocolSummaryForCall(input: {
  apiCompat: UpstreamApiCompat;
  stream: boolean;
  operation: UpstreamProxyOperation;
  /** Whether the proxy transformed the body before upstream fetch. */
  converted: boolean;
}): UpstreamProxyProtocolSummary {
  if (input.operation === "count_tokens") {
    if (input.apiCompat === "anthropic") {
      return {
        client: "anthropic-messages",
        upstream: "anthropic",
        converted: false,
        path: "anthropic → anthropic-count → anthropic-json",
      };
    }
    if (input.converted) {
      return {
        client: "anthropic-messages",
        upstream: "openai_responses",
        converted: true,
        path: "anthropic → responses-ir → openai-responses/input_tokens → anthropic-json",
      };
    }
  }
  return buildProtocolSummary(input.apiCompat, input.stream);
}

export function buildProxyCallDebug(input: {
  converted: boolean;
  clientRequestRaw?: string;
  upstreamRequestRaw?: string;
  responseRaw?: string;
}): UpstreamProxyCallLog["debug"] | undefined {
  const clientRequest =
    input.clientRequestRaw !== undefined ? parseJsonForLog(input.clientRequestRaw) : undefined;
  const upstreamRequest =
    input.upstreamRequestRaw !== undefined ? parseJsonForLog(input.upstreamRequestRaw) : undefined;
  const responseBody = input.responseRaw !== undefined ? debugBodyFromRaw(input.responseRaw) : undefined;

  if (clientRequest === undefined && upstreamRequest === undefined && responseBody === undefined) {
    return undefined;
  }

  const debug: NonNullable<UpstreamProxyCallLog["debug"]> = {};
  if (input.converted && clientRequest !== undefined) {
    debug.clientRequest = clientRequest;
  }
  if (upstreamRequest !== undefined) {
    debug.upstreamRequest = upstreamRequest;
  } else if (!input.converted && clientRequest !== undefined) {
    debug.upstreamRequest = clientRequest;
  }
  if (responseBody !== undefined) {
    debug.responseBody = responseBody;
  }
  return debug;
}

export function isUpstreamLogVerbose(): boolean {
  const value = process.env.ECO_UPSTREAM_LOG_VERBOSE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function buildProtocolSummary(
  apiCompat: UpstreamApiCompat,
  stream: boolean,
): UpstreamProxyProtocolSummary {
  const delivery = stream ? "anthropic-sse" : "anthropic-json";
  if (apiCompat === "anthropic") {
    return {
      client: "anthropic-messages",
      upstream: "anthropic",
      converted: false,
      path: `anthropic → anthropic → ${delivery}`,
    };
  }
  if (apiCompat === "openai_responses") {
    return {
      client: "anthropic-messages",
      upstream: "openai_responses",
      converted: true,
      path: `anthropic → openai-responses → ${delivery}`,
    };
  }
  return {
    client: "anthropic-messages",
    upstream: "openai_chat_completions",
    converted: true,
    path: `anthropic → openai-chat-completions → ${delivery}`,
  };
}

export function proxyCallCommonFields(input: {
  role: string;
  provider: { id: string; name: string };
  apiCompat: UpstreamApiCompat;
  modelId: string;
  aliasModelId: string;
  requestedModel?: string;
  requestUrl?: string;
  upstreamUrl: string;
  stream: boolean;
  converted: boolean;
}): Pick<
  UpstreamProxyCallLog,
  "role" | "provider" | "model" | "operation" | "clientPath" | "upstreamUrl" | "protocol"
> {
  const operation = resolveProxyOperation(input.requestUrl);
  return {
    role: input.role,
    provider: { id: input.provider.id, name: input.provider.name },
    model: {
      ...(input.requestedModel && { sdk: input.requestedModel }),
      upstream: input.modelId,
      alias: input.aliasModelId,
    },
    operation,
    clientPath: normalizeClientPath(input.requestUrl),
    upstreamUrl: input.upstreamUrl,
    protocol: buildProtocolSummaryForCall({
      apiCompat: input.apiCompat,
      stream: input.stream,
      operation,
      converted: input.converted,
    }),
  };
}

export function tokensFromUsage(usage: ParsedUsage): UpstreamProxyCallTokens {
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheCreation: usage.cacheCreationTokens,
  };
}

export function formatUpstreamProxyCallLog(summary: UpstreamProxyCallLog): string {
  const lines: string[] = [];
  const statusLabel = summary.ok ? "成功" : "失败";
  lines.push(
    `${UPSTREAM_LOG_PREFIX} ${PROXY_CALL_PHASE} ${statusLabel} ${formatElapsed(summary.elapsedMs)} · ${formatLogTimestamp(summary.at)}`,
  );

  lines.push(`  角色 ${summary.role} · 提供商 ${summary.provider.name}`);

  const modelParts = [`上游 ${summary.model.upstream}`];
  if (summary.model.sdk && summary.model.sdk !== summary.model.upstream) {
    modelParts.unshift(`SDK ${summary.model.sdk}`);
  }
  if (summary.model.alias !== summary.model.upstream && summary.model.alias !== summary.model.sdk) {
    modelParts.push(`别名 ${summary.model.alias}`);
  }
  lines.push(`  模型 ${modelParts.join(" → ")}`);
  lines.push(`  类型 ${operationLabel(summary.operation)}`);
  lines.push(`  地址 SDK ${summary.clientPath} → 上游 ${summary.upstreamUrl}`);
  lines.push(`  协议 ${summary.protocol.path}`);

  const httpParts = [
    summary.http.status > 0 ? `HTTP ${summary.http.status}` : "HTTP —",
    summary.http.streaming ? "流式" : "非流式",
  ];
  lines.push(`  ${httpParts.join(" · ")}`);

  if (summary.tokens) {
    lines.push(`  Token ${formatProxyCallTokens(summary.tokens)}`);
  }

  if (summary.billing) {
    const billingParts = [
      `Mori ${formatCostUsd(summary.billing.ecoCostUsd)}`,
      `规划等价 ${formatCostUsd(summary.billing.plannerTokenCostUsd)}`,
    ];
    if (summary.billing.savedUsd > 0) {
      billingParts.push(`节省 ${formatCostUsd(summary.billing.savedUsd)}`);
    }
    if (summary.billing.sourceReportedCostUsd > 0) {
      billingParts.push(`SDK 报告 ${formatCostUsd(summary.billing.sourceReportedCostUsd)}`);
    }
    lines.push(`  计费 ${billingParts.join(" · ")}`);
  } else if (summary.ok && summary.tokens) {
    lines.push("  计费 —（未绑定线程或无费率）");
  }

  if (summary.error) {
    lines.push(`  错误 ${summary.error}`);
  }

  if (summary.operation === "count_tokens" && !summary.ok) {
    lines.push(
      "  提示 计 Token 当前为 Anthropic 直通；若提供商为 OpenAI Responses/Chat 兼容，上游往往不支持此接口",
    );
  }

  if (summary.debug?.clientRequest !== undefined) {
    lines.push(...formatDebugSection("SDK 请求体（Anthropic）", summary.debug.clientRequest));
  }
  if (summary.debug?.upstreamRequest !== undefined) {
    lines.push(...formatDebugSection("实际上游请求体", summary.debug.upstreamRequest));
  }
  if (summary.debug?.responseBody !== undefined) {
    lines.push(...formatDebugSection("上游响应", summary.debug.responseBody));
  }

  return `${lines.join("\n")}\n`;
}

export function flushCountTokensProxyLogBurst(): void {
  if (countTokensFlushTimer) {
    clearTimeout(countTokensFlushTimer);
    countTokensFlushTimer = undefined;
  }
  if (countTokensBurstBuckets.size === 0) {
    return;
  }
  const buckets = countTokensBurstBuckets;
  countTokensBurstBuckets = new Map();
  for (const bucket of buckets.values()) {
    const unique = [...new Set(bucket.tokenValues)];
    const tokenLabel =
      unique.length === 1
        ? formatTokenCount(unique[0]!)
        : `${formatTokenCount(Math.min(...bucket.tokenValues))}–${formatTokenCount(Math.max(...bucket.tokenValues))}`;
    const line = `${UPSTREAM_LOG_PREFIX} count_tokens-stub ×${bucket.count} role=${bucket.role} tokens=${tokenLabel}\n`;
    process.stderr.write(line);
    appendProxyLogFile(line);
  }
}

function noteCountTokensProxyCall(summary: UpstreamProxyCallLog): void {
  const role = summary.role;
  const tokens = summary.tokens?.input ?? 0;
  const bucket = countTokensBurstBuckets.get(role) ?? { role, count: 0, tokenValues: [] };
  bucket.count += 1;
  bucket.tokenValues.push(tokens);
  countTokensBurstBuckets.set(role, bucket);
  if (countTokensFlushTimer) {
    clearTimeout(countTokensFlushTimer);
  }
  countTokensFlushTimer = setTimeout(() => {
    countTokensFlushTimer = undefined;
    flushCountTokensProxyLogBurst();
  }, COUNT_TOKENS_FLUSH_MS);
}

export function logUpstreamProxyCall(summary: UpstreamProxyCallLog): void {
  if (summary.operation === "count_tokens" && !isUpstreamLogVerbose()) {
    noteCountTokensProxyCall(summary);
    return;
  }
  if (summary.operation === "messages") {
    flushCountTokensProxyLogBurst();
  }
  const text = formatUpstreamProxyCallLog(summary);
  process.stderr.write(text);
  appendProxyLogFile(text);
}

function formatLogTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1000) {
    return `${elapsedMs}ms`;
  }
  if (elapsedMs < 60_000) {
    const seconds = elapsedMs / 1000;
    return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  const seconds = Math.round((elapsedMs % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatProxyCallTokens(tokens: UpstreamProxyCallTokens): string {
  const parts = [`输入 ${formatTokenCount(tokens.input)}`, `输出 ${formatTokenCount(tokens.output)}`];
  if (tokens.cacheRead > 0) {
    parts.push(`缓存读 ${formatTokenCount(tokens.cacheRead)}`);
  }
  if (tokens.cacheCreation > 0) {
    parts.push(`缓存写 ${formatTokenCount(tokens.cacheCreation)}`);
  }
  return parts.join(" · ");
}

function formatDebugSection(label: string, body: unknown): string[] {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  const indented = text.split("\n").map((line) => `    ${line}`);
  return [`  ${label}:`, ...indented];
}

export function debugBodyFromRaw(raw: string): unknown {
  return parseJsonForLog(raw) ?? truncateForLog(raw);
}

function appendProxyLogFile(line: string): void {
  try {
    const filePath = getUpstreamLogFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${UPSTREAM_LOG_PREFIX} log-file-error ${message}\n`);
  }
}

export async function resolveProxyCallBilling<T>(
  onUsage: ((info: T) => void | Promise<UpstreamProxyCallBilling | null | undefined>) | undefined,
  info: T,
): Promise<UpstreamProxyCallBilling | null> {
  if (!onUsage) {
    return null;
  }
  const result = await onUsage(info);
  return result ?? null;
}
