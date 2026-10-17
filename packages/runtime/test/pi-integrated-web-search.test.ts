import { afterEach, expect, test } from "bun:test";
import {
  formatIntegratedWebSearchResults,
  searchDeepSeekWeb,
  searchDoubaoWeb,
  searchIntegratedWeb,
  searchTavilyWeb,
} from "../src/pi-integrated-web-search.js";
import { createPiIntegratedWebSearchExtensionFactory } from "../src/pi-integrated-web-search-factory.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("searchTavilyWeb maps Tavily results", async () => {
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Example",
            url: "https://example.com",
            content: "Snippet text",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const results = await searchTavilyWeb("weather shanghai", "tvly-test-key");
  expect(results).toEqual([{ title: "Example", url: "https://example.com", description: "Snippet text" }]);
  expect(capturedInit?.method).toBe("POST");
  const headers = capturedInit?.headers as Record<string, string> | undefined;
  expect(headers?.Authorization).toBe("Bearer tvly-test-key");
});

test("searchIntegratedWeb dispatches tavily", async () => {
  globalThis.fetch = (async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    expect(body.query).toBe("hello");
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await searchIntegratedWeb("tavily", "hello", "tvly-key");
});

test("formatIntegratedWebSearchResults labels Tavily", () => {
  const text = formatIntegratedWebSearchResults("tavily", "q", [
    { title: "A", url: "https://a.test", description: "d" },
  ]);
  expect(text).toContain("Tavily Search results");
});

test("integrated extension factory reports tavily provider in details", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        results: [{ title: "Hit", url: "https://hit.test", content: "body" }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  const tools: Array<{
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: { cwd: string },
    ) => Promise<{ details: Record<string, unknown> }>;
  }> = [];
  const factory = createPiIntegratedWebSearchExtensionFactory({
    provider: "tavily",
    apiKey: "tvly-key",
  });
  factory({
    registerTool(tool) {
      tools.push(tool);
    },
  });
  const result = await tools[0]!.execute("id", { query: "news" }, undefined, undefined, { cwd: "/" });
  expect(result.details.provider).toBe("tavily");
  expect(result.details.resultCount).toBe(1);
});

test("searchDoubaoWeb maps Global API documents", async () => {
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (_input, init) => {
    capturedInit = init;
    return new Response(
      JSON.stringify({
        Result: {
          TotalDocCount: 1,
          Documents: [
            {
              Title: "Shanghai Weather",
              Url: "https://weather.example/shanghai",
              Snippet: [{ Type: "text", Text: "Sunny, 28C" }],
            },
          ],
          ErrorCode: 0,
          ErrorMsg: "",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const results = await searchDoubaoWeb("weather shanghai", "doubao-test-key");
  expect(results).toEqual([
    {
      title: "Shanghai Weather",
      url: "https://weather.example/shanghai",
      description: "Sunny, 28C",
    },
  ]);
  expect(capturedInit?.method).toBe("POST");
  const body = capturedInit?.body ? JSON.parse(String(capturedInit.body)) : {};
  expect(body.Query).toBe("weather shanghai");
  expect(body.DocCount).toBe(5);
  const headers = capturedInit?.headers as Record<string, string> | undefined;
  expect(headers?.Authorization).toBe("Bearer doubao-test-key");
});

test("searchDoubaoWeb throws on ResponseMetadata error", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ResponseMetadata: {
          Error: { CodeN: 10406, Message: "quota exhausted" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  await expect(searchDoubaoWeb("q", "key")).rejects.toThrow(/quota exhausted/i);
});

test("searchIntegratedWeb dispatches doubao", async () => {
  globalThis.fetch = (async (_input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    expect(body.Query).toBe("hello");
    return new Response(JSON.stringify({ Result: { Documents: [], ErrorCode: 0, ErrorMsg: "" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await searchIntegratedWeb("doubao", "hello", "doubao-key");
});

test("formatIntegratedWebSearchResults labels Doubao", () => {
  const text = formatIntegratedWebSearchResults("doubao", "q", [
    { title: "A", url: "https://a.test", description: "d" },
  ]);
  expect(text).toContain("Doubao Search results");
});

test("DeepSeek dispatch preserves query operators, authenticates and uses model summaries", async () => {
  const signal = new AbortController().signal;
  globalThis.fetch = (async (input, init) => {
    expect(String(input)).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-test");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toEqual({
      query: "DeepSeek site:github.com lang:zh after:2025",
      count: 5,
      need_content: false,
    });
    return Response.json({
      results: [
        {
          title: " DeepSeek ",
          url: " https://example.com/deepseek ",
          summary: " Model-oriented summary ",
          snippet: "Short UI snippet",
          content: "",
        },
      ],
    });
  }) as typeof fetch;

  const results = await searchIntegratedWeb(
    "deepseek",
    " DeepSeek site:github.com lang:zh after:2025 ",
    " sk-test ",
    { signal },
  );
  expect(results).toEqual([
    {
      title: "DeepSeek",
      url: "https://example.com/deepseek",
      description: "Model-oriented summary",
    },
  ]);
  expect(formatIntegratedWebSearchResults("deepseek", "q", results)).toContain("DeepSeek Search results");
});

test("DeepSeek accepts 128 Unicode code points and an empty result set", async () => {
  globalThis.fetch = (async (_input, init) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({ query: "🔍".repeat(128), count: 50 });
    return Response.json({ results: [] });
  }) as typeof fetch;
  const results = await searchDeepSeekWeb("🔍".repeat(128), "key", { count: 50 });
  expect(results).toEqual([]);
  expect(formatIntegratedWebSearchResults("deepseek", "q", results)).toBe(
    'No DeepSeek Search results for "q".',
  );
});

test("DeepSeek rejects invalid requests before fetching", async () => {
  globalThis.fetch = (async () => {
    throw new Error("fetch must not be called");
  }) as typeof fetch;
  await expect(searchDeepSeekWeb("  ", "key")).rejects.toThrow("non-empty query");
  await expect(searchDeepSeekWeb("🔍".repeat(129), "key")).rejects.toThrow("128 Unicode characters");
  await expect(searchDeepSeekWeb("q", " ")).rejects.toThrow("API key is not configured");
  for (const count of [0, 51, 1.5, Number.NaN]) {
    await expect(searchDeepSeekWeb("q", "key", { count })).rejects.toThrow("integer between 1 and 50");
  }
});

test.each([401, 402, 429, 500])("DeepSeek surfaces upstream HTTP %s errors", async (status) => {
  globalThis.fetch = (async () =>
    Response.json({ error: { message: "upstream detail" } }, { status })) as typeof fetch;
  await expect(searchDeepSeekWeb("q", "key")).rejects.toThrow(`DeepSeek Search request failed (${status})`);
  await expect(searchDeepSeekWeb("q", "key")).rejects.toThrow("upstream detail");
});

test.each([
  null,
  {},
  { results: {} },
  { results: [null] },
  { results: [{ title: "A", url: "https://a.test" }] },
])("DeepSeek rejects malformed successful responses: %j", async (payload) => {
  globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
  await expect(searchDeepSeekWeb("q", "key")).rejects.toThrow("DeepSeek Search returned an invalid");
});

test("DeepSeek preserves cancellation errors", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async (_input, init) => {
    init?.signal?.throwIfAborted();
    throw new Error("expected an aborted signal");
  }) as typeof fetch;
  await expect(searchIntegratedWeb("deepseek", "q", "key", { signal: controller.signal })).rejects.toBe(
    controller.signal.reason,
  );
});
