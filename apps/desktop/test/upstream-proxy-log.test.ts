import { expect, test } from "bun:test";
import {
  buildProtocolSummary,
  buildProtocolSummaryForCall,
  debugBodyFromRaw,
  flushCountTokensProxyLogBurst,
  formatUpstreamProxyCallLog,
  isUpstreamLogVerbose,
  logUpstreamProxyCall,
  resolveProxyOperation,
  tokensFromUsage,
} from "../src/main/upstream-proxy-log";

test("buildProtocolSummary for anthropic bridge", () => {
  const summary = buildProtocolSummary("anthropic", true);
  expect(summary.converted).toBe(false);
  expect(summary.upstream).toBe("anthropic");
  expect(summary.path).toBe("anthropic → anthropic → anthropic-sse");
});

test("buildProtocolSummary for openai responses bridge", () => {
  const summary = buildProtocolSummary("openai_responses", false);
  expect(summary.converted).toBe(true);
  expect(summary.path).toBe("anthropic → openai-responses → anthropic-json");
});

test("buildProtocolSummary for openai chat completions bridge", () => {
  const summary = buildProtocolSummary("openai_chat_completions", true);
  expect(summary.path).toBe("anthropic → openai-chat-completions → anthropic-sse");
});

test("buildProtocolSummaryForCall describes count_tokens bridge on openai compat", () => {
  const summary = buildProtocolSummaryForCall({
    apiCompat: "openai_responses",
    stream: false,
    operation: "count_tokens",
    converted: true,
  });
  expect(summary.converted).toBe(true);
  expect(summary.path).toContain("input_tokens");
});

test("buildProtocolSummaryForCall describes count_tokens passthrough on anthropic", () => {
  const summary = buildProtocolSummaryForCall({
    apiCompat: "anthropic",
    stream: false,
    operation: "count_tokens",
    converted: false,
  });
  expect(summary.converted).toBe(false);
  expect(summary.path).toContain("anthropic-count");
  expect(summary.path).not.toContain("responses-ir");
});

test("resolveProxyOperation detects count_tokens path", () => {
  expect(resolveProxyOperation("/v1/messages/count_tokens")).toBe("count_tokens");
  expect(resolveProxyOperation("/v1/messages")).toBe("messages");
  expect(resolveProxyOperation("/v1/messages")).toBe("messages");
});

test("tokensFromUsage maps runtime usage fields", () => {
  expect(
    tokensFromUsage({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    }),
  ).toEqual({
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheCreation: 1,
  });
});

test("formatUpstreamProxyCallLog renders human-readable multiline text", () => {
  const text = formatUpstreamProxyCallLog({
    at: "2026-06-03T00:00:00.000Z",
    ok: true,
    elapsedMs: 120,
    role: "main",
    provider: { id: "p1", name: "Provider" },
    model: { sdk: "eco-planner-x", upstream: "claude-sonnet-4", alias: "eco-planner-x" },
    operation: "messages",
    clientPath: "/v1/messages",
    upstreamUrl: "https://api.example.com/v1/responses",
    protocol: buildProtocolSummary("anthropic", true),
    http: { status: 200, streaming: true },
    tokens: { input: 100, output: 20, cacheRead: 0, cacheCreation: 0 },
    billing: {
      ecoCostUsd: 0.01,
      plannerTokenCostUsd: 0.02,
      savedUsd: 0.01,
      sourceReportedCostUsd: 0,
    },
  });

  expect(text).toContain("proxy-call 成功");
  expect(text).toContain("角色 main");
  expect(text).toContain("提供商 Provider");
  expect(text).toContain("SDK eco-planner-x");
  expect(text).toContain("上游 claude-sonnet-4");
  expect(text).toContain("Token");
  expect(text).toContain("计费");
  expect(text).toContain("类型 对话");
  expect(text).toContain("地址 SDK");
});

