import { expect, test } from "bun:test";
import type { GatewayProvider } from "@eco/gateway";
import { InputTokenCountTransportError } from "@eco/shared";
import { withDynamicOutputBudget } from "../../gateway/src/model-output-limit";
import { fetchUpstreamWithRetry } from "../../gateway/src/upstream/fetch-with-retry";
import type { ProviderConfigSecret } from "../src/main/provider-store";
import { countGatewayInputTokens, countProviderInputTokens } from "../src/main/provider-token-counter";

const provider: GatewayProvider = {
  id: "test-counter",
  name: "Counter",
  baseUrl: "https://counter.test",
  apiKey: "test",
  upstreamKind: "responses",
  upstreamModelId: "deepseek-flash",
  models: ["deepseek-flash"],
  modelContextTokens: { "deepseek-flash": 262_144 },
};
const route = {
  provider,
  upstreamKind: "responses" as const,
  upstreamModelId: "deepseek-flash",
  requestedModel: "candidate-test",
};
const endpoint = "https://counter.test/v1/responses";
const body = JSON.stringify({ model: "deepseek-flash", input: [] });

// Exercise the actual counter → dynamic wrapper → same-route retry chain.
for (const failure of ["transient", "persistent", "bad-request"] as const) {
  test(`dynamic count ${failure} failure retains its semantics through retries`, async () => {
    let counts = 0;
    let generations = 0;
    const controller = new AbortController();
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith("/input_tokens")) {
        counts++;
        if (failure === "bad-request")
          return Response.json({ error: { message: "invalid input" } }, { status: 400 });
        if (failure === "persistent" || counts === 1) throw new TypeError("fetch failed");
        return Response.json({ input_tokens: 10_000 });
      }
      generations++;
      expect(JSON.parse(String(init?.body)).max_output_tokens).toBe(262_144 - 10_000 - 1_024);
      return Response.json({ output: "OK" });
    };
    const budgeted = withDynamicOutputBudget(
      fetcher,
      route,
      {
        host: "127.0.0.1",
        port: 0,
        providers: [provider],
        countInputTokens: countGatewayInputTokens,
      },
      controller.signal,
      () => {},
    );
    const response = await fetchUpstreamWithRetry({
      fetchImpl: budgeted,
      url: endpoint,
      init: { method: "POST", body },
      signal: controller.signal,
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      onLog: () => {},
    });
    if (failure === "transient") {
      expect(response.status).toBe(200);
      expect(counts).toBe(2);
      expect(generations).toBe(1);
    } else {
      expect(response.status).toBe(failure === "persistent" ? 502 : 400);
      expect(counts).toBe(failure === "persistent" ? 3 : 1);
      expect(generations).toBe(0);
      const payload = await response.json();
      expect(payload.error.code).toBe(
        failure === "persistent" ? "input_token_count_transport_error" : "input_token_count_upstream_error",
      );
      if (failure === "persistent") expect(payload.error.countUrl).toBe(`${endpoint}/input_tokens`);
    }
  });
}

test("SDK count timeout is a 504 transport failure at the counter URL", async () => {
  const secretProvider: ProviderConfigSecret = {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    requestPath: "",
    version: "v1",
    apiKey: "test",
    apiCompat: "openai_responses",
    enabled: true,
    hasApiKey: true,
    defaultModel: "deepseek-flash",
    createdAt: "",
    updatedAt: "",
  };
  let caught: unknown;
  try {
    await countProviderInputTokens({
      mode: "provider_native",
      provider: secretProvider,
      modelId: "deepseek-flash",
      anthropicBody: { model: "deepseek-flash", messages: [] },
      timeoutMs: 5,
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InputTokenCountTransportError);
  expect(caught).toMatchObject({ statusCode: 504, url: `${endpoint}/input_tokens` });
  const budgeted = withDynamicOutputBudget(
    async () => {
      throw new Error("Generation must not run");
    },
    route,
    {
      host: "127.0.0.1",
      port: 0,
      providers: [provider],
      countInputTokens: async () => {
        throw caught;
      },
    },
    new AbortController().signal,
    () => {},
  );
  expect((await budgeted(endpoint, { method: "POST", body })).status).toBe(504);
});

test("cancelled dynamic counting propagates cancellation without retries or generation", async () => {
  const controller = new AbortController();
  const reason = new DOMException("Cancelled by reader", "AbortError");
  let counts = 0;
  let generations = 0;
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith("/input_tokens")) {
      counts++;
      controller.abort(reason);
      throw reason;
    }
    generations++;
    return Response.json({});
  };
  const budgeted = withDynamicOutputBudget(
    fetcher,
    route,
    { host: "127.0.0.1", port: 0, providers: [provider], countInputTokens: countGatewayInputTokens },
    controller.signal,
    () => {},
  );
  await expect(
    fetchUpstreamWithRetry({
      fetchImpl: budgeted,
      url: endpoint,
      init: { method: "POST", body },
      signal: controller.signal,
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
    }),
  ).rejects.toBe(reason);
  expect(counts).toBe(1);
  expect(generations).toBe(0);
});
