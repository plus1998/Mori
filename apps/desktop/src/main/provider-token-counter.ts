import {
  buildUpstreamUrl,
  GATEWAY_PROVIDER_ID_HEADER,
  GATEWAY_UPSTREAM_KIND_HEADER,
  type GatewayConfig,
} from "@eco/gateway";
import {
  type AnthropicRequest,
  anthropicToResponses,
  responsesInputTokensToAnthropicCount,
  responsesToChatCompletionsRequest,
} from "@eco/openai-anthropic-bridge";
import type { UpstreamApiCompat } from "../shared/api-compat";
import { normalizeProviderTokenCountMode, type ProviderTokenCountMode } from "../shared/provider-token-count";
import { estimateAnthropicRequestTokens, estimateTextTokens } from "../shared/token-estimate";
import { stripSemanticCompactionDirectives } from "./bridge-upstream";
import { ensureGlobalEcoGateway, handleGlobalEcoGatewayRequest } from "./eco-gateway-lifecycle";
import {
  buildProviderRequestBaseUrl,
  buildResponsesInputTokensUrl,
  resolveRequestPathForApiCompat,
} from "./provider-models";
import type { ProviderConfigSecret } from "./provider-store";
import { buildProviderDirectUpstreamHeaders } from "./upstream-request-headers";

const DEFAULT_TOKEN_COUNT_TIMEOUT_MS = 30_000;

/** Dispatch-time counting uses the actual native body, never a lossy protocol round trip. */
export const countGatewayInputTokens: NonNullable<GatewayConfig["countInputTokens"]> = async (input) => {
  const { route, body } = input;
  const mode = normalizeProviderTokenCountMode(route.provider.tokenCountMode);
  if (mode === "local_heuristic") {
    if (body.previous_response_id || body.conversation) {
      throw new Error("本地估算无法读取服务端会话历史；动态输出需要 openai_responses 输入计数模式。");
    }
    const fields =
      route.upstreamKind === "anthropic-messages"
        ? ["system", "messages", "tools", "tool_choice", "thinking", "output_config", "cache_control"]
        : route.upstreamKind === "openai-chat"
          ? ["messages", "tools", "tool_choice", "functions", "function_call", "response_format"]
          : ["input", "instructions", "tools", "tool_choice", "text", "reasoning", "personality"];
    const countable = pickFields(body, fields);
    return {
      tokens: estimateTextTokens(JSON.stringify(countable)),
      precision: "heuristic",
      source: "eco:local_heuristic",
    };
  }

  const transport = {
    provider: route.provider,
    fetcher: input.fetcher,
    ...(input.signal && { signal: input.signal }),
    headers: input.headers,
  };
  if (mode === "anthropic_messages") {
    if (route.upstreamKind !== "anthropic-messages") {
      throw new Error(
        "anthropic_messages 精确计数需要 Messages 上游；不能用协议转换后的计数冒充原生请求输入。",
      );
    }
    const url = `${buildUpstreamUrl(route.provider, "anthropic-messages")}/count_tokens`;
    const raw = await postJsonForTokenCount(
      transport,
      url,
      pickFields(body, [
        "model",
        "system",
        "messages",
        "tools",
        "tool_choice",
        "thinking",
        "output_config",
        "cache_control",
      ]),
      "anthropic",
    );
    return {
      tokens: parseInputTokens(raw, "Anthropic count_tokens"),
      precision: "provider_exact",
      source: url,
    };
  }
  if (mode === "openai_responses") {
    if (route.upstreamKind !== "responses" && route.upstreamKind !== "gateway-delegated") {
      throw new Error(
        "openai_responses 精确计数需要 Responses 上游；不能用协议转换后的计数冒充原生请求输入。",
      );
    }
    const url = `${buildUpstreamUrl(route.provider, route.upstreamKind)}/input_tokens`;
    const raw = await postJsonForTokenCount(
      transport,
      url,
      pickResponsesInputTokenFields(body),
      "openai_responses",
    );
    return {
      tokens: parseInputTokens(raw, "Responses input_tokens"),
      precision: "provider_exact",
      source: url,
    };
  }
  if (route.upstreamKind !== "openai-chat") {
    throw new Error("llama_tokenize 动态输出计数需要原生 Chat Completions 上游。");
  }
  if (
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    (Array.isArray(body.functions) && body.functions.length > 0) ||
    body.response_format
  ) {
    throw new Error(
      "llama_tokenize 无法精确计入 tools/functions/response_format；请配置支持这些输入的服务端计数接口。",
    );
  }
  if (!Array.isArray(body.messages)) throw new Error("llama_tokenize 最终请求缺少 chat messages。");
  if (
    body.messages.some((message) => {
      if (!message || typeof message !== "object") return false;
      const content = (message as Record<string, unknown>).content;
      return (
        Array.isArray(content) &&
        content.some(
          (part) => part && typeof part === "object" && (part as Record<string, unknown>).type !== "text",
        )
      );
    })
  ) {
    throw new Error("llama_tokenize 无法通过文本模板精确计入图片、音频或文件输入。");
  }
  const url = buildUpstreamUrl(route.provider, "openai-chat").replace(
    /\/(?:v[^/]+\/)?chat\/completions$/,
    "",
  );
  const template = await postJsonForTokenCount(
    transport,
    `${url}/apply-template`,
    { messages: body.messages },
    "openai_chat_completions",
  );
  const tokenized = await postJsonForTokenCount(
    transport,
    `${url}/tokenize`,
    {
      content: readPrompt(template),
      add_special: false,
      parse_special: true,
      with_pieces: false,
    },
    "openai_chat_completions",
  );
  return {
    tokens: readTokenArray(tokenized).length,
    precision: "tokenizer_exact",
    source: `${url}/apply-template -> ${url}/tokenize`,
  };
};

