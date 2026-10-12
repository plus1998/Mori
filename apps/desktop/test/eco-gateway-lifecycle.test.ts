import { describe, expect, test } from "bun:test";
import { buildGatewayProvidersFromEcoProviders } from "../src/main/eco-gateway-lifecycle";

describe("eco gateway provider model limits", () => {
  test("clamps candidate max output tokens by global hard ceiling", () => {
    const result = buildGatewayProvidersFromEcoProviders([
      {
        id: "deepseek",
        name: "DeepSeek",
        enabled: true,
        baseUrl: "https://api.example.test/v1",
        apiKey: "secret",
        apiCompat: "openai_chat_completions",
        defaultModel: "deepseek-v4-flash",
        models: [
          { modelId: "deepseek-v4-flash", maxOutputTokens: 384_000 },
          { modelId: "deepseek-v4-pro", maxOutputTokens: 128_000 },
        ],
        modelIds: ["route-only-model"],
      },
    ]);

    expect(result.providers[0]).toMatchObject({
      baseUrl: "https://api.example.test",
      models: expect.arrayContaining(["deepseek-v4-flash", "deepseek-v4-pro", "route-only-model"]),
      modelMaxOutputTokens: {
        "deepseek-v4-flash": 32_768,
        "deepseek-v4-pro": 32_768,
        "route-only-model": 32_768,
      },
    });
  });

  test("respects higher global max output when configured", () => {
    const result = buildGatewayProvidersFromEcoProviders(
      [
        {
          id: "deepseek",
          name: "DeepSeek",
          enabled: true,
          baseUrl: "https://api.example.test/v1",
          apiKey: "secret",
          apiCompat: "openai_chat_completions",
          defaultModel: "deepseek-v4-flash",
          models: [{ modelId: "deepseek-v4-flash", maxOutputTokens: 64_000 }],
        },
      ],
      { globalMaxOutputTokens: 128_000 },
    );
    expect(result.providers[0]?.modelMaxOutputTokens?.["deepseek-v4-flash"]).toBe(64_000);
  });

  test("forwards requestPath into gateway provider payload", () => {
    const result = buildGatewayProvidersFromEcoProviders([
      {
        id: "opencode",
        name: "OpenCode Zen",
        enabled: true,
        baseUrl: "https://opencode.ai/v1",
        requestPath: "zen/",
        apiKey: "secret",
        apiCompat: "openai_responses",
        defaultModel: "claude-sonnet-4",
      },
    ]);

    expect(result.providers[0]).toMatchObject({
      baseUrl: "https://opencode.ai",
      requestPath: "/zen",
    });
  });

  test("omits empty requestPath from gateway payload", () => {
    const result = buildGatewayProvidersFromEcoProviders([
      {
        id: "plain",
        name: "Plain",
        enabled: true,
        baseUrl: "https://api.example.test",
        requestPath: "  ",
        apiKey: "secret",
        apiCompat: "anthropic",
        defaultModel: "claude-sonnet-4",
      },
    ]);

    expect(result.providers[0]?.requestPath).toBeUndefined();
  });

  test("forwards version into gateway provider payload", () => {
    const result = buildGatewayProvidersFromEcoProviders([
      {
        id: "custom-v2",
        name: "Custom V2",
        enabled: true,
        baseUrl: "https://api.example.test/v2",
        version: "v2",
        apiKey: "secret",
        apiCompat: "openai_chat_completions",
        defaultModel: "m1",
      },
    ]);

    expect(result.providers[0]).toMatchObject({
      baseUrl: "https://api.example.test",
      version: "v2",
    });
  });

  test("defaults empty version to v1", () => {
    const result = buildGatewayProvidersFromEcoProviders([
      {
        id: "plain",
        name: "Plain",
        enabled: true,
        baseUrl: "https://api.example.test",
        version: "",
        apiKey: "secret",
        apiCompat: "anthropic",
        defaultModel: "claude-sonnet-4",
      },
    ]);

    expect(result.providers[0]?.version).toBe("v1");
  });
});

test("gateway calculates each model output from its resolved window", () => {
  const result = buildGatewayProvidersFromEcoProviders(
    [
      {
        id: "dynamic",
        name: "Dynamic",
        enabled: true,
        baseUrl: "https://example.test",
        apiKey: "test",
        apiCompat: "openai_responses",
        defaultModel: "small",
        models: [
          { modelId: "small", contextTokens: 32_768, maxOutputTokens: 64_000 },
          { modelId: "large", contextTokens: 262_144, maxOutputTokens: 64_000 },
          { modelId: "limited", contextTokens: 200_000, maxOutputTokens: 4_096 },
        ],
      },
    ],
    { globalMaxOutputTokens: "dynamic" },
  );
  expect(result.providers[0]?.modelMaxOutputTokens).toEqual({ small: 32_767, large: 64_000, limited: 4_096 });
  expect(result.providers[0]?.modelContextTokens).toEqual({ small: 32_768, large: 262_144, limited: 200_000 });
  expect(result.providers[0]?.tokenCountMode).toBe("local_heuristic");
});
