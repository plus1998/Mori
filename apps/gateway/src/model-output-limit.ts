import { coalesceResponsesCompactionInput } from "./compaction-input.js";
import type { GatewayLogFn } from "./server.js";
import type { GatewayConfig, ResolvedProviderRoute } from "./types.js";

/** Enforce the product's output ceiling, including after thinking-budget rectification. */
export function applyModelOutputLimit(
  body: Record<string, unknown>,
  route: ResolvedProviderRoute,
  field: "max_tokens" | "max_output_tokens" | "max_completion_tokens",
): void {
  const limit = route.provider.modelMaxOutputTokens?.[route.upstreamModelId];
  if (limit === undefined) return;
  applyOutputLimit(body, field, limit);
}

function applyOutputLimit(
  body: Record<string, unknown>,
  field: "max_tokens" | "max_output_tokens" | "max_completion_tokens",
  limit: number,
  preserveRequested = true,
): void {
  const requested = body[field];
  const applied =
    preserveRequested && typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, limit)
      : limit;
  body[field] = applied;
  if (field !== "max_tokens" || !body.thinking || typeof body.thinking !== "object") return;
  const thinking = body.thinking as Record<string, unknown>;
  if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
    thinking.budget_tokens = Math.min(thinking.budget_tokens, applied - 1);
  }
}

/** Budget the actual upstream wire body, including rectified/retried requests. */
export function withDynamicOutputBudget(
  fetcher: typeof fetch,
  route: ResolvedProviderRoute,
  config: GatewayConfig,
  signal: AbortSignal,
  onLog: GatewayLogFn,
): typeof fetch {
  // The ChatGPT subscription Responses preview rejects max_output_tokens. The
  // Responses and Messages→Responses routes strip that field before calling
  // this fetcher, so there is no output budget for this wrapper to enforce.
  if (route.provider.authMethod === "chatgpt_subscription") return fetcher;
  if (route.provider.modelContextTokens === undefined) return fetcher;
  return (async (url, init) => {
    try {
      const boundLimits = await config.resolveModelLimits?.(route);
      const configuredWindow = route.provider.modelContextTokens?.[route.upstreamModelId];
      const window =
        boundLimits?.compactionContextTokens ??
        (configuredWindow === undefined
          ? undefined
          : Math.min(configuredWindow, boundLimits?.contextTokens ?? configuredWindow));
      if (window === undefined || !Number.isSafeInteger(window) || window < 2) {
        throw new Error(
          `Dynamic max output requires a resolved context window for ${route.upstreamModelId}.`,
        );
      }
      if (!config.countInputTokens) throw new Error("Dynamic max output requires an input token counter.");
      if (typeof init?.body !== "string")
        throw new Error("Dynamic max output requires the final JSON request body.");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (boundLimits?.compactionContextTokens !== undefined && route.upstreamKind === "responses") {
        coalesceResponsesCompactionInput(body);
      }
      const count = await config.countInputTokens({
        route,
        body,
        headers: new Headers(init.headers),
        fetcher,
        signal: init.signal ?? signal,
      });
      if (!Number.isSafeInteger(count.tokens) || count.tokens < 0) {
        throw new Error("Dynamic max output requires a valid current input token count.");
      }
      // Character estimates can undercount substantially; reserve headroom based on
      // the counter's actual precision rather than treating it as an exact tokenizer.
      const reserve = count.precision === "heuristic" ? Math.max(8_192, Math.ceil(window / 10)) : 1_024;
      const remaining = window - count.tokens - reserve;
      if (remaining < 1) {
        return Response.json(
          {
            error: {
              message: `Context window exhausted: window=${window}, input=${count.tokens}, reserve=${reserve}. Compact the input before retrying.`,
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          },
          { status: 400 },
        );
      }
      const limit = Math.min(
        remaining,
        route.provider.modelMaxOutputTokens?.[route.upstreamModelId] ?? remaining,
        boundLimits?.maxOutputTokens ?? remaining,
      );
      const field =
        route.upstreamKind === "anthropic-messages"
          ? "max_tokens"
          : route.upstreamKind === "openai-chat"
            ? body.max_completion_tokens !== undefined
              ? "max_completion_tokens"
              : "max_tokens"
            : "max_output_tokens";
      // Dynamic mode owns the output budget. SDK defaults (including Claude's 32000)
      // must not become a second, smaller ceiling after counting this request.
      applyOutputLimit(body, field, limit, false);
      if (field === "max_completion_tokens" && body.max_tokens !== undefined)
        applyOutputLimit(body, "max_tokens", limit, false);
      const thinking = body.thinking as Record<string, unknown> | undefined;
      if (field === "max_tokens" && thinking?.type === "enabled" && Number(thinking.budget_tokens) < 1_024) {
        return Response.json(
          {
            error: {
              message: `Remaining output=${body[field]} cannot accommodate the minimum thinking budget of 1024 tokens. Compact the input before retrying.`,
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          },
          { status: 400 },
        );
      }
      onLog(
        `dynamic output provider=${route.provider.id} model=${route.upstreamModelId} window=${window} input=${count.tokens} precision=${count.precision} source=${count.source} reserve=${reserve} remaining=${remaining} applied=${body[field]}`,
      );
      return fetcher(url, { ...init, body: JSON.stringify(body) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      onLog(`dynamic output rejected provider=${route.provider.id}: ${message}`);
      return Response.json(
        { error: { message, type: "input_token_count_error", code: "dynamic_output_budget_error" } },
        { status: 400 },
      );
    }
  }) as typeof fetch;
}
