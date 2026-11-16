import { describe, expect, test } from "bun:test";
import {
  extractUsageFromResponsesStreamEvent,
  normalizeAnthropicUsage,
  normalizeChatCompletionsUsage,
  normalizeResponsesUsage,
} from "../src/usage-normalize.js";

describe("usage-normalize", () => {
  test("Anthropic usage without cache counters bills full input without a cache discount", () => {
    expect(
      normalizeAnthropicUsage(
        {
          input_tokens: 11088,
          output_tokens: 37,
        },
        "deepseek-v4-flash",
      ),
    ).toEqual({
      inputTokens: 11088,
      outputTokens: 37,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      modelId: "deepseek-v4-flash",
    });
  });

  test("normalizeResponsesUsage maps Responses usage to ParsedUsage", () => {
    const parsed = normalizeResponsesUsage(
      {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
      },
      "gpt-4.1",
    );
    expect(parsed).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
      modelId: "gpt-4.1",
    });
  });

  test("explicit cache-read counters keep Anthropic-style input separate", () => {
    expect(
      normalizeResponsesUsage(
        {
          input_tokens: 60,
          output_tokens: 20,
          total_tokens: 130,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
        "vendor-responses",
      ),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
      modelId: "vendor-responses",
    });
  });

  test("Chat cached-token details are a subset, while explicit cache-read is separate", () => {
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
      }),
    ).toEqual({
      inputTokens: 50,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
    });
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 60,
        completion_tokens: 20,
        total_tokens: 130,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
    });
  });

  test("top-level cache counters use total_tokens to distinguish overlap from separation", () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toMatchObject({ inputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 10 });
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    ).toMatchObject({ inputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 10 });
  });

  test("conflicting top-level and details cache counters fail closed", () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        cache_read_input_tokens: 40,
        input_tokens_details: { cached_tokens: 40 },
      }),
    ).toBeNull();
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        cache_creation_input_tokens: 10,
        prompt_tokens_details: { cache_write_tokens: 10 },
      }),
    ).toBeNull();
  });

  test("rejects overlapping cache breakdowns and invalid token counters", () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 10,
        output_tokens: 1,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 8, cache_write_tokens: 3 },
      }),
    ).toBeNull();
    expect(
      normalizeResponsesUsage({
        input_tokens: 10,
        output_tokens: -1,
        total_tokens: 9,
      }),
    ).toBeNull();
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 10.5,
        completion_tokens: 1,
        total_tokens: 11.5,
      }),
    ).toBeNull();
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 10,
        completion_tokens: 1,
        total_tokens: 11,
        cache_creation_input_tokens: -7,
      }),
    ).toBeNull();
  });

  test("extractUsageFromResponsesStreamEvent reads response.completed", () => {
    const parsed = extractUsageFromResponsesStreamEvent(
      {
        type: "response.completed",
        response: {
          id: "r1",
          model: "claude-sonnet-4-20250514",
          status: "completed",
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      },
      undefined,
    );
    expect(parsed?.inputTokens).toBe(10);
    expect(parsed?.outputTokens).toBe(5);
    expect(parsed?.modelId).toBe("claude-sonnet-4-20250514");
  });

  test("extractUsageFromResponsesStreamEvent accepts top-level completion usage", () => {
    const parsed = extractUsageFromResponsesStreamEvent(
      {
        type: "response.completed",
        response: {
          id: "r2",
          status: "completed",
          output: [],
        },
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      } as never,
      "gpt-compatible",
    );
    expect(parsed).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      modelId: "gpt-compatible",
    });
  });

  test("reads reasoning_tokens from completion_tokens_details", () => {
    expect(
      normalizeChatCompletionsUsage({
        prompt_tokens: 25,
        completion_tokens: 550,
        total_tokens: 575,
        completion_tokens_details: { reasoning_tokens: 129 },
      }),
    ).toMatchObject({
      inputTokens: 25,
      outputTokens: 550,
      reasoningTokens: 129,
    });
  });

  test("reads reasoning_tokens from output_tokens_details", () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 485,
        output_tokens: 50,
        total_tokens: 535,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 34 },
      }),
    ).toMatchObject({
      inputTokens: 485,
      outputTokens: 50,
      reasoningTokens: 34,
    });
  });
});