function pickFields(body: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
}

export type ProviderTokenCountPrecision = "provider_exact" | "tokenizer_exact" | "heuristic";

export interface ProviderTokenCountResult {
  tokens: number;
  precision: ProviderTokenCountPrecision;
  source: string;
}

export interface CountProviderInputTokensRequest {
  mode: ProviderTokenCountMode;
  provider: ProviderConfigSecret;
  modelId: string;
  anthropicBody: Record<string, unknown>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  upstreamUserAgent?: string;
  timeoutMs?: number;
}

/**
 * Token counting product modes.
 * Per plan 4A: exact count via protocol conversion + Bridge is required for
 * anthropic_messages; other modes may use specialized provider endpoints.
 */
export async function countProviderInputTokens(
  input: CountProviderInputTokensRequest,
): Promise<ProviderTokenCountResult> {
  if (input.mode === "local_heuristic") {
    return {
      tokens: estimateAnthropicRequestTokens(input.anthropicBody),
      precision: "heuristic",
      source: "eco:local_heuristic",
    };
  }

  const request = normalizeAnthropicCountRequest(input.anthropicBody, input.modelId);
  switch (input.mode) {
    case "anthropic_messages":
      return countViaEcoBridgeAnthropic(input, request);
    case "openai_responses":
      return countViaOpenAIResponses(input, request);
    case "llama_tokenize":
      return countViaLlamaTokenizer(input, request);
    default:
      throw new Error(`无效的 Provider token 计数模式：${String(input.mode)}`);
  }
}

/** 4A exact Anthropic count: embedded Gateway count_tokens (not public Bridge, avoids Claude prep re-entry). */
async function countViaEcoBridgeAnthropic(
  input: CountProviderInputTokensRequest,
  request: AnthropicRequest,
): Promise<ProviderTokenCountResult> {
  const headers = new Headers({
    "content-type": "application/json",
    [GATEWAY_PROVIDER_ID_HEADER]: input.provider.id,
    [GATEWAY_UPSTREAM_KIND_HEADER]: "anthropic-messages",
  });
  if (input.upstreamUserAgent?.trim()) {
    headers.set("user-agent", input.upstreamUserAgent.trim());
  }

  // Optional custom fetcher: unit tests inject mock wire without lifecycle.
  if (input.fetcher) {
    const response = await input.fetcher("http://127.0.0.1/v1/messages/count_tokens", {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      ...(input.signal && { signal: input.signal }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `token count 上游请求失败：HTTP ${response.status}${text.trim() ? `；${text.trim()}` : ""}`,
      );
    }
    const raw = (await response.json()) as unknown;
    return {
      tokens: parseInputTokens(raw, "Anthropic count_tokens"),
      precision: "provider_exact",
      source: "eco-gateway:/v1/messages/count_tokens",
    };
  }

  await ensureGlobalEcoGateway({ requiredProviderIds: [input.provider.id] });
  const gatewayRequest = new Request("http://127.0.0.1/v1/messages/count_tokens", {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    duplex: "half",
  } as RequestInit);
  const response = await handleGlobalEcoGatewayRequest(gatewayRequest);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `token count 上游请求失败：HTTP ${response.status}${text.trim() ? `；${text.trim()}` : ""}`,
    );
  }
  const raw = (await response.json()) as unknown;
  return {
    tokens: parseInputTokens(raw, "Anthropic count_tokens via eco-gateway"),
    precision: "provider_exact",
    source: "eco-gateway:/v1/messages/count_tokens",
  };
}

async function countViaOpenAIResponses(
  input: CountProviderInputTokensRequest,
  request: AnthropicRequest,
): Promise<ProviderTokenCountResult> {
  // Specialized provider endpoint (not Messages face). Conversion only, no bridge-upstream forward stack.
  const url = buildResponsesInputTokensUrl(
    input.provider.baseUrl,
    input.provider.requestPath,
    input.provider.version,
  );
  const responsesBody = anthropicToResponses(request) as unknown as Record<string, unknown>;
  const body = pickResponsesInputTokenFields(responsesBody);
  const raw = await postJsonForTokenCount(input, url, body, "openai_responses");
  return {
    tokens: responsesInputTokensToAnthropicCount(raw).input_tokens,
    precision: "provider_exact",
    source: url,
  };
}