test("formatUpstreamProxyCallLog includes debug sections on failure", () => {
  const text = formatUpstreamProxyCallLog({
    at: "2026-06-03T00:00:00.000Z",
    ok: false,
    elapsedMs: 50,
    role: "coder",
    provider: { id: "p1", name: "P" },
    model: { upstream: "gpt-4", alias: "eco-coder-x" },
    operation: "count_tokens",
    clientPath: "/v1/messages/count_tokens",
    upstreamUrl: "https://api.example.com/v1/messages/count_tokens",
    protocol: buildProtocolSummaryForCall({
      apiCompat: "openai_responses",
      stream: false,
      operation: "count_tokens",
      converted: false,
    }),
    http: { status: 404, streaming: false },
    error: "Not Found",
    debug: {
      clientRequest: { model: "gpt-4", messages: [] },
      upstreamRequest: { model: "gpt-4", messages: [] },
      responseBody: { error: { message: "Token counting is not supported" } },
    },
  });

  expect(text).toContain("失败");
  expect(text).toContain("计 Token");
  expect(text).toContain("错误 Not Found");
  expect(text).toContain("提示");
  expect(text).toContain("SDK 请求体");
  expect(text).toContain("实际上游请求体");
  expect(text).toContain("上游响应");
  expect(text).toContain("Token counting");
});

test("logUpstreamProxyCall writes formatted text to stderr", () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;

  try {
    logUpstreamProxyCall({
      at: "2026-06-03T00:00:00.000Z",
      ok: true,
      elapsedMs: 120,
      role: "main",
      provider: { id: "p1", name: "Provider" },
      model: { upstream: "claude-sonnet-4", alias: "eco-planner-x" },
      operation: "messages",
      clientPath: "/v1/messages",
      upstreamUrl: "https://api.example.com/v1/messages",
      protocol: buildProtocolSummary("anthropic", true),
      http: { status: 200, streaming: true },
    });
  } finally {
    process.stderr.write = originalWrite;
  }

  const text = chunks.join("");
  expect(text).toContain("[eco-upstream] proxy-call 成功");
  expect(text).toContain("  角色 main");
});

test("debugBodyFromRaw parses JSON or truncates text", () => {
  expect(debugBodyFromRaw('{"a":1}')).toEqual({ a: 1 });
  const long = "x".repeat(20_000);
  const truncated = debugBodyFromRaw(long);
  expect(typeof truncated).toBe("string");
  expect(String(truncated)).toContain("[truncated");
});

test("logUpstreamProxyCall batches count_tokens into one line unless verbose", () => {
  const prevVerbose = process.env.ECO_UPSTREAM_LOG_VERBOSE;
  process.env.ECO_UPSTREAM_LOG_VERBOSE = "0";
  const originalWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;

  const stub = {
    at: "2026-06-03T00:00:00.000Z",
    ok: true,
    elapsedMs: 0,
    role: "main",
    provider: { id: "p1", name: "Provider" },
    model: { upstream: "claude-sonnet-4", alias: "eco-planner-x" },
    operation: "count_tokens" as const,
    clientPath: "/v1/messages/count_tokens",
    upstreamUrl: "eco://local/count_tokens-stub",
    protocol: buildProtocolSummaryForCall({
      apiCompat: "anthropic",
      stream: false,
      operation: "count_tokens",
      converted: false,
    }),
    http: { status: 200, streaming: false },
    tokens: { input: 99_000, output: 0, cacheRead: 0, cacheCreation: 0 },
  };

  try {
    logUpstreamProxyCall(stub);
    logUpstreamProxyCall(stub);
    logUpstreamProxyCall(stub);
    flushCountTokensProxyLogBurst();
  } finally {
    process.stderr.write = originalWrite;
    process.env.ECO_UPSTREAM_LOG_VERBOSE = prevVerbose;
  }

  const text = chunks.join("");
  expect(text).not.toContain("proxy-call 成功 0ms");
  expect(text).toContain("count_tokens-stub ×3");
  expect(text).toContain("role=main");
  expect(text).toContain("99k");
});

test("isUpstreamLogVerbose respects ECO_UPSTREAM_LOG_VERBOSE", () => {
  const previous = process.env.ECO_UPSTREAM_LOG_VERBOSE;
  process.env.ECO_UPSTREAM_LOG_VERBOSE = "1";
  expect(isUpstreamLogVerbose()).toBe(true);
  process.env.ECO_UPSTREAM_LOG_VERBOSE = "0";
  expect(isUpstreamLogVerbose()).toBe(false);
  if (previous === undefined) {
    delete process.env.ECO_UPSTREAM_LOG_VERBOSE;
  } else {
    process.env.ECO_UPSTREAM_LOG_VERBOSE = previous;
  }
});
