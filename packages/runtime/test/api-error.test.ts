import { expect, test } from "bun:test";
import {
  apiErrorDedupeKey,
  formatApiErrorActivitySummary,
  formatApiErrorUserMessage,
  parseLegacyApiErrorActivityMessage,
  parseSdkApiErrorAttribute,
} from "../src/api-error";

const screenshotRaw =
  '502 {"error":{"message":"Upstream request failed","type":"upstream_error"}}event: response.failed\ndata: {"type":"response.failed","response":{"error":{"code":"upstream_error","message":"Upstream request failed"}}}';

test("parseSdkApiErrorAttribute extracts 502 upstream_error from SDK error attribute", () => {
  const parsed = parseSdkApiErrorAttribute(screenshotRaw, "eco-reviewer-61324f8113a3");
  expect(parsed).toEqual({
    model: "eco-reviewer-61324f8113a3",
    statusCode: 502,
    code: "upstream_error",
    message: "上游模型服务暂时不可用，请稍后重试或切换 Provider。",
  });
});

test("formatApiErrorActivitySummary keeps short API error prefix for logging", () => {
  const parsed = parseSdkApiErrorAttribute(screenshotRaw);
  expect(formatApiErrorActivitySummary(parsed!)).toBe(
    "API error · 502 · 上游模型服务暂时不可用，请稍后重试或切换 Provider。",
  );
});

test("parseLegacyApiErrorActivityMessage handles cleaned activity lines", () => {
  const parsed = parseLegacyApiErrorActivityMessage(
    "API error · 502 · 上游模型服务暂时不可用，请稍后重试或切换 Provider。",
  );
  expect(parsed?.statusCode).toBe(502);
  expect(parsed?.message).toContain("上游模型服务暂时不可用");
});

test("parseSdkApiErrorAttribute maps model_not_found", () => {
  const parsed = parseSdkApiErrorAttribute(
    '404 {"error":{"message":"model not found","code":"model_not_found"}}',
  );
  expect(parsed?.code).toBe("model_not_found");
  expect(formatApiErrorUserMessage(parsed!)).toBe("模型不存在或无权访问，请检查 Provider 配置与模型 ID。");
});

test("formatApiErrorUserMessage maps Codex model and policy capacity errors", () => {
  expect(
    formatApiErrorUserMessage({
      message: "model unavailable",
      codexErrorInfo: "modelNotFound",
    }),
  ).toBe("模型不存在或无权访问，请检查 Provider 配置与模型 ID。");
  expect(
    formatApiErrorUserMessage({
      message: "capacity unavailable",
      codexErrorInfo: "policyCapacityUnavailable",
    }),
  ).toBe("当前模型策略容量暂不可用，请稍后重试或切换模型。");
});

test("formatApiErrorUserMessage exposes Codex encrypted agent handoff incompatibility", () => {
  expect(
    formatApiErrorUserMessage({
      code: "upstream_error",
      statusCode: 400,
      message: "unsupported input item type: agent_message",
    }),
  ).toBe(
    "当前 Provider 不支持 Codex 子代理的加密 agent_message；请改用 PI/Claude 或支持 Codex Multi-Agent 的 Responses Provider。",
  );
  expect(
    formatApiErrorUserMessage({
      code: "invalid_request",
      statusCode: 400,
      message: "unsupported content part type: encrypted_content",
    }),
  ).toContain("Codex 子代理");
});

test("formatApiErrorUserMessage maps HTTP 529 overload structurally", () => {
  expect(
    formatApiErrorUserMessage({
      statusCode: 529,
      message: "overloaded_error: The model is overloaded",
    }),
  ).toBe("上游模型过载，请稍后重试或切换 Provider。");
  expect(
    formatApiErrorUserMessage({
      code: "overloaded_error",
      message: "anything",
    }),
  ).toBe("上游模型过载，请稍后重试或切换 Provider。");
  expect(
    formatApiErrorUserMessage({
      message: "Our servers are currently overloaded. Please try again later.",
    }),
  ).toBe("上游模型过载，请稍后重试或切换 Provider。");
});

test("parseSdkApiErrorAttribute maps leading 529 status", () => {
  const parsed = parseSdkApiErrorAttribute(
    '529 {"error":{"message":"Overloaded","type":"overloaded_error"}}',
  );
  expect(parsed?.statusCode).toBe(529);
  expect(parsed?.message).toBe("上游模型过载，请稍后重试或切换 Provider。");
});

test("parseSdkApiErrorAttribute keeps text that surrounds a JSON blob without error fields", () => {
  // Internal integrity errors embed JSON in the middle of the sentence. Only the
  // text after the first blob used to survive, so the Feed showed a fragment.
  const conflict =
    'Message message_user_c8be0859 history target changed (existing={"activityLineId":"user:c3a73dc6","userMessageId":"c3a73dc6"}, attempted={"activityLineId":"sdk:efa57c6c","userMessageId":"efa57c6c"}, eventId=provider_history_target_635c1aa2, seq=4941).';
  const parsed = parseSdkApiErrorAttribute(conflict);
  expect(parsed?.message).toBe(conflict);
  expect(parsed?.statusCode).toBeUndefined();
  expect(parsed?.code).toBeUndefined();
});

test("apiErrorDedupeKey collapses identical failures", () => {
  const first = parseSdkApiErrorAttribute(screenshotRaw, "eco-reviewer");
  const second = parseSdkApiErrorAttribute(screenshotRaw, "eco-reviewer");
  expect(apiErrorDedupeKey(first!)).toBe(apiErrorDedupeKey(second!));
});
