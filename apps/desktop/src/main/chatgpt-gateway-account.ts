import { GATEWAY_THREAD_ID_HEADER, parseCodexTurnMetadataHeader } from "@eco/gateway";
import { sanitizeCodexRoleId } from "@eco/runtime";
import type { ThreadSummary } from "../shared/ipc";

export const OAUTH_ACCOUNT_ID_HEADER = "x-eco-oauth-account-id";

/** Each secondary role carries its explicit binding; only the main role uses the thread account. */
export function resolveChatGptGatewayAccountId(
  headers: Headers | undefined,
  getThread: (threadId: string) => Pick<ThreadSummary, "runtimeConfig"> | undefined,
  getCodexAttribution?: (codexThreadId: string) => {
    ecoThreadId: string;
    billingRole: string;
    isSubagentThread?: boolean;
  } | undefined,
): string {
  // Native Codex children share the parent's Gateway provider config. Their own
  // thread metadata identifies the saved role; caller headers cannot override it.
  const codexThreadId = headers && parseCodexTurnMetadataHeader(headers)?.threadId?.trim();
  if (codexThreadId && getCodexAttribution) {
    const attribution = getCodexAttribution(codexThreadId);
    if (!attribution) throw new Error(`找不到 ChatGPT OAuth 请求所属的 Codex 会话：${codexThreadId}`);
    const thread = getThread(attribution.ecoThreadId);
    if (!thread) throw new Error(`找不到 ChatGPT OAuth 请求所属会话：${attribution.ecoThreadId}`);
    const role = attribution.billingRole;
    const accountId = attribution.isSubagentThread
      ? thread.runtimeConfig?.resolvedOrchestrationSnapshot?.agents
        .find((agent) => agent.enabled && sanitizeCodexRoleId(agent.agentKey) === role)?.modelRef.accountId?.trim()
      : thread.runtimeConfig?.orchestrationSelection?.mainModel?.accountId?.trim();
    if (!accountId) throw new Error(`${role} 的 ChatGPT OAuth 模型尚未选择账号，请先选择账号和模型。`);
    return accountId;
  }
  const role = headers?.get("x-eco-route-role")?.trim();
  if (role && role !== "main" && role !== "planner") {
    const accountId = headers?.get(OAUTH_ACCOUNT_ID_HEADER)?.trim();
    if (!accountId) throw new Error("ChatGPT OAuth 模型尚未选择账号，请先选择账号和模型。");
    return accountId;
  }
  const threadId = headers?.get(GATEWAY_THREAD_ID_HEADER)?.trim();
  if (!threadId) throw new Error("ChatGPT OAuth 请求没有会话标识，无法确定绑定账号。");
  const thread = getThread(threadId);
  if (!thread) throw new Error(`找不到 ChatGPT OAuth 请求所属会话：${threadId}`);
  const accountId = thread.runtimeConfig?.orchestrationSelection?.mainModel?.accountId?.trim();
  if (!accountId) throw new Error("此会话尚未选择 ChatGPT OAuth 账号，请先选择账号和模型。");
  return accountId;
}
