import { expect, test } from "bun:test";
import { withDynamicOutputBudget } from "../src/model-output-limit.js";
import type { GatewayConfig, GatewayProvider } from "../src/types.js";
import { createTestGatewayFetchHandler } from "./test-bridge-rewrite.js";

for (const [face, kind, field] of [
  ["responses", "responses", "max_output_tokens"],
  ["messages", "anthropic-messages", "max_tokens"],
  ["chat/completions", "openai-chat", "max_tokens"],
  ["chat/completions", "openai-chat", "max_completion_tokens"],
] as const) {
  for (const [requested, applied] of [
    [undefined, 8_192],
    [64_000, 8_192],
    [1_600, 1_600],
  ] as const) {
    test(`${face} applies output cap ${requested} → ${applied}`, async () => {
      const provider: GatewayProvider = {
        id: "test",
        name: "Test",
        upstreamKind: kind,
        baseUrl: "https://example.test",
        apiKey: "test",
        upstreamModelId: "small",
        models: ["small"],
        modelMaxOutputTokens: { small: 8_192 },
      };
      let sent: Record<string, unknown> | undefined;
      const handler = createTestGatewayFetchHandler(
        { host: "127.0.0.1", port: 0, providers: [provider] },
        async (_url, init) => {
          sent = JSON.parse(String(init?.body));
          if (face === "chat/completions")
            return Response.json({
              id: "chat_test",
              object: "chat.completion",
              model: "small",
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            });
          return Response.json(
            face === "responses"
              ? { id: "resp_test", object: "response", output: [], status: "completed" }
              : {
                  id: "msg_test",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                  stop_reason: "end_turn",
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
          );
        },
      );
      const response = await handler(
        new Request(`http://127.0.0.1/v1/${face}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-gateway-provider-id": "test" },
          body: JSON.stringify({
            model: "small",
            input: [],
            messages: [{ role: "user", content: "hi" }],
            ...(requested !== undefined && { [field]: requested }),
            ...(face === "chat/completions" &&
              field === "max_completion_tokens" &&
              requested === undefined && { max_completion_tokens: 64_000 }),
          }),
        }),
      );
      expect(response.status).toBe(200);
      expect(sent?.[field]).toBe(applied);
    });
  }
}

test("thinking budget retry stays within the output ceiling", async () => {
  const { fetchWithThinkingRectifiers } = await import("../src/upstream/anthropic-messages.js");
  const provider: GatewayProvider = {
    id: "test",
    name: "Test",
    upstreamKind: "anthropic-messages",
    baseUrl: "https://example.test",
    apiKey: "test",
    upstreamModelId: "small",
    models: ["small"],
    modelMaxOutputTokens: { small: 8_192 },
  };
  let calls = 0;
  const response = await fetchWithThinkingRectifiers(
    { provider, upstreamKind: "anthropic-messages", requestedModel: "small", upstreamModelId: "small" },
    "https://example.test/v1/messages",
    {},
    {
      model: "small",
      max_tokens: 64_000,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 1 },
    },
    async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      expect(body.max_tokens).toBe(8_192);
      if (calls === 1)
        return Response.json(
          { error: { message: "thinking.budget_tokens: Input should be greater than or equal to 1024" } },
          { status: 400 },
        );
      expect(body.thinking.budget_tokens).toBe(8_191);
      return Response.json({});
    },
    () => {},
  );
  expect(response.status).toBe(200);
  expect(calls).toBe(2);
});

test("dynamic budget recounts growing inputs, including final converted tools", async () => {
  const provider: GatewayProvider = {
    id: "dynamic",
    name: "Dynamic",
    upstreamKind: "anthropic-messages",
    baseUrl: "https://example.test",
    apiKey: "test",
    upstreamModelId: "small",
    models: ["small"],
    modelMaxOutputTokens: { small: 64_000 },
    modelContextTokens: { small: 32_768 },
  };
  const counted: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    providers: [provider],
    countInputTokens: async ({ body, route }) => {
      expect(route.upstreamModelId).toBe("small");
      expect(body.model).toBe("small");
      expect(body.messages).toBeArray();
      expect(body.tools).toEqual([
        expect.objectContaining({ name: "lookup", input_schema: expect.any(Object) }),
      ]);
      counted.push(body);
      return {
        tokens: counted.length === 1 ? 100 : 31_644,
        precision: "provider_exact",
        source: "test:input",
      };
    },
  };
  const handler = createTestGatewayFetchHandler(config, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  for (const prompt of ["hi", "growing history"]) {
    const response = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gateway-provider-id": "dynamic" },
        body: JSON.stringify({
          model: "small",
          input: [{ role: "user", content: prompt }],
          instructions: "System instructions",
          tools: [
            {
              type: "function",
              name: "lookup",
              parameters: { type: "object", properties: { query: { type: "string" } } },
            },
          ],
        }),
      }),
    );
    expect(response.status).toBe(200);
    await response.text();
  }
  expect(sent.map((body) => body.max_tokens)).toEqual([31_644, 100]);
  expect(counted.every((body) => body.system === "System instructions")).toBe(true);
});

test("dynamic refuses heuristic counters even when they claim sufficient or exhausted space", async () => {
  const provider: GatewayProvider = {
    id: "d",
    name: "D",
    upstreamKind: "responses",
    baseUrl: "https://example.test",
    apiKey: "test",
    upstreamModelId: "m",
    models: ["m"],
    modelContextTokens: { m: 262_144 },
  };
  let generations = 0;
  for (const tokens of [100, 243_181]) {
    const fetcher = withDynamicOutputBudget(
      async () => {
        generations++;
        return Response.json({});
      },
      { provider, upstreamKind: "responses", upstreamModelId: "m", requestedModel: "m" },
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        countInputTokens: async () => ({ tokens, precision: "heuristic", source: "legacy-estimate" }),
      },
      new AbortController().signal,
      () => {},
    );
    const response = await fetcher("https://example.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", input: "hi" }),
    });
    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("dynamic_output_budget_error");
    expect(error.message).toContain("不支持本地估算");
    expect(error.code).not.toBe("context_length_exceeded");
  }
  expect(generations).toBe(0);
});

test("dynamic rejects exhausted windows and counter failures without sending generation", async () => {
  const provider: GatewayProvider = {
    id: "d",
    name: "D",
    upstreamKind: "responses",
    baseUrl: "https://example.test",
    apiKey: "test",
    upstreamModelId: "m",
    models: ["m"],
    modelContextTokens: { m: 32_768 },
  };
  const route = { provider, upstreamKind: "responses" as const, requestedModel: "m", upstreamModelId: "m" };
  let generations = 0;
  const fetcher: typeof fetch = async () => {
    generations++;
    return Response.json({});
  };
  for (const tokens of [31_744, 32_767, 32_768, -1, NaN, 0.5]) {
    const budgeted = withDynamicOutputBudget(
      fetcher,
      route,
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        countInputTokens: async () => ({ tokens, precision: "provider_exact", source: "test:input" }),
      },
      new AbortController().signal,
      () => {},
    );
    const response = await budgeted("https://example.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", input: "hi" }),
    });
    expect(response.status).toBe(400);
    const error = await response.json();
    expect(error.error.code).toBe(
      tokens >= 31_744 ? "context_length_exceeded" : "dynamic_output_budget_error",
    );
  }
  for (const countInputTokens of [
    undefined,
    async () => {
      throw new Error("Count endpoint HTTP 404");
    },
  ]) {
    const budgeted = withDynamicOutputBudget(
      fetcher,
      route,
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        ...(countInputTokens && { countInputTokens }),
      },
      new AbortController().signal,
      () => {},
    );
    const response = await budgeted("https://example.test/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: "m", input: "hi" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain(
      countInputTokens ? "HTTP 404" : "input token counter",
    );
  }
  expect(generations).toBe(0);
});

test("dynamic recounts the rectified thinking payload before retry", async () => {
  const { fetchWithThinkingRectifiers } = await import("../src/upstream/anthropic-messages.js");
  const provider: GatewayProvider = {
    id: "d",
    name: "D",
    upstreamKind: "anthropic-messages",
    baseUrl: "https://example.test",
    apiKey: "test",
    upstreamModelId: "m",
    models: ["m"],
    modelMaxOutputTokens: { m: 64_000 },
    modelContextTokens: { m: 32_768 },
  };
  const route = {
    provider,
    upstreamKind: "anthropic-messages" as const,
    requestedModel: "m",
    upstreamModelId: "m",
  };
  const counts: number[] = [];
  const outputs: number[] = [];
  const fetcher = withDynamicOutputBudget(
    async (_url, init) => {
      outputs.push(JSON.parse(String(init?.body)).max_tokens);
      return outputs.length === 1
        ? Response.json({ error: { message: "Invalid signature in thinking block" } }, { status: 400 })
        : Response.json({});
    },
    route,
    {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
      countInputTokens: async ({ body }) => {
        const hasThinking = JSON.stringify(body.messages).includes('"type":"thinking"');
        const tokens = hasThinking ? 1_000 : 100;
        counts.push(tokens);
        return { tokens, precision: "provider_exact", source: "test:input" };
      },
    },
    new AbortController().signal,
    () => {},
  );
  const response = await fetchWithThinkingRectifiers(
    route,
    "https://example.test/v1/messages",
    {},
    {
      model: "m",
      max_tokens: 64_000,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "old reasoning", signature: "invalid" },
            { type: "text", text: "hi" },
          ],
        },
        { role: "user", content: "next" },
      ],
    },
    fetcher,
    () => {},
  );
  expect(response.status).toBe(200);
  expect(counts).toEqual([1_000, 100]);
  expect(outputs).toEqual([30_744, 31_644]);
});

test("dynamic permits one output token, refuses insufficient thinking space, and bypasses subscription limits", async () => {
  const provider: GatewayProvider = {
    id: "d",
    name: "D",
    upstreamKind: "anthropic-messages",
    baseUrl: "https://example.test",
    apiKey: "test",
    upstreamModelId: "m",
    models: ["m"],
    modelContextTokens: { m: 32_768 },
  };
  const route = {
    provider,
    upstreamKind: "anthropic-messages" as const,
    requestedModel: "m",
    upstreamModelId: "m",
  };
  let generations = 0;
  const dynamicConfig: GatewayConfig = {
    host: "127.0.0.1",
    port: 0,
    providers: [provider],
    countInputTokens: async () => ({ tokens: 31_743, precision: "provider_exact", source: "test" }),
  };
  const fetcher = withDynamicOutputBudget(
    async (_url, init) => {
      generations++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (provider.authMethod === "chatgpt_subscription") {
        expect(body).not.toHaveProperty("max_tokens");
      } else {
        expect(body.max_tokens).toBe(1);
      }
      return Response.json({});
    },
    route,
    dynamicConfig,
    new AbortController().signal,
    () => {},
  );
  expect(
    (
      await fetcher("https://example.test/v1/messages", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [] }),
      })
    ).status,
  ).toBe(200);
  const thinking = await fetcher("https://example.test/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [], thinking: { type: "enabled", budget_tokens: 1_024 } }),
  });
  expect(thinking.status).toBe(400);
  expect((await thinking.json()).error.code).toBe("context_length_exceeded");
  provider.authMethod = "chatgpt_subscription";
  const subscriptionFetcher = withDynamicOutputBudget(
    async (_url, init) => {
      generations++;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("max_tokens");
      return Response.json({});
    },
    route,
    dynamicConfig,
    new AbortController().signal,
    () => {},
  );
  const subscription = await subscriptionFetcher("https://example.test/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  expect(subscription.status).toBe(200);
  expect(generations).toBe(2);
});

for (const [kind, field] of [
  ["anthropic-messages", "max_tokens"],
  ["responses", "max_output_tokens"],
  ["openai-chat", "max_tokens"],
  ["openai-chat", "max_completion_tokens"],
] as const) {
  test(`dynamic ${kind}/${field} replaces 32K SDK defaults and honors trusted role ceilings`, async () => {
    const provider: GatewayProvider = {
      id: "d",
      name: "D",
      upstreamKind: kind,
      baseUrl: "https://example.test",
      apiKey: "test",
      upstreamModelId: "m",
      models: ["m"],
      modelMaxOutputTokens: { m: 128_000 },
      modelContextTokens: { m: 200_000 },
    };
    const route = { provider, upstreamKind: kind, requestedModel: "m", upstreamModelId: "m" };
    const observed: number[] = [];
    let tokens = 100;
    let roleCeiling = 64_000;
    const fetcher = withDynamicOutputBudget(
      async (_url, init) => {
        observed.push(JSON.parse(String(init?.body))[field]);
        return Response.json({});
      },
      route,
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        resolveModelLimits: async () => ({ contextTokens: 200_000, maxOutputTokens: roleCeiling }),
        countInputTokens: async () => ({ tokens, precision: "provider_exact", source: "test" }),
      },
      new AbortController().signal,
      () => {},
    );
    for (const requested of [32_000, 1_600]) {
      expect(
        (
          await fetcher("https://example.test/request", {
            method: "POST",
            body: JSON.stringify({ model: "m", [field]: requested }),
          })
        ).status,
      ).toBe(200);
    }
    roleCeiling = 4_096;
    await fetcher("https://example.test/request", {
      method: "POST",
      body: JSON.stringify({ model: "m", [field]: 32_000 }),
    });
    tokens = 198_876;
    await fetcher("https://example.test/request", {
      method: "POST",
      body: JSON.stringify({ model: "m", [field]: 32_000 }),
    });
    expect(observed).toEqual([64_000, 64_000, 4_096, 100]);
  });

  for (const [scenario, window, tokens, precision, output, reserve] of [
    ["provider exact reserve", 32_768, 10_000, "provider_exact", 21_744, 1_024],
    ["tokenizer exact reserve", 32_768, 10_000, "tokenizer_exact", 21_744, 1_024],
    ["exhausted exact reserve", 32_768, 31_744, "provider_exact", 0, 1_024],
  ] as const) {
    test(`dynamic ${kind}/${field} handles ${scenario}`, async () => {
      const provider: GatewayProvider = {
        id: "d",
        name: "D",
        upstreamKind: kind,
        baseUrl: "https://example.test",
        apiKey: "test",
        upstreamModelId: "m",
        models: ["m"],
        modelMaxOutputTokens: { m: 384_000 },
        modelContextTokens: { m: 1_000_000 },
      };
      const route = { provider, upstreamKind: kind, requestedModel: "m", upstreamModelId: "m" };
      const sent: Record<string, unknown>[] = [];
      const logs: string[] = [];
      const fetcher = withDynamicOutputBudget(
        async (_url, init) => {
          sent.push(JSON.parse(String(init?.body)));
          return Response.json({});
        },
        route,
        {
          host: "127.0.0.1",
          port: 0,
          providers: [provider],
          resolveModelLimits: async () => ({ contextTokens: window }),
          countInputTokens: async () => ({ tokens, precision, source: "test:input" }),
        },
        new AbortController().signal,
        (message) => logs.push(message),
      );
      const response = await fetcher("https://example.test/request", {
        method: "POST",
        body: JSON.stringify({
          model: "m",
          [field]: 32_000,
          ...(field === "max_completion_tokens" && { max_tokens: 32_000 }),
        }),
      });
      if (output === 0) {
        expect(response.status).toBe(400);
        const error = (await response.json()).error;
        expect(error.code).toBe("context_length_exceeded");
        expect(error.message).toContain(`reserve=${reserve}`);
        expect(error.origin).toBe("eco.context_budget");
        expect(response.headers.get("x-eco-error-origin")).toBe("eco.context_budget");
        expect(logs.some((message) => message.startsWith("local context budget rejected "))).toBe(true);
        expect(sent).toHaveLength(0);
      } else {
        expect(response.status).toBe(200);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.[field]).toBe(output);
        if (field === "max_completion_tokens") expect(sent[0]?.max_tokens).toBe(output);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain(`reserve=${reserve}`);
      }
    });
  }
}
