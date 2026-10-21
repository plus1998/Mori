import type { ToolWriteKind } from "@eco/shared";
import type { ParsedUsage } from "./usage-normalize.js";

export type UpstreamKind = "anthropic-messages" | "responses" | "openai-chat" | "gateway-delegated";

export interface GatewayProvider {
  id: string;
  name: string;
  upstreamKind: UpstreamKind;
  baseUrl: string;
  /**
   * Optional path prefix between service root and `/{version}/...`
   * (e.g. `/anthropic`, `/zen`). Empty/omitted means API root.
   */
  requestPath?: string;
  /**
   * API path version segment (e.g. `v1`, `v2`). Empty/missing defaults to `v1`.
   * Final path looks like `{baseUrl}{requestPath}/{version}/messages`.
   */
  version?: string;
  apiKey: string;
  /** Provider authentication mode. ChatGPT plan credentials are resolved locally at request time. */
  authMethod?: "api_key" | "oauth" | "auth_json" | "chatgpt_subscription";
  /** Local credential pool selected by the desktop client. */
  credentialPoolId?: string;
  /** Optional per-provider outbound proxy; requests to this provider's origin bypass the global proxy. */
  upstreamProxyUrl?: string;
  /** Wire model id sent to the real upstream. */
  upstreamModelId: string;
  /** Request `model` values routed to this provider. */
  models: string[];
  /** Per-upstream-model output limits used when Codex omits max_output_tokens. */
  modelMaxOutputTokens?: Record<string, number>;
  /** Present only in dynamic mode; effective min(model window, global window). */
  modelContextTokens?: Record<string, number>;
  /** Explicit provider/model vision settings, enforced before upstream requests. */
  modelSupportsImageInput?: Record<string, boolean>;
  tokenCountMode?: "local_heuristic" | "anthropic_messages" | "openai_responses" | "llama_tokenize";
}

export interface ResolvedProviderRoute {
  provider: GatewayProvider;
  upstreamKind: UpstreamKind;
  requestedModel: string;
  upstreamModelId: string;
  /** Claude Bridge binding identity — echoed into usage events, never guessed. */
  bridgeBindingId?: string;
  threadId?: string;
  runAttemptId?: string;
  /** Codex turn identity retained independently from the Gateway logical request id. */
  turnId?: string;
  logicalRequestId?: string;
  /** Local account selected for a chatgpt_subscription provider. */
  credentialAccountId?: string;
}

export type GatewayUpstreamResultType = "completed" | "failed" | "cancelled";

/** Machine-readable upstream failure evidence. Never includes request authentication headers. */
export interface GatewayUpstreamErrorInfo {
  message: string;
  code?: string;
  param?: string;
  type?: string;
  eventType?: string;
  /** Original JSON error event/body, preserved for diagnosis. */
  rawEvent?: unknown;
}

export interface GatewayCredentialResult {
  provider: GatewayProvider;
  accountId?: string;
  resultType: GatewayUpstreamResultType;
  statusCode?: number;
  providerRequestId?: string;
  responseId?: string;
  error?: GatewayUpstreamErrorInfo;
  logicalRequestId: string;
  attemptIndex: number;
  bridgeBindingId?: string;
  threadId?: string;
  turnId?: string;
  runAttemptId?: string;
}

/** Harness that issued the upstream request. */
export type GatewayAgentCore = "codex" | "claude" | "pi";

export interface GatewayConfig {
  host: string;
  port: number;
  providers: GatewayProvider[];
  /** Trusted per-role model limits from the product's request binding. */
  resolveModelLimits?: (route: ResolvedProviderRoute) => Promise<
    | {
        contextTokens?: number;
        maxOutputTokens?: number;
      }
    | undefined
  >;
  /** Count the final upstream payload, after every protocol/content transformation. */
  countInputTokens?: (input: {
    route: ResolvedProviderRoute;
    body: Record<string, unknown>;
    headers: Headers;
    fetcher: typeof fetch;
    signal?: AbortSignal;
  }) => Promise<{
    tokens: number;
    precision: "provider_exact" | "tokenizer_exact" | "heuristic";
    source: string;
  }>;
  /** Resolves a short-lived upstream bearer token without exposing it to callers. */
  resolveCredential?: (input: {
    provider: GatewayProvider;
    request?: Request;
  }) => Promise<{ accessToken: string; accountId?: string; upstreamProxyUrl?: string }>;
  /** Reports the real upstream attempt terminal back to the local account pool. */
  reportCredentialResult?: (input: GatewayCredentialResult) => void | Promise<void>;
  /**
   * Global upstream User-Agent override (from Proxy Bridge settings).
   * When unset, passthrough client UA or fall back to Eco default.
   */
  upstreamUserAgent?: string;
  /** Per Harness overrides; a cleared entry falls back to the SDK UA. */
  upstreamUserAgents?: Partial<Record<GatewayAgentCore, string>>;
  /** Eco fallback UA (app version + OS) for requests without any client UA. */
  userAgentDefault?: string;
  /** Optional global outbound HTTP/HTTPS/SOCKS proxy URL for upstream fetch. */
  upstreamProxyUrl?: string;
}

