/**
 * Product auxiliary LLM calls (title, compact summary, git commit, approval).
 * Always go through the Eco SDK Bridge → embedded Gateway (1B).
 * Build the selected provider's native wire format; no cross-protocol conversion.
 */
import {
  GATEWAY_PROVIDER_ID_HEADER,
  GATEWAY_REQUESTED_MODEL_HEADER,
  GATEWAY_UPSTREAM_KIND_HEADER,
  IncrementalSseParser,
  mapApiCompatToUpstreamKind,
} from "@eco/gateway";
import { isCandidateModelId } from "@eco/shared";
import { resolveUpstreamApiCompat, type UpstreamApiCompat } from "../shared/api-compat";
import type { PromptImageAttachment } from "../shared/ipc";
import type { AnthropicProxyRoute } from "./anthropic-proxy";
import { OAUTH_ACCOUNT_ID_HEADER } from "./chatgpt-gateway-account";
import { ensureGlobalEcoGateway, getGlobalEcoBridgeBaseUrl } from "./eco-gateway-lifecycle";
import { applyProxyCchToAnthropicMessagesBody } from "./proxy-cch-audit";
import { headersToLoggable, logUpstream, logUpstreamError, truncateForLog } from "./upstream-log";

type Fetcher = typeof fetch;

/** Product input, independent of every Harness and provider wire format. */
export interface StatelessModelPrompt {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  images?: readonly PromptImageAttachment[];
  maxTokens?: number;
  temperature?: number;
  disableThinking?: boolean;
  jsonSchema?: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nativeResponseText(value: unknown, protocol: UpstreamApiCompat): string {
  const body = record(value);
  if (body.error) throw new Error(String(record(body.error).message ?? body.error));
  if (protocol === "openai_responses") {
    if (body.status === "failed" || body.status === "incomplete") {
      throw new Error(
        `Responses 请求未完成：${JSON.stringify(body.error ?? body.incomplete_details ?? body.status)}`,
      );
    }
    if (typeof body.output_text === "string") return body.output_text;
    return (Array.isArray(body.output) ? body.output : [])
      .flatMap((item) => {
        const content = record(item).content;
        return (Array.isArray(content) ? content : []).flatMap((part) => {
          const block = record(part);
          if (block.type === "refusal") throw new Error(String(block.refusal ?? "模型拒绝了请求"));
          return block.type === "output_text" && typeof block.text === "string" ? [block.text] : [];
        });
      })
      .join("\n");
  }
  if (protocol === "openai_chat_completions") {
    const choice = record(Array.isArray(body.choices) ? body.choices[0] : undefined);
    if (choice.finish_reason === "length") throw new Error("模型输出预算已耗尽，请提高输出上限后重试。");
    const message = record(choice.message);
    if (message.refusal) throw new Error(String(message.refusal));
    return typeof message.content === "string" ? message.content : "";
  }
  if (body.stop_reason === "max_tokens") throw new Error("模型输出预算已耗尽，请提高输出上限后重试。");
  return (Array.isArray(body.content) ? body.content : [])
    .flatMap((part) => {
      const block = record(part);
      return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n");
}

export async function readStatelessModelText(
  response: Response,
  protocol: UpstreamApiCompat,
  onTextDelta?: (delta: string, text: string) => void,
): Promise<string> {
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    const text = nativeResponseText(await response.json(), protocol).trim();
    if (text) onTextDelta?.(text, text);
    return text;
  }
  const reader = response.body.getReader();
  let text = "";
  let completed = false;
  const consume = (data: string) => {
    if (data === "[DONE]") {
      if (protocol === "openai_responses" && !completed) throw new Error("Responses 响应流缺少完成事件。");
      completed = true;
      return;
    }
    const event = record(JSON.parse(data));
    if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
      throw new Error(JSON.stringify(event.error ?? record(event.response).error ?? event));
    }
    let delta = "";
    if (protocol === "openai_responses") {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") delta = event.delta;
      if (event.type === "response.completed") {
        completed = true;
        const finalText = nativeResponseText(event.response, protocol);
        if (!text && finalText) delta = finalText;
      }
    } else if (protocol === "anthropic") {
      const block = record(event.delta);
      if (
        event.type === "content_block_delta" &&
        block.type === "text_delta" &&
        typeof block.text === "string"
      )
        delta = block.text;
      if (event.type === "message_delta" && block.stop_reason === "max_tokens")
        throw new Error("模型输出预算已耗尽。");
      if (event.type === "message_stop") completed = true;
    } else {
      const choice = record(Array.isArray(event.choices) ? event.choices[0] : undefined);
      const content = record(choice.delta).content;
      if (typeof content === "string") delta = content;
      if (choice.finish_reason === "length") throw new Error("模型输出预算已耗尽。");
      if (choice.finish_reason === "stop") completed = true;
    }
    if (delta) {
      text += delta;
      onTextDelta?.(delta, text);
    }
  };
  const parser = new IncrementalSseParser();
  const consumeFrames = (frames: ReturnType<IncrementalSseParser["push"]>) => {
    for (const frame of frames) if (frame.data.trim()) consume(frame.data);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consumeFrames(parser.push(value));
    }
    consumeFrames(parser.finish());
    if (!completed) throw new Error("模型响应流意外结束，未收到完成事件。");
    return text.trim();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function buildStatelessModelRequest(route: AnthropicProxyRoute, prompt: StatelessModelPrompt) {
  const protocol = resolveRouteApiCompat(route);
  const oauth = route.provider.authMethod === "chatgpt_subscription";
  if (oauth && protocol !== "openai_responses") throw new Error("ChatGPT OAuth 必须使用 Responses 协议。");
  const maxTokens = route.maxOutputTokens ?? prompt.maxTokens ?? 4096;
  const lastUserIndex = prompt.messages.findLastIndex((message) => message.role === "user");
  const images = prompt.images ?? [];
  if (protocol === "anthropic") {
    const body: Record<string, unknown> = {
      model: route.modelId,
      stream: false,
      max_tokens: maxTokens,
      ...(prompt.system ? { system: prompt.system } : {}),
      ...(prompt.temperature !== undefined ? { temperature: prompt.temperature } : {}),
      ...(prompt.disableThinking ? { thinking: { type: "disabled" } } : {}),
      ...(prompt.jsonSchema ? { output_format: { type: "json_schema", schema: prompt.jsonSchema } } : {}),
      messages: prompt.messages.map((message, index) => ({
        role: message.role,
        content:
          index === lastUserIndex && images.length
            ? [
                ...images.map((image) => ({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: image.mediaType,
                    data: image.data,
                  },
                })),
                { type: "text", text: message.content },
              ]
            : message.content,
      })),
    };
    return { path: "/v1/messages", body: applyProxyCchToAnthropicMessagesBody(body) };
  }
  if (protocol === "openai_responses") {
    return {
      path: "/v1/responses",
      body: {
        model: route.modelId,
        stream: oauth,
        store: false,
        ...(prompt.system ? { instructions: prompt.system } : {}),
        ...(!oauth
          ? {
              max_output_tokens: maxTokens,
              ...(prompt.temperature !== undefined ? { temperature: prompt.temperature } : {}),
            }
          : {}),
        ...(prompt.jsonSchema
          ? {
              text: {
                format: {
                  type: "json_schema",
                  name: "result",
                  strict: true,
                  schema: prompt.jsonSchema,
                },
              },
            }
          : {}),
        input: prompt.messages.map((message, index) => ({
          type: "message",
          role: message.role,
          content: [
            { type: message.role === "assistant" ? "output_text" : "input_text", text: message.content },
            ...(index === lastUserIndex
              ? images.map((image) => ({
                  type: "input_image",
                  image_url: `data:${image.mediaType};base64,${image.data}`,
                }))
              : []),
          ],
        })),
      },
    };
  }
  return {
    path: "/v1/chat/completions",
    body: {
      model: route.modelId,
      stream: false,
      max_tokens: maxTokens,
      ...(prompt.temperature !== undefined ? { temperature: prompt.temperature } : {}),
      ...(prompt.jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "result",
                strict: true,
                schema: prompt.jsonSchema,
              },
            },
          }
        : {}),
      messages: [
        ...(prompt.system ? [{ role: "system", content: prompt.system }] : []),
        ...prompt.messages.map((message, index) => ({
          role: message.role,
          content:
            index === lastUserIndex && images.length
              ? [
                  { type: "text", text: message.content },
                  ...images.map((image) => ({
                    type: "image_url",
                    image_url: {
                      url: `data:${image.mediaType};base64,${image.data}`,
                    },
                  })),
                ]
              : message.content,
        })),
      ],
    },
  };
}

