import { describe, expect, test } from "bun:test";
import { defaultProviders } from "../src/provider-config.js";
import { CODEX_TURN_METADATA_HEADER } from "../src/codex-turn-metadata.js";
import {
  buildResolveProviderRouteOptions,
  buildUpstreamCompactUrl,
  buildUpstreamUrl,
  GATEWAY_LOGICAL_REQUEST_ID_HEADER,
  GATEWAY_PROVIDER_ID_HEADER,
  MissingProviderIdError,
  ProviderNotFoundError,
  resolveProviderRoute,
} from "../src/provider-router.js";

describe("resolveProviderRoute", () => {
  const providers = defaultProviders();

  test("requires provider id header-equivalent option", () => {
    expect(() => resolveProviderRoute("claude-sonnet-4-20250514", providers)).toThrow(MissingProviderIdError);
  });

  test("matches provider id + concrete model", () => {
    const route = resolveProviderRoute("claude-sonnet-4-20250514", providers, {
      providerId: "anthropic",
    });
    expect(route.provider.id).toBe("anthropic");
    expect(route.upstreamKind).toBe("anthropic-messages");
    expect(route.upstreamModelId).toBe("claude-sonnet-4-20250514");
  });

  test("disambiguates same model on two providers via provider id", () => {
    const providers = [
      {
        id: "deepseek-official",
        name: "DeepSeek",
        upstreamKind: "anthropic-messages" as const,
        baseUrl: "https://api.deepseek.com",
        apiKey: "k1",
        upstreamModelId: "deepseek-v4-flash",
        models: ["deepseek-v4-flash"],
      },
      {
        id: "packyapi",
        name: "PackyAPI",
        upstreamKind: "anthropic-messages" as const,
        baseUrl: "https://www.packyapi.com",
        apiKey: "k2",
        upstreamModelId: "deepseek-v4-flash",
        models: ["deepseek-v4-flash"],
      },
    ];
    const route = resolveProviderRoute("deepseek-v4-flash", providers, {
      providerId: "packyapi",
    });
    expect(route.provider.id).toBe("packyapi");
    expect(route.upstreamModelId).toBe("deepseek-v4-flash");
  });

  test("allows upstream kind override from bridge", () => {
    const provider = {
      id: "mixed-wire",
      name: "Mixed Wire",
      upstreamKind: "responses" as const,
      baseUrl: "https://api.example.test",
      apiKey: "k",
      upstreamModelId: "default-model",
      models: ["default-model", "chat/model.__v1"],
    };
    const chatRoute = resolveProviderRoute("chat/model.__v1", [provider], {
      providerId: "mixed-wire",
      upstreamKindOverride: "openai-chat",
    });
    expect(chatRoute.upstreamKind).toBe("openai-chat");
    expect(chatRoute.upstreamModelId).toBe("chat/model.__v1");
  });

  test("uses each model's configured upstream under one provider", () => {
    const provider = {
      id: "mixed",
      name: "Mixed",
      upstreamKind: "responses" as const,
      baseUrl: "https://api.example.test",
      apiKey: "k",
      upstreamModelId: "response-model",
      models: ["response-model", "chat-model"],
      modelUpstreams: {
        "response-model": { baseUrl: "https://api.example.test", upstreamKind: "responses" as const },
        "chat-model": { baseUrl: "https://router.example.test", requestPath: "/openai", upstreamKind: "openai-chat" as const },
      },
    };
    const response = resolveProviderRoute("response-model", [provider], { providerId: "mixed" });
    const chat = resolveProviderRoute("chat-model", [provider], { providerId: "mixed" });
    expect(buildUpstreamUrl(response.provider, response.upstreamKind)).toBe("https://api.example.test/v1/responses");
    expect(buildUpstreamUrl(chat.provider, chat.upstreamKind)).toBe("https://router.example.test/openai/v1/chat/completions");
    expect(() => resolveProviderRoute("chat-model", [provider], {
      providerId: "mixed", upstreamKindOverride: "responses",
    })).toThrow(/configured for openai-chat/);
  });

  test("rejects OpenAI kind override on Anthropic-only /anthropic host", () => {
    const provider = {
      id: "deepseek-official",
      name: "DeepSeek",
      upstreamKind: "anthropic-messages" as const,
      baseUrl: "https://api.deepseek.com",
      requestPath: "/anthropic",
      apiKey: "k",
      upstreamModelId: "deepseek-v4-flash",
      models: ["deepseek-v4-flash"],
    };
    expect(() =>
      resolveProviderRoute("deepseek-v4-flash", [provider], {
        providerId: "deepseek-official",
        upstreamKindOverride: "responses",
      }),
    ).toThrow(/will not silently strip \/anthropic/i);
  });

  test("does not parse eco_route_v1 as a special alias", () => {
    const malformed = "eco_route_v1.bad";
    const provider = providers[0]!;
    // Without matching provider id, fails closed.
    expect(() => resolveProviderRoute(malformed, [provider], { providerId: "nope" })).toThrow(
      ProviderNotFoundError,
    );
    // With provider id, concrete model id is forwarded as-is (product layer mistake survives as wire value).
    const route = resolveProviderRoute(malformed, [provider], {
      providerId: provider.id,
    });
    expect(route.upstreamModelId).toBe(malformed);
  });

  test("throws for unknown provider", () => {
    expect(() => resolveProviderRoute("unknown-model", providers, { providerId: "missing" })).toThrow(
      ProviderNotFoundError,
    );
  });

  test("provider id header constant is stable", () => {
    expect(GATEWAY_PROVIDER_ID_HEADER).toBe("x-gateway-provider-id");
  });

  test("buildResolveProviderRouteOptions falls back to Codex turn_id for logicalRequestId", () => {
    const turnId = "01a06172-88e0-7c62-979c-decd3329d0d9";
    const headers = new Headers({
      [CODEX_TURN_METADATA_HEADER]: JSON.stringify({
        thread_id: "01a06172-8849-7da2-8eb9-ce926dabc0ed",
        turn_id: turnId,
        request_kind: "turn",
      }),
    });
    expect(buildResolveProviderRouteOptions(headers).logicalRequestId).toBe(turnId);
  });

  test("explicit logical request id wins over Codex turn_id fallback", () => {
    const headers = new Headers({
      [GATEWAY_LOGICAL_REQUEST_ID_HEADER]: "req_bridge_explicit",
      [CODEX_TURN_METADATA_HEADER]: JSON.stringify({
        thread_id: "codex_thread",
        turn_id: "turn_codex",
        request_kind: "turn",
      }),
    });
    expect(buildResolveProviderRouteOptions(headers).logicalRequestId).toBe("req_bridge_explicit");
  });
});

describe("buildUpstreamUrl", () => {
  test("anthropic messages url", () => {
    const provider = defaultProviders()[0]!;
    expect(buildUpstreamUrl(provider, "anthropic-messages")).toBe("https://api.anthropic.com/v1/messages");
  });

  test("compact url remains constructible for tools that need it", () => {
    const provider = defaultProviders()[1]!;
    expect(buildUpstreamCompactUrl(provider)).toBe("https://api.openai.com/v1/responses/compact");
  });

  test("uses provider version segment when set", () => {
    const provider = {
      ...defaultProviders()[0]!,
      version: "v2",
    };
    expect(buildUpstreamUrl(provider, "anthropic-messages")).toBe("https://api.anthropic.com/v2/messages");
  });

  test("empty version defaults to v1", () => {
    const provider = {
      ...defaultProviders()[0]!,
      version: "  ",
    };
    expect(buildUpstreamUrl(provider, "anthropic-messages")).toBe("https://api.anthropic.com/v1/messages");
  });
});
