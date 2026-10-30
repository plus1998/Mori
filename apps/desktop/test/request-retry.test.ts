import { expect, test } from "bun:test";
import { formatUserFacingRequestError, isQuotaOrRateLimitFailure } from "../src/main/request-retry";
import { isRetriableProviderExhaustionMessage } from "../src/shared/request-errors";

test("detects quota and rate limit failures", () => {
  expect(isQuotaOrRateLimitFailure("HTTP 429 Too Many Requests")).toBe(true);
  expect(isQuotaOrRateLimitFailure("rate limit exceeded")).toBe(true);
  expect(isQuotaOrRateLimitFailure("fetch failed")).toBe(false);
});

test("detects Cursor RetriableError / resource_exhausted envelopes", () => {
  expect(isRetriableProviderExhaustionMessage("Error: RetriableError: [resource_exhausted] Error")).toBe(
    true,
  );
  expect(isRetriableProviderExhaustionMessage("ConnectError: [resource_exhausted] Error")).toBe(true);
  expect(isRetriableProviderExhaustionMessage("Working on your request.")).toBe(false);
});

test("formatUserFacingRequestError maps Cursor RetriableError envelopes", () => {
  expect(formatUserFacingRequestError("Error: RetriableError: [resource_exhausted] Error")).toBe(
    "上游模型暂时过载或连接中断，请稍后重试。",
  );
});

test("formatUserFacingRequestError translates fetch failed", () => {
  expect(formatUserFacingRequestError("fetch failed")).toContain("上游模型 API");
});

test("formatUserFacingRequestError translates structured upstream 502 failures", () => {
  const raw =
    'API error (eco-reviewer-1): 502 {"error":{"message":"Upstream request failed","type":"upstream_error"}}';
  expect(formatUserFacingRequestError(raw)).toBe("上游模型服务暂时不可用，请稍后重试或切换 Provider。");
});

test("formatUserFacingRequestError maps raw OpenAI overloaded text", () => {
  expect(formatUserFacingRequestError("Our servers are currently overloaded. Please try again later.")).toBe(
    "上游模型过载，请稍后重试或切换 Provider。",
  );
});

test("formatUserFacingRequestError surfaces local route misses as SDK model leaks", () => {
  const raw = '{"error":"No provider route configured for model claude-haiku-4-5-20251001."}';
  expect(formatUserFacingRequestError(raw)).toBe(
    "本地模型路由未配置 SDK 请求的模型 claude-haiku-4-5-20251001。这不是当前子代理编排配置的成功匹配；若再次出现，说明仍有 SDK 路径绕过了 Mori 子代理定义。",
  );
});
