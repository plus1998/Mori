import { expect, test } from "bun:test";
import { IntegratedWebSearchMcpGateway } from "../src/main/integrated-web-search-mcp-gateway";
import {
  ECO_WEB_SEARCH_FULL_TOOL,
  ECO_WEB_SEARCH_MCP_SERVER,
  isEcoWebSearchToolName,
} from "../src/shared/integrated-web-search";
import { resolveActionKind } from "../src/shared/feed-action-kind";
import { resolveThreadWebSearchPlan } from "../src/main/resolve-thread-web-search";

test("resolveThreadWebSearchPlan mirrors cross-core decision table", () => {
  expect(
    resolveThreadWebSearchPlan({
      networkWebSearch: true,
      plannerManualSpec: { supportsNativeWebSearch: false },
      integratedSettings: { enabled: true, provider: "tavily", hasApiKey: true, approvalMode: "always_allow" },
      integratedApiKey: "tvly-test",
    }).backend,
  ).toBe("integrated");

  // Integrated settings take priority over the per-model native default.
  expect(
    resolveThreadWebSearchPlan({
      networkWebSearch: true,
      plannerManualSpec: { supportsNativeWebSearch: true },
      integratedSettings: { enabled: true, provider: "tavily", hasApiKey: true, approvalMode: "always_allow" },
      integratedApiKey: "tvly-test",
    }).backend,
  ).toBe("integrated");

  expect(
    resolveThreadWebSearchPlan({
      networkWebSearch: true,
      plannerManualSpec: { supportsNativeWebSearch: true },
      integratedSettings: { enabled: false, provider: "tavily", hasApiKey: true, approvalMode: "always_allow" },
      integratedApiKey: "tvly-test",
    }).backend,
  ).toBe("native");

  expect(
    resolveThreadWebSearchPlan({
      networkWebSearch: false,
      plannerManualSpec: { supportsNativeWebSearch: false },
      integratedSettings: { enabled: true, provider: "tavily", hasApiKey: true, approvalMode: "always_allow" },
      integratedApiKey: "tvly-test",
    }).backend,
  ).toBe("none");
});

test("isEcoWebSearchToolName only matches eco_web_search server", () => {
  expect(isEcoWebSearchToolName(ECO_WEB_SEARCH_FULL_TOOL)).toBe(true);
  expect(isEcoWebSearchToolName("mcp__eco_web_search__search")).toBe(true);
  expect(isEcoWebSearchToolName("mcp__other__search")).toBe(false);
  expect(isEcoWebSearchToolName("search")).toBe(false);
  expect(isEcoWebSearchToolName("WebSearch")).toBe(false);
});

test("feed maps eco web search MCP tool to webSearch action", () => {
  expect(resolveActionKind({ toolName: ECO_WEB_SEARCH_FULL_TOOL }).kind).toBe("webSearch");
  expect(resolveActionKind({ toolName: "mcp__other__search" }).kind).not.toBe("webSearch");
});

test("integrated web search Codex server starts when configured", async () => {
  const gateway = new IntegratedWebSearchMcpGateway({
    store: {
      get: () => ({ enabled: true, provider: "tavily", hasApiKey: true, approvalMode: "always_allow" }),
    } as never,
    getApiKey: () => "tvly-test",
  });
  try {
    const first = await gateway.resolveGlobalCodexServer();
    const second = await gateway.resolveGlobalCodexServer();
    expect(first?.name).toBe(ECO_WEB_SEARCH_MCP_SERVER);
    expect(first?.transport).toBe("http");
    expect(first?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(first?.httpHeaders?.["X-Eco-Web-Search-Control-Secret"]).toBeTruthy();
    expect(second).toEqual(first);

    const injection = await gateway.resolveInjection({ threadId: "thread-1", sessionEnabled: true });
    expect(injection.enabled).toBe(true);
    expect(injection.autoApproveTools).toBe(true);
    expect(injection.sdkEntry).toMatchObject({
      type: "http",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
    });
    const merged = gateway.mergeIntoSdkConfig(
      { mcpServers: {}, allowedTools: [] },
      injection,
    );
    expect(merged.allowedTools).toContain(ECO_WEB_SEARCH_FULL_TOOL);
    expect(Object.keys(merged.mcpServers)).toContain(ECO_WEB_SEARCH_MCP_SERVER);
  } finally {
    await gateway.close();
  }
});

test("always_ask web search approval drops the tool from allowedTools", async () => {
  const gateway = new IntegratedWebSearchMcpGateway({
    store: {
      get: () => ({ enabled: true, provider: "tavily", hasApiKey: true, approvalMode: "always_ask" }),
    } as never,
    getApiKey: () => "tvly-test",
  });
  try {
    const injection = await gateway.resolveInjection({ threadId: "thread-1", sessionEnabled: true });
    expect(injection.enabled).toBe(true);
    expect(injection.autoApproveTools).toBe(false);
    const merged = gateway.mergeIntoSdkConfig(
      { mcpServers: {}, allowedTools: [ECO_WEB_SEARCH_FULL_TOOL] },
      injection,
    );
    expect(merged.allowedTools).not.toContain(ECO_WEB_SEARCH_FULL_TOOL);
    expect(Object.keys(merged.mcpServers)).toContain(ECO_WEB_SEARCH_MCP_SERVER);
  } finally {
    await gateway.close();
  }
});

test("DeepSeek search runs through the shared MCP gateway with structured results", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input) !== "https://api.deepseek.com/v1/tools/search") {
      return originalFetch(input, init);
    }
    upstreamCalls++;
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-test");
    expect(JSON.parse(String(init?.body)).query).toBe("DeepSeek news");
    return Response.json({
      results: [{ title: "DeepSeek", url: "https://example.com", summary: "Search summary" }],
    });
  }) as typeof fetch;
  const gateway = new IntegratedWebSearchMcpGateway({
    store: {
      get: () => ({ enabled: true, provider: "deepseek", hasApiKey: true, approvalMode: "always_allow" }),
    } as never,
    getApiKey: () => "sk-test",
  });
  try {
    const injection = await gateway.resolveInjection({ threadId: "deepseek-thread", sessionEnabled: true });
    expect(injection.promptAppend).toContain("Active search provider: DeepSeek");
    const server = injection.codexServer!;
    const response = await originalFetch(new URL("/v1/tools/call", server.url), {
      method: "POST",
      headers: { ...server.httpHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "search", arguments: { query: "DeepSeek news" } }),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result.structuredContent).toEqual({
      provider: "deepseek",
      query: "DeepSeek news",
      resultCount: 1,
      results: [{ title: "DeepSeek", url: "https://example.com", description: "Search summary" }],
    });
    expect(payload.result.content[0].text).toContain("DeepSeek Search results");
    expect(upstreamCalls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    await gateway.close();
  }
});
