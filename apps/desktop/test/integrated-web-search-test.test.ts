import { afterEach, expect, test } from "bun:test";
import { testIntegratedWebSearch } from "../src/main/integrated-web-search-test";
import type { IntegratedWebSearchProvider } from "../src/shared/ipc";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function store(provider: IntegratedWebSearchProvider, apiKey: string | undefined = "saved-key") {
  return {
    get: () => ({ provider, enabled: true, hasApiKey: Boolean(apiKey), approvalMode: "always_allow" as const }),
    getApiKey: () => apiKey,
  };
}

const result = { title: "Example", url: "https://example.com", description: "Search content" };

for (const provider of ["tavily", "doubao", "deepseek", "brave"] as const) {
  test(`settings test performs a real ${provider} search with the saved key`, async () => {
    globalThis.fetch = (async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      if (provider === "brave") {
        expect(headers["X-Subscription-Token"]).toBe("saved-key");
        const url = new URL(String(input));
        expect(url.hostname).toBe("api.search.brave.com");
        expect(url.searchParams.get("q")).toBe("test query");
        expect(url.searchParams.get("count")).toBe("3");
      } else {
        expect(headers.Authorization).toBe("Bearer saved-key");
        const body = JSON.parse(String(init?.body));
        expect(body.Query ?? body.query).toBe("test query");
        expect(body.DocCount ?? body.max_results ?? body.count).toBe(3);
      }
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const payload = provider === "doubao"
        ? { Result: { Documents: [{ Title: result.title, Url: result.url, Snippet: [{ Type: "text", Text: result.description }] }] } }
        : provider === "brave"
          ? { web: { results: [result] } }
          : { results: [{ ...result, content: result.description, summary: result.description }] };
      return Response.json(payload);
    }) as typeof fetch;
    const response = await testIntegratedWebSearch({ provider, query: " test query " }, store(provider));
    expect(response.results).toEqual([result]);
    expect(response.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(response)).not.toContain("saved-key");
  });
}

test("settings test rejects invalid input, changed providers and missing keys before fetching", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const input of [null, {}, { provider: "unknown", query: "hello" }, { provider: "tavily", query: " " }, { provider: "tavily", query: "a".repeat(129) }]) {
    await expect(testIntegratedWebSearch(input, store("tavily"))).rejects.toThrow("Invalid web search test");
  }
  await expect(testIntegratedWebSearch({ provider: "brave", query: "hello" }, store("tavily")))
    .rejects.toThrow("搜索供应商已变更");
  await expect(testIntegratedWebSearch({ provider: "tavily", query: "hello" }, store("tavily", "")))
    .rejects.toThrow("API Key");
  expect(calls).toBe(0);
});

test("settings test keeps empty results and provider errors distinct", async () => {
  globalThis.fetch = (async () => Response.json({ results: [] })) as typeof fetch;
  expect((await testIntegratedWebSearch({ provider: "tavily", query: "hello" }, store("tavily"))).results)
    .toEqual([]);
  globalThis.fetch = (async () => new Response("invalid API key", { status: 401 })) as typeof fetch;
  await expect(testIntegratedWebSearch({ provider: "tavily", query: "hello" }, store("tavily")))
    .rejects.toThrow("Tavily Search request failed (401): invalid API key");
});
