import { describe, expect, test } from "bun:test";
import type { AnthropicProxyResolvedRoute } from "../src/main/anthropic-proxy";
import { resolveClaudeSessionUsageRoute } from "../src/main/anthropic-proxy";
import { classifyGatewayUsageEvent } from "../src/main/gateway-usage-dispatch";
import type { ProviderConfigSecret } from "../src/main/provider-store";

describe("classifyGatewayUsageEvent", () => {
  test("routes responses with full turn metadata to Codex", () => {
    expect(
      classifyGatewayUsageEvent({
        source: "responses",
        codexTurnMetadata: {
          threadId: "ct_1",
          turnId: "turn_1",
          requestKind: "turn",
        },
      }),
    ).toEqual({ kind: "codex" });
  });

  test("routes messages without turn metadata to Claude product path", () => {
    expect(classifyGatewayUsageEvent({ source: "messages" })).toEqual({
      kind: "claude_messages",
    });
  });

  test("does not send messages into Codex missing_turn_metadata fallthrough", () => {
    const dispatch = classifyGatewayUsageEvent({ source: "messages" });
    expect(dispatch.kind).not.toBe("codex");
    expect(dispatch.kind).not.toBe("unbillable");
  });

  test("responses without turn metadata are unbillable", () => {
    expect(classifyGatewayUsageEvent({ source: "responses" })).toEqual({
      kind: "unbillable",
      reason: "missing_turn_metadata",
    });
  });

  test("chat_completions without turn metadata use product binding path", () => {
    expect(classifyGatewayUsageEvent({ source: "chat_completions" })).toEqual({
      kind: "claude_messages",
    });
  });

  test("responses with bridgeBindingId use product binding path", () => {
    expect(
      classifyGatewayUsageEvent({
        source: "responses",
        bridgeBindingId: "cbb_pi",
      }),
    ).toEqual({ kind: "claude_messages" });
  });

  test("partial turn metadata is unbillable", () => {
    expect(
      classifyGatewayUsageEvent({
        source: "responses",
        codexTurnMetadata: {
          threadId: "ct_1",
          turnId: "  ",
          requestKind: "turn",
        },
      }),
    ).toEqual({ kind: "unbillable", reason: "missing_turn_metadata" });
  });
});

describe("resolveClaudeSessionUsageRoute", () => {
  const provider: ProviderConfigSecret = {
    id: "prov_a",
    name: "A",
    baseUrl: "https://a.test",
    requestPath: "",
    version: "v1",
    defaultModel: "model-a",
    enabled: true,
    hasApiKey: true,
    apiKey: "k",
    createdAt: "",
    updatedAt: "",
  };

  const routes: AnthropicProxyResolvedRoute[] = [
    {
      role: "main",
      provider,
      modelId: "model-a",
      aliasModelId: "eco-planner-aaaaaaaaaaaa",
      apiCompat: "anthropic",
    },
  ];

  test("matches by alias request model", () => {
    const route = resolveClaudeSessionUsageRoute(routes, {
      providerId: "prov_a",
      requestedModel: "eco-planner-aaaaaaaaaaaa",
      upstreamModelId: "model-a",
    });
    expect(route?.role).toBe("main");
  });

  test("matches by provider + upstream when alias already rewritten", () => {
    const route = resolveClaudeSessionUsageRoute(routes, {
      providerId: "prov_a",
      requestedModel: "model-a",
      upstreamModelId: "model-a",
    });
    expect(route?.modelId).toBe("model-a");
  });

  test("does not match a different provider", () => {
    const route = resolveClaudeSessionUsageRoute(routes, {
      providerId: "other",
      requestedModel: "model-a",
      upstreamModelId: "model-a",
    });
    expect(route).toBeUndefined();
  });
});
