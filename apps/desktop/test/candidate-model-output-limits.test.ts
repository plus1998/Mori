import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startEcoGateway } from "@eco/gateway";
import type { GlobalMaxOutputTokens } from "@eco/runtime";
import { resolveCandidateModelRequestRouteWithLimits } from "../src/main/candidate-model-request-route";
import { createEcoSdkBridgeHandler } from "../src/main/eco-sdk-bridge";
import { ModelsDevPricingCache } from "../src/main/models-dev-pricing-cache";
import { createProviderStore } from "../src/main/provider-store";
import { removeTempDirectory } from "./helpers/temp-directory";

async function withCandidate(
  manual: { contextTokens?: number; maxOutputTokens?: number },
  run: (input: {
    store: Awaited<ReturnType<typeof createProviderStore>>;
    candidateId: string;
    pricingCache: ModelsDevPricingCache;
  }) => Promise<void>,
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eco-candidate-budget-"));
  try {
    const store = await createProviderStore(path.join(dir, "eco.sqlite"));
    const provider = store.saveProvider({
      name: "Budget test",
      baseUrl: "https://budget.test",
      apiCompat: "openai_responses",
      apiKey: "test",
      defaultModel: "deepseek-flash",
      enabled: true,
    });
    const candidate = store.saveCandidateModel({
      providerId: provider.id,
      modelId: "deepseek-flash",
      manualSpec: manual,
      modelsDevMapping: { providerKey: "deepseek", modelId: "deepseek-flash" },
    });
    const cachePath = path.join(dir, "catalog.json");
    await fs.writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        catalog: {
          deepseek: {
            id: "deepseek",
            models: {
              "deepseek-flash": {
                id: "deepseek-flash",
                limit: { context: 262_144, output: 65_536 },
              },
            },
          },
        },
      }),
    );
    const pricingCache = new ModelsDevPricingCache({
      cachePath,
      fetchImpl: async () => {
        throw new Error("This regression must not access the network");
      },
    });
    await run({ store, candidateId: candidate.id, pricingCache });
  } finally {
    await removeTempDirectory(dir);
  }
}

test.each([
  {
    name: "reported DeepSeek manual limits",
    manual: { contextTokens: 262_144, maxOutputTokens: 384_000 },
    context: 524_288,
    output: "dynamic",
    expectedWindow: 262_144,
    expectedOutput: 262_143,
  },
  {
    name: "global context cap",
    manual: { contextTokens: 262_144, maxOutputTokens: 384_000 },
    context: 131_072,
    output: "dynamic",
    expectedWindow: 131_072,
    expectedOutput: 131_071,
  },
  {
    name: "smaller model output cap",
    manual: { contextTokens: 262_144, maxOutputTokens: 8_192 },
    context: 524_288,
    output: "dynamic",
    expectedWindow: 262_144,
    expectedOutput: 8_192,
  },
  {
    name: "catalog-resolved limits",
    manual: {},
    context: 524_288,
    output: "dynamic",
    expectedWindow: 262_144,
    expectedOutput: 65_536,
  },
  {
    name: "fixed output with a smaller context",
    manual: { contextTokens: 32_768, maxOutputTokens: 384_000 },
    context: 524_288,
    output: 65_536,
    expectedWindow: 32_768,
    expectedOutput: 32_767,
  },
])("candidate request budgets share resolved context: $name", async (entry) => {
  await withCandidate(entry.manual, async ({ store, candidateId, pricingCache }) => {
    const { gatewayProvider } = await resolveCandidateModelRequestRouteWithLimits(store, candidateId, {
      pricingCache,
      contextWindowLimitTokens: entry.context,
      maxOutputLimitTokens: entry.output as GlobalMaxOutputTokens,
    });
    expect(gatewayProvider.modelMaxOutputTokens).toEqual({ "deepseek-flash": entry.expectedOutput });
    expect(gatewayProvider.modelContextTokens).toEqual(
      entry.output === "dynamic" ? { "deepseek-flash": entry.expectedWindow } : undefined,
    );
  });
});

test("candidate-ID bridge dispatches dynamic output using final input tokens", async () => {
  await withCandidate(
    { contextTokens: 262_144, maxOutputTokens: 384_000 },
    async ({ store, candidateId, pricingCache }) => {
      const bodies: Record<string, unknown>[] = [];
      let counts = 0;
      const gateway = await startEcoGateway(
        {
          host: "127.0.0.1",
          port: 0,
          providers: [],
          countInputTokens: async () => {
            counts++;
            return { tokens: 8_192, precision: "provider_exact", source: "test:final-wire" };
          },
        },
        {
          embedded: true,
          onLog: () => {},
          fetchImpl: async (_url, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return Response.json({
              id: "resp_test",
              object: "response",
              model: "deepseek-flash",
              status: "completed",
              output: [],
              usage: { input_tokens: 8_192, output_tokens: 1 },
            });
          },
        },
      );
      try {
        const bridge = createEcoSdkBridgeHandler({
          gateway,
          onLog: () => {},
          resolveCandidateModel: (id) =>
            resolveCandidateModelRequestRouteWithLimits(store, id, {
              pricingCache,
              contextWindowLimitTokens: 524_288,
              maxOutputLimitTokens: "dynamic",
            }),
        });
        const response = await bridge(
          new Request("http://localhost/v1/responses", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: candidateId, input: "Hi", max_output_tokens: 16 }),
          }),
        );
        expect(response.status).toBe(200);
        await response.text();
        expect(counts).toBe(1);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({
          model: "deepseek-flash",
          max_output_tokens: 262_144 - 8_192 - 1_024,
        });
      } finally {
        gateway.stop();
      }
    },
  );
});
