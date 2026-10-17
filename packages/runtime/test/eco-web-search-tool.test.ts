import { expect, test } from "bun:test";
import { parseEcoWebSearchToolOutput, readEcoWebSearchQuery } from "../src/eco-web-search-tool.ts";
import { formatIntegratedWebSearchResults } from "../src/pi-integrated-web-search.ts";

test("DeepSeek formatted search results round-trip for the conversation feed", () => {
  const results = [{ title: "DeepSeek", url: "https://example.com", description: "Long summary" }];
  const text = formatIntegratedWebSearchResults("deepseek", "DeepSeek news", results);
  expect(parseEcoWebSearchToolOutput(text)).toMatchObject({
    provider: "deepseek",
    query: "DeepSeek news",
    results,
  });
});

test("readEcoWebSearchQuery reads query from MCP args", () => {
  expect(readEcoWebSearchQuery({ query: " shanghai weather " })).toBe("shanghai weather");
  expect(readEcoWebSearchQuery({})).toBeUndefined();
});

test("parseEcoWebSearchToolOutput reads structuredContent from Codex Ok wrapper", () => {
  const parsed = parseEcoWebSearchToolOutput({
    result: {
      Ok: {
        content: [
          { type: "text", text: 'Doubao Search results for "q":\n\n1. A\n   https://a.test\n   desc' },
        ],
        structuredContent: {
          provider: "doubao",
          query: "q",
          resultCount: 1,
          results: [{ title: "A", url: "https://a.test", description: "desc" }],
        },
      },
    },
  });
  expect(parsed).toMatchObject({
    provider: "doubao",
    query: "q",
    results: [{ title: "A", url: "https://a.test", description: "desc" }],
  });
});

test("parseEcoWebSearchToolOutput parses Claude JSON tool_result content", () => {
  const parsed = parseEcoWebSearchToolOutput(
    JSON.stringify({
      provider: "doubao",
      query: "current weather",
      resultCount: 2,
      results: [
        { title: "One", url: "https://one.test", description: "d1" },
        { title: "Two", url: "https://two.test", description: "d2" },
      ],
    }),
  );
  expect(parsed?.results).toHaveLength(2);
  expect(parsed?.provider).toBe("doubao");
});

test("parseEcoWebSearchToolOutput parses formatted Doubao text", () => {
  const text = [
    'Doubao Search results for "current weather in Shanghai China":',
    "",
    "1. Current Weather",
    "   https://www.accuweather.com/en/cn/shanghai/106577/current-weather/106577",
    "   Shanghai, Shanghai",
    "30°C",
    "",
    "2. Second",
    "   https://example.com/2",
    "   snippet two",
  ].join("\n");
  const parsed = parseEcoWebSearchToolOutput(text);
  expect(parsed?.provider).toBe("doubao");
  expect(parsed?.query).toBe("current weather in Shanghai China");
  expect(parsed?.results[0]?.title).toBe("Current Weather");
  expect(parsed?.results[0]?.url).toContain("accuweather.com");
  expect(parsed?.results[1]?.title).toBe("Second");
});