export function resolveRouteApiCompat(route: AnthropicProxyRoute): UpstreamApiCompat {
  return resolveUpstreamApiCompat(route.apiCompat, route.provider.apiCompat);
}

export interface PostAuxiliaryBridgeRequestInput {
  route: AnthropicProxyRoute;
  prompt: StatelessModelPrompt;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Extra client headers forwarded on the Bridge request (e.g. structured-outputs beta). */
  anthropicExtraHeaders?: Record<string, string>;
  logEventPrefix: string;
  fetcher?: Fetcher;
  onTextDelta?: (delta: string, text: string) => void;
}

export interface PostAuxiliaryBridgeRequestResult {
  ok: boolean;
  text?: string;
  upstreamError?: string;
  status?: number;
  error?: string;
}

export async function postAuxiliaryBridgeRequest(
  input: PostAuxiliaryBridgeRequestInput,
): Promise<PostAuxiliaryBridgeRequestResult> {
  const fetcher = input.fetcher ?? fetch;
  const apiCompat = resolveRouteApiCompat(input.route);
  const upstreamKind = mapApiCompatToUpstreamKind(
    apiCompat as "anthropic" | "openai_responses" | "openai_chat_completions",
  );

  let bridgeBaseUrl = "http://eco-bridge.test";
  try {
    await ensureGlobalEcoGateway({
      requiredProviderIds: [input.route.provider.id],
    });
    bridgeBaseUrl = getGlobalEcoBridgeBaseUrl();
  } catch (error) {
    if (!input.fetcher) {
      const message = error instanceof Error ? error.message : String(error);
      logUpstreamError(`${input.logEventPrefix}-gateway-unavailable`, {
        role: input.route.role,
        provider: input.route.provider.name,
        modelId: input.route.modelId,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  if (input.route.provider.authMethod === "chatgpt_subscription" && !input.route.accountId?.trim()) {
    return { ok: false, error: "ChatGPT OAuth 模型尚未选择账号，请先选择账号和模型。" };
  }
  const native = buildStatelessModelRequest(
    {
      ...input.route,
      modelId:
        input.route.candidateModelId && isCandidateModelId(input.route.candidateModelId)
          ? input.route.candidateModelId
          : input.route.modelId,
    },
    input.prompt,
  );
  const requestUrl = `${bridgeBaseUrl}${native.path}`;
  const body = native.body;

  // real upstream model only — never synthetic eco-aux-* (must not participate in resolution)
  const headers: Record<string, string> = {
    ...input.headers,
    "content-type": "application/json",
    [GATEWAY_PROVIDER_ID_HEADER]: input.route.provider.id,
    [GATEWAY_UPSTREAM_KIND_HEADER]: upstreamKind,
    [GATEWAY_REQUESTED_MODEL_HEADER]: input.route.modelId,
    "x-eco-route-role": input.route.role,
    ...(input.route.accountId ? { [OAUTH_ACCOUNT_ID_HEADER]: input.route.accountId } : {}),
  };
  if (input.anthropicExtraHeaders) {
    for (const [key, value] of Object.entries(input.anthropicExtraHeaders)) {
      if (value.trim()) {
        headers[key] = value;
      }
    }
  }

  logUpstream(`${input.logEventPrefix}-request`, {
    role: input.route.role,
    provider: input.route.provider.name,
    modelId: input.route.modelId,
    apiCompat,
    via: "eco-bridge",
    url: requestUrl,
    headers: headersToLoggable(headers),
    body,
  });

  try {
    const response = await fetcher(requestUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(input.signal && { signal: input.signal }),
    });

    if (!response.ok) {
      const raw = await response.text();
      logUpstreamError(`${input.logEventPrefix}-response-error`, {
        role: input.route.role,
        provider: input.route.provider.name,
        modelId: input.route.modelId,
        apiCompat,
        status: response.status,
        statusText: response.statusText,
        body: truncateForLog(raw),
      });
      return { ok: false, status: response.status, error: truncateForLog(raw) };
    }

    const text = await readStatelessModelText(response, apiCompat, input.onTextDelta);
    if (!text) {
      logUpstreamError(`${input.logEventPrefix}-invalid`, {
        role: input.route.role,
        provider: input.route.provider.name,
        modelId: input.route.modelId,
        apiCompat,
        reason: "empty-reply",
      });
      return { ok: false };
    }

    logUpstream(`${input.logEventPrefix}-response`, {
      role: input.route.role,
      provider: input.route.provider.name,
      modelId: input.route.modelId,
      apiCompat,
      via: "eco-bridge",
      text,
    });
    return { ok: true, text };
  } catch (error) {
    logUpstreamError(`${input.logEventPrefix}-fetch-error`, {
      role: input.route.role,
      provider: input.route.provider.name,
      modelId: input.route.modelId,
      apiCompat,
      url: requestUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
