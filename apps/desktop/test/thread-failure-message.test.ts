import { expect, test } from "bun:test";
import { formatUserFacingRequestError } from "../src/main/request-retry";
import {
  buildPlanExecutionFailureMessage,
  extractPlanFailureMessage,
  persistThreadSummaryMessage,
  planDelegationFailurePrefix,
  planExecutionFailurePrefix,
  resolveThreadMessageFromLiveEvent,
  shouldUpdateThreadSummaryFromLiveEvent,
} from "../src/shared/thread-failure-message";

test("resolveThreadMessageFromLiveEvent rebuilds execution failure message", () => {
  expect(resolveThreadMessageFromLiveEvent("thread.execution_failed", "fetch failed")).toBe(
    `${planExecutionFailurePrefix}fetch failed`,
  );
});

test("resolveThreadMessageFromLiveEvent keeps only error summaries", () => {
  expect(resolveThreadMessageFromLiveEvent("thread.failed", "上游超时")).toBe("上游超时");
  expect(resolveThreadMessageFromLiveEvent("thread.blocked", "本地模型路由未配置")).toBe(
    "本地模型路由未配置",
  );
  expect(
    resolveThreadMessageFromLiveEvent("thread.awaiting_plan", `${planExecutionFailurePrefix}模型超时`),
  ).toBe(`${planExecutionFailurePrefix}模型超时`);
  expect(resolveThreadMessageFromLiveEvent("thread.awaiting_plan", "等待你确认计划。")).toBe("");
  expect(resolveThreadMessageFromLiveEvent("thread.running", "等待工具权限确认…")).toBe("");
  expect(resolveThreadMessageFromLiveEvent("thread.unstarted_turn_discarded", "Cursor 会话未启动")).toBe(
    "Cursor 会话未启动",
  );
  expect(resolveThreadMessageFromLiveEvent("thread.completed", "回答完成。")).toBe("");
  expect(resolveThreadMessageFromLiveEvent("thread.idle", "已停止。")).toBe("");
});

test("persistThreadSummaryMessage keeps only failed blocked and plan execution errors", () => {
  expect(persistThreadSummaryMessage("failed", "上游超时")).toBe("上游超时");
  expect(persistThreadSummaryMessage("blocked", "编排未配置")).toBe("编排未配置");
  expect(persistThreadSummaryMessage("awaiting_plan", `${planExecutionFailurePrefix}模型超时`)).toBe(
    `${planExecutionFailurePrefix}模型超时`,
  );
  expect(persistThreadSummaryMessage("awaiting_plan", "计划已提交，等待你确认。")).toBe("");
  expect(persistThreadSummaryMessage("running", "等待你的回答…")).toBe("");
  expect(persistThreadSummaryMessage("completed", "回答完成。")).toBe("");
  expect(persistThreadSummaryMessage("idle", "续聊已结束。")).toBe("");
});

test("extractPlanFailureMessage reads detail after execution failure event handling", () => {
  const message = resolveThreadMessageFromLiveEvent("thread.execution_failed", "fetch failed");
  expect(extractPlanFailureMessage(message)).toBe("fetch failed");
});

test("buildPlanExecutionFailureMessage preserves backend wording", () => {
  expect(buildPlanExecutionFailureMessage("network timeout")).toBe(
    `${planExecutionFailurePrefix}network timeout`,
  );
});

test("formatUserFacingRequestError translates fetch failed", () => {
  expect(formatUserFacingRequestError("fetch failed")).toContain("上游模型 API");
});

test("execution failure roundtrip keeps plan approval error visible", () => {
  const detail = formatUserFacingRequestError("fetch failed");
  const message = buildPlanExecutionFailureMessage(detail);
  expect(extractPlanFailureMessage(message)).toBe(detail);
});

test("delegation failure survives persistence and live updates without claiming a rollback", () => {
  const message = `${planDelegationFailurePrefix}子代理 HTTP 400`;
  expect(persistThreadSummaryMessage("awaiting_plan", message)).toBe(message);
  expect(resolveThreadMessageFromLiveEvent("thread.awaiting_plan", message)).toBe(message);
  expect(extractPlanFailureMessage(message)).toBe("子代理 HTTP 400");
});

test("shouldUpdateThreadSummaryFromLiveEvent ignores worktree cleanup notices", () => {
  expect(shouldUpdateThreadSummaryFromLiveEvent("worktree.removed")).toBe(false);
  expect(shouldUpdateThreadSummaryFromLiveEvent("thread.failed")).toBe(true);
});

test("shouldUpdateThreadSummaryFromLiveEvent ignores context and usage telemetry", () => {
  expect(shouldUpdateThreadSummaryFromLiveEvent("thread.context_updated")).toBe(false);
  expect(shouldUpdateThreadSummaryFromLiveEvent("thread.usage_updated")).toBe(false);
  expect(shouldUpdateThreadSummaryFromLiveEvent("thread.runtime_config_updated")).toBe(false);
  expect(shouldUpdateThreadSummaryFromLiveEvent("thread.session_captured")).toBe(false);
  expect(shouldUpdateThreadSummaryFromLiveEvent("thread.follow_up_queue_paused")).toBe(false);
  expect(shouldUpdateThreadSummaryFromLiveEvent("thread.follow_up_queue_resumed")).toBe(false);
});

test("formatUserFacingRequestError translates structured upstream 502 failures", () => {
  const raw =
    'API error (eco-reviewer-1): 502 {"error":{"message":"Upstream request failed","type":"upstream_error"}}';
  expect(formatUserFacingRequestError(raw)).toBe("上游模型服务暂时不可用，请稍后重试或切换 Provider。");
});

test("formatUserFacingRequestError surfaces local route misses as SDK model leaks", () => {
  const raw = '{"error":"No provider route configured for model claude-haiku-4-5-20251001."}';
  expect(formatUserFacingRequestError(raw)).toBe(
    "本地模型路由未配置 SDK 请求的模型 claude-haiku-4-5-20251001。这不是当前子代理编排配置的成功匹配；若再次出现，说明仍有 SDK 路径绕过了 Eco 子代理定义。",
  );
});