async function countViaLlamaTokenizer(
  input: CountProviderInputTokensRequest,
  request: AnthropicRequest,
): Promise<ProviderTokenCountResult> {
  const responsesBody = anthropicToResponses(request);
  const chatBody = responsesToChatCompletionsRequest(responsesBody) as unknown as Record<string, unknown>;
  if (Array.isArray(chatBody.tools) && chatBody.tools.length > 0) {
    throw new Error(
      "llama_tokenize 无法从 /apply-template 文档化接口精确计入 tools；请改用 llama.cpp 的 anthropic_messages 或 openai_responses 计数模式。",
    );
  }
  if (!Array.isArray(chatBody.messages)) {
    throw new Error("llama_tokenize 转换后缺少 chat messages。");
  }

  const requestPath = resolveRequestPathForApiCompat(input.provider.requestPath, "openai_chat_completions");
  const root = buildProviderRequestBaseUrl(input.provider.baseUrl, requestPath);
  const templateRaw = await postJsonForTokenCount(
    input,
    `${root}/apply-template`,
    { messages: chatBody.messages },
    "openai_chat_completions",
  );
  const prompt = readPrompt(templateRaw);
  const tokenizedRaw = await postJsonForTokenCount(
    input,
    `${root}/tokenize`,
    { content: prompt, add_special: false, parse_special: true, with_pieces: false },
    "openai_chat_completions",
  );
  const tokens = readTokenArray(tokenizedRaw);
  return {
    tokens: tokens.length,
    precision: "tokenizer_exact",
    source: `${root}/apply-template -> ${root}/tokenize`,
  };
}

function normalizeAnthropicCountRequest(body: Record<string, unknown>, modelId: string): AnthropicRequest {
  const cloned = structuredClone(body) as unknown as AnthropicRequest;
  cloned.model = modelId;
  delete (cloned as unknown as Record<string, unknown>).stream;
  return stripSemanticCompactionDirectives(cloned);
}

function pickResponsesInputTokenFields(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "model",
    "input",
    "instructions",
    "tools",
    "tool_choice",
    "reasoning",
    "text",
    "previous_response_id",
    "conversation",
    "parallel_tool_calls",
    "truncation",
    "personality",
  ] as const) {
    if (body[key] !== undefined) {
      result[key] = body[key];
    }
  }
  return result;
}

async function postJsonForTokenCount(
  input: Pick<CountProviderInputTokensRequest, "fetcher" | "signal" | "upstreamUserAgent" | "timeoutMs"> & {
    provider: Pick<ProviderConfigSecret, "apiKey">;
    headers?: HeadersInit;
  },
  url: string,
  body: Record<string, unknown>,
  apiCompat: UpstreamApiCompat,
): Promise<unknown> {
  const fetcher = input.fetcher ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TOKEN_COUNT_TIMEOUT_MS);
  const abortFromParent = () => controller.abort();
  if (input.signal?.aborted) {
    controller.abort();
  } else {
    input.signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  try {
    const headers = new Headers(
      input.headers ??
        buildProviderDirectUpstreamHeaders({
          apiKey: input.provider.apiKey,
          apiCompat,
          ...(input.upstreamUserAgent && { upstreamUserAgent: input.upstreamUserAgent }),
        }),
    );
    headers.set("accept", "application/json");
    const response = await fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `token count 上游请求失败：HTTP ${response.status}${text.trim() ? `；${text.trim()}` : ""}`,
      );
    }
    if (!text.trim()) {
      throw new Error("token count 上游返回空响应。");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`token count 上游返回无效 JSON：${detail}`);
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`token count 上游请求超时（${input.timeoutMs ?? DEFAULT_TOKEN_COUNT_TIMEOUT_MS}ms）。`);
    }
    if (input.signal?.aborted) {
      throw new Error("token count 请求已取消。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}

function parseInputTokens(raw: unknown, label: string): number {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${label} 响应不是对象。`);
  }
  const value = (raw as Record<string, unknown>).input_tokens;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 响应缺少有效 input_tokens。`);
  }
  return value;
}

function readPrompt(raw: unknown): string {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as Record<string, unknown>).prompt !== "string"
  ) {
    throw new Error("llama.cpp /apply-template 响应缺少 prompt。");
  }
  return (raw as { prompt: string }).prompt;
}

function readTokenArray(raw: unknown): unknown[] {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).tokens)) {
    throw new Error("llama.cpp /tokenize 响应缺少 tokens 数组。");
  }
  return (raw as { tokens: unknown[] }).tokens;
}
