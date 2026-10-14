/** Upstream API surface used for chat and connection tests. */
export type ChatApiCompat = "anthropic" | "openai_responses" | "openai_chat_completions";
export type UpstreamApiCompat = ChatApiCompat | "system_one";

export const API_COMPAT_THEME: Record<UpstreamApiCompat, { label: string; color: string }> = {
  system_one: { label: "SystemOne", color: "#7c3aed" },
  anthropic: {
    label: "Anthropic",
    color: "#cc785c",
  },
  openai_responses: {
    label: "OpenAI Responses",
    color: "#10a37f",
  },
  openai_chat_completions: {
    label: "OpenAI Chat",
    color: "#0d7ae8",
  },
};

export const UPSTREAM_API_COMPAT_CYCLE: UpstreamApiCompat[] = [
  "anthropic",
  "openai_responses",
  "openai_chat_completions",
  "system_one",
];

export function isOpenAICompat(apiCompat: UpstreamApiCompat): boolean {
  return apiCompat === "openai_responses" || apiCompat === "openai_chat_completions";
}

export function requestPathPlaceholderForApiCompat(apiCompat: UpstreamApiCompat): string {
  switch (apiCompat) {
    case "system_one":
      return "/";
    case "openai_responses":
      return "/openai";
    case "openai_chat_completions":
      return "/";
    case "anthropic":
    default:
      return "/anthropic";
  }
}

export function toggleUpstreamApiCompat(value: UpstreamApiCompat): UpstreamApiCompat {
  const index = UPSTREAM_API_COMPAT_CYCLE.indexOf(value);
  const next = index < 0 ? 0 : (index + 1) % UPSTREAM_API_COMPAT_CYCLE.length;
  return UPSTREAM_API_COMPAT_CYCLE[next] ?? "anthropic";
}

export const UPSTREAM_API_COMPAT_OPTIONS: Array<{
  value: UpstreamApiCompat;
  label: string;
  hint: string;
}> = [
  { value: "system_one", label: "SystemOne", hint: "POST …/v1/systemone（Jev 等决策模型，仅用于审批）" },
  {
    value: "anthropic",
    label: "Anthropic Messages",
    hint: "POST …/v1/messages（Anthropic 协议）",
  },
  {
    value: "openai_responses",
    label: "OpenAI Responses",
    hint: "POST …/v1/responses（Responses 枢纽，Codex / 官方 OpenAI 推荐）",
  },
  {
    value: "openai_chat_completions",
    label: "OpenAI Chat Completions",
    hint: "POST …/v1/chat/completions（DeepSeek / Kimi 等兼容上游）",
  },
];

/** Legacy stored value `openai` maps to Responses. */
export function normalizeUpstreamApiCompat(value?: string | null): UpstreamApiCompat {
  if (value === "system_one") {
    return "system_one";
  }
  if (value === "openai" || value === "openai_responses") {
    return "openai_responses";
  }
  if (value === "openai_chat_completions") {
    return "openai_chat_completions";
  }
  return "anthropic";
}

/** Path prefixes used only for Anthropic Messages (not OpenAI chat/responses). */
const MESSAGES_ONLY_REQUEST_PATHS = new Set(["/anthropic"]);

function normalizeRequestPathForCompat(path?: string): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

/** True when the provider path is Anthropic-messages-only (e.g. DeepSeek `/anthropic`). */
export function isMessagesOnlyRequestPath(path?: string): boolean {
  return MESSAGES_ONLY_REQUEST_PATHS.has(normalizeRequestPathForCompat(path));
}

/**
 * Resolve wire-protocol apiCompat for a route.
 * Route-level override wins when set; otherwise provider default.
 * Call `assertApiCompatCompatibleWithProviderPath` before issuing wire traffic —
 * do not silently rewrite OpenAI surfaces onto `/anthropic` hosts.
 */
export function resolveUpstreamApiCompat(
  routeCompat?: UpstreamApiCompat,
  providerCompat?: UpstreamApiCompat,
): ChatApiCompat {
  const resolved = normalizeUpstreamApiCompat(routeCompat ?? providerCompat);
  if (providerCompat === "system_one" || resolved === "system_one") {
    throw new Error("SystemOne 供应商仅可用于审批模型，不能用于聊天、辅助模型或视觉模型。");
  }
  return resolved;
}

/** User-facing misconfiguration (route OpenAI surface on Anthropic-only path). */
export class IncompatibleApiCompatError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "IncompatibleApiCompatError";
  }
}

export function formatMessagesOnlyPathOpenAiConflict(input: {
  apiCompat: UpstreamApiCompat;
  providerRequestPath?: string;
  providerId?: string;
  providerName?: string;
}): string {
  const path = normalizeRequestPathForCompat(input.providerRequestPath) || "/anthropic";
  const who =
    (input.providerName?.trim() && input.providerId?.trim()
      ? `${input.providerName.trim()} (${input.providerId.trim()})`
      : input.providerId?.trim() || input.providerName?.trim()) || "provider";
  const surface =
    input.apiCompat === "openai_responses"
      ? "OpenAI Responses (…/v1/responses)"
      : input.apiCompat === "openai_chat_completions"
        ? "OpenAI Chat Completions (…/v1/chat/completions)"
        : String(input.apiCompat);
  return (
    `API 协议与供应商路径不兼容：${who} 的 requestPath 为 ${path}（仅 Anthropic Messages），` +
    `不能使用 ${surface}。请将主代理/路由的 API 兼容模式改为 Anthropic Messages，` +
    `或改用支持 OpenAI 端点且未占用 /anthropic 路径的供应商。不会静默去掉 ${path} 以免请求打到错误上游。`
  );
}

/**
 * Reject OpenAI wire protocols on Anthropic-only request paths.
 * Prefer hard failure over stripping `/anthropic` or rewriting to Messages.
 */
export function assertApiCompatCompatibleWithProviderPath(input: {
  apiCompat: UpstreamApiCompat;
  providerRequestPath?: string;
  providerId?: string;
  providerName?: string;
}): void {
  if (!isOpenAICompat(input.apiCompat)) {
    return;
  }
  if (!isMessagesOnlyRequestPath(input.providerRequestPath)) {
    return;
  }
  throw new IncompatibleApiCompatError(formatMessagesOnlyPathOpenAiConflict(input));
}
