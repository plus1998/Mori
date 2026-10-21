import { expect, test } from "bun:test";
import { resolvePiUsageBilling } from "../src/main/pi-usage-billing";

test("resolvePiUsageBilling rejects non-pi payloads", async () => {
  const result = await resolvePiUsageBilling({
    threadId: "thr1",
    eventId: "e1",
    payload: { source: "sdk", usage: { input_tokens: 1 } },
    runtimeRoutes: [],
    lookupPricing: async () => null,
  });
  expect(result.status).toBe("rejected");
  if (result.status === "rejected") {
    expect(result.reason).toBe("not_pi_usage");
  }
});

test("resolvePiUsageBilling builds pi-sourced ledger artifacts", async () => {
  const result = await resolvePiUsageBilling({
    threadId: "thr1",
    eventId: "e1",
    payload: {
      source: "pi",
      model: "eco_planner__p__m",
      usage: {
        input_tokens: 12,
        output_tokens: 4,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.001,
    },
    runtimeRoutes: [
      {
        role: "main",
        provider: {
          id: "p",
          name: "P",
          enabled: true,
          baseUrl: "https://example.com",
          apiKey: "k",
          apiCompat: "anthropic",
        },
        modelId: "m",
      },
    ],
    lookupPricing: async () => null,
  });
  expect(result.status).toBe("resolved");
  if (result.status === "resolved") {
    expect(result.artifacts.source).toBe("pi");
    expect(result.artifacts.ledgerEvent.source).toBe("pi");
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(4);
    expect(result.contextOccupied).toBe(12);
  }
});
