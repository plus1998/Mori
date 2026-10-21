export type RequestAttemptResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      aborted?: boolean;
      interruptFailed?: boolean;
      incomplete?: boolean;
      unstarted?: boolean;
    };

import {
  formatApiErrorUserMessage,
  isAcpProviderExhaustionMessage,
  parseLegacyApiErrorActivityMessage,
  parseSdkApiErrorAttribute,
} from "@eco/runtime";

export { isQuotaOrRateLimitFailure } from "../shared/request-errors";

export function formatUserFacingRequestError(reason: string): string {
  const text = reason.trim();
  if (!text) {
    return "请求失败，请稍后重试。";
  }

  const normalized = text.toLowerCase();
  if (isAcpProviderExhaustionMessage(text)) {
    return "上游模型暂时过载或连接中断，请稍后重试。";
  }
  if (normalized.includes("fetch failed")) {
    return "无法连接上游模型 API（网络错误或地址不可达）。请检查 Provider 的 Base URL、网络与 API Key。";
  }
  if (
    normalized.includes("econnrefused") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout") ||
    normalized.includes("socket hang up")
  ) {
    return "连接上游模型 API 失败。请检查网络与 Provider 配置。";
  }
  if (normalized.includes("terminated")) {
    return "上游模型连接中断（流式响应未完成）。请检查 Provider 的 Base URL、API Key 与网络后重试。";
  }
  if (text.includes("未提交 FinalizePlan") || text.includes("未提交 ExitPlanMode")) {
    return "计划阶段未完成：主代理未通过 ExitPlanMode 提交计划。若对话里只有「计划已提交」等文字而无工具调用，请重试或更换主代理模型。";
  }
  const routeMiss = text.match(/No provider route configured for model\s+([^."}\s]+)/i);
  if (routeMiss?.[1]) {
    return `本地模型路由未配置 SDK 请求的模型 ${routeMiss[1]}。这不是当前子代理编排配置的成功匹配；若再次出现，说明仍有 SDK 路径绕过了 Eco 子代理定义。`;
  }

  const legacyApiError = parseLegacyApiErrorActivityMessage(text);
  if (legacyApiError) {
    return formatApiErrorUserMessage(legacyApiError);
  }
  const structuredApiError = parseSdkApiErrorAttribute(text);
  if (structuredApiError) {
    return formatApiErrorUserMessage(structuredApiError);
  }

  return text;
}