/** Exact Codex request identity from the `x-codex-turn-metadata` header. */
export type GatewayCodexRequestKind = "turn" | "prewarm" | "compaction";

export interface GatewayCodexTurnMetadata {
  threadId: string;
  turnId: string;
  parentThreadId?: string;
  subagentKind?: string;
  requestKind: GatewayCodexRequestKind;
}

export interface GatewayUsageEvent {
  source: "responses" | "messages" | "chat_completions";
  sourceEventId: string;
  providerId: string;
  requestedModel: string;
  upstreamModelId: string;
  usage: ParsedUsage;
  stream: boolean;
  observedAt: string;
  /** Gateway-measured time to first upstream response chunk (stream only; new-api TTFT). */
  ttftMs?: number;
  /** Gateway-measured first-chunk → stream-end window in ms (new-api generationMs). */
  generationMs?: number;
  /** Gateway-measured network RTT estimate in ms: upstream start → first headers (optional). */
  firstHeadersMs?: number;
  /** Gateway-measured time to first text token delta in ms: upstream start → first content token (optional). */
  firstTokenMs?: number;
  responseId?: string;
  providerRequestId?: string;
  codexTurnMetadata?: GatewayCodexTurnMetadata;
  /** Claude Bridge binding — product layer attributes usage without active-session guessing. */
  bridgeBindingId?: string;
  threadId?: string;
  runAttemptId?: string;
  /** Bridge logical request id — joins usage back to request-time agent stamp. */
  logicalRequestId?: string;
}

export type GatewayUsageObserver = (event: GatewayUsageEvent) => void | Promise<void>;

export type GatewayRequestLifecycleSource = "messages" | "responses" | "chat_completions";

export type GatewayRequestLifecycleEvent =
  | {
      type: "upstream.started";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      observedAt: string;
    }
  | {
      type: "upstream.headers";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      providerRequestId?: string;
      statusCode: number;
      observedAt: string;
    }
  | {
      type: "upstream.completed";
      resultType: "completed";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      accountId?: string;
      providerRequestId?: string;
      responseId?: string;
      statusCode?: number;
      observedAt: string;
    }
  | {
      type: "upstream.failed";
      resultType: "failed";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      accountId?: string;
      providerRequestId?: string;
      responseId?: string;
      stage: "transport" | "http" | "stream" | "protocol";
      statusCode?: number;
      error: string;
      errorInfo?: GatewayUpstreamErrorInfo;
      observedAt: string;
    }
  | {
      type: "upstream.cancelled";
      resultType: "cancelled";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      accountId?: string;
      providerRequestId?: string;
      responseId?: string;
      statusCode?: number;
      reason?: string;
      observedAt: string;
    }
  | {
      type: "logical.completed";
      resultType: "completed";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      accountId?: string;
      providerRequestId?: string;
      responseId?: string;
      observedAt: string;
    }
  | {
      type: "logical.failed";
      resultType: "failed";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      accountId?: string;
      providerRequestId?: string;
      responseId?: string;
      stage?: "transport" | "http" | "stream" | "protocol";
      statusCode?: number;
      error: string;
      errorInfo?: GatewayUpstreamErrorInfo;
      observedAt: string;
    }
  | {
      type: "logical.cancelled";
      resultType: "cancelled";
      source: GatewayRequestLifecycleSource;
      providerId: string;
      requestedModel: string;
      upstreamModelId: string;
      logicalRequestId: string;
      attemptIndex: number;
      bridgeBindingId?: string;
      threadId?: string;
      turnId?: string;
      runAttemptId?: string;
      accountId?: string;
      providerRequestId?: string;
      responseId?: string;
      reason?: string;
      observedAt: string;
    };

export type GatewayRequestLifecycleObserver = (event: GatewayRequestLifecycleEvent) => void | Promise<void>;

/**
 * The model has begun writing a tool call, observed on the upstream stream.
 *
 * Codex is the only client that sends `x-codex-turn-metadata`, and its app-server
 * publishes nothing for this period: the `item/started` it eventually emits already
 * carries the finished arguments, and a large `apply_patch` takes minutes to write.
 * The upstream stream states the fact plainly (`response.output_item.added` for a tool
 * item lands milliseconds after the last text), so the gateway forwards it.
 */
export interface GatewayToolWriteObservation {
  state: "writing" | "ready";
  /** Client thread identity from `x-codex-turn-metadata`. */
  codexThreadId: string;
  turnId?: string;
  /** Function name exactly as the model sent it (`apply_patch`, `shell`, `mcp__…`). */
  toolName?: string;
  /** What the call does, for the label while the arguments still have not named a target. */
  kind: ToolWriteKind;
  /** The file or command line the call names, once its arguments have revealed it. */
  target?: string;
  /** Provider call id, used to announce each call once. */
  callId?: string;
  observedAt: string;
}

export type GatewayToolWriteObserver = (observation: GatewayToolWriteObservation) => void | Promise<void>;
