import { describe, expect, test } from "bun:test";
import {
  extractUpstreamErrorMessage,
  formatUpstreamHttpError,
  upstreamErrorResponse,
} from "../src/upstream/upstream-error.js";

describe("upstream-error", () => {
  test("extracts OpenAI-style error.message", () => {
    expect(
      extractUpstreamErrorMessage(
        JSON.stringify({
          error: { message: "We're currently experiencing high demand, which may cause temporary errors." },
        }),
      ),
    ).toBe("We're currently experiencing high demand, which may cause temporary errors.");
  });

  test("attributes provider model and url", () => {
    const message = formatUpstreamHttpError({
      route: {
        provider: {
          id: "custom",
          name: "Custom",
          upstreamKind: "openai-chat",
          baseUrl: "http://192.168.110.78:8080",
          apiKey: "x",
          upstreamModelId: "qwen3.6-35b-a3b",
          models: ["qwen3.6-35b-a3b"],
        },
        upstreamKind: "openai-chat",
        requestedModel: "qwen3.6-35b-a3b",
        upstreamModelId: "qwen3.6-35b-a3b",
      },
      upstreamUrl: "http://192.168.110.78:8080/v1/chat/completions",
      status: 503,
      bodyText: JSON.stringify({
        error: { message: "We're currently experiencing high demand, which may cause temporary errors." },
      }),
    });
    expect(message).toContain("Upstream provider custom");
    expect(message).toContain("model=qwen3.6-35b-a3b");
    expect(message).toContain("status=503");
    expect(message).toContain("high demand");
  });

  test("preserves context overflow fields so SDK compaction can reduce its input", async () => {
    const response = upstreamErrorResponse({
      route: {
        provider: {
          id: "deepseek",
          name: "Deepseek",
          upstreamKind: "responses",
          baseUrl: "https://example.test",
          apiKey: "secret-must-not-leak",
          upstreamModelId: "deepseek-flash",
          models: ["deepseek-flash"],
        },
        upstreamKind: "responses",
        requestedModel: "deepseek-flash",
        upstreamModelId: "deepseek-flash",
      },
      upstreamUrl: "https://example.test/v1/responses",
      status: 400,
      bodyText: JSON.stringify({
        error: {
          message: "Context window exhausted: window=946176, input=893615, reserve=94618.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
          param: "input",
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-eco-upstream-error-code")).toBe("context_length_exceeded");
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "context_length_exceeded",
      type: "invalid_request_error",
      param: "input",
      providerId: "deepseek",
      model: "deepseek-flash",
      status: 400,
    });
    expect(body.error.message).toContain("input=893615");
    expect(JSON.stringify(body)).not.toContain("secret-must-not-leak");
  });
});
