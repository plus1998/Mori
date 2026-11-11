import type { ThreadSummary } from "../shared/ipc";
import type { ThreadListInitialResult, ThreadListPage } from "./conversation-store";

export const REMOTE_THREAD_LIST_PROMPT_MAX_CHARS = 200;
export const REMOTE_THREAD_LIST_MESSAGE_MAX_CHARS = 200;
export const REMOTE_THREAD_LIST_INITIAL_LIMIT_PER_WORKSPACE = 5;

function truncateField(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

/** Compact ThreadSummary for Mobile list RPC (keeps local desktop IPC full). */
export function summarizeThreadForRemoteList(thread: ThreadSummary): ThreadSummary {
  const prompt = typeof thread.prompt === "string" ? thread.prompt : "";
  const message = typeof thread.message === "string" ? thread.message : "";
  return {
    id: thread.id,
    title: thread.title ?? "",
    prompt: truncateField(prompt, REMOTE_THREAD_LIST_PROMPT_MAX_CHARS),
    workspacePath: thread.workspacePath ?? "",
    status: thread.status,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    message: truncateField(message, REMOTE_THREAD_LIST_MESSAGE_MAX_CHARS),
    ...(thread.wechatFollowEnabled ? { wechatFollowEnabled: true } : {}),
    ...(thread.cancelling ? { cancelling: true } : {}),
    ...(thread.coreKind ? { coreKind: thread.coreKind } : {}),
    ...(thread.acpAgentId ? { acpAgentId: thread.acpAgentId } : {}),
    ...(thread.hostUiFeatures ? { hostUiFeatures: thread.hostUiFeatures } : {}),
    ...(thread.coreLockedAt ? { coreLockedAt: thread.coreLockedAt } : {}),
    // Omit sdk/external session paths + full runtimeConfig from list payloads.
  };
}

export function summarizeThreadsForRemoteList(threads: readonly ThreadSummary[]): ThreadSummary[] {
  return threads.map(summarizeThreadForRemoteList);
}

export function summarizeThreadListInitialResult(result: ThreadListInitialResult): ThreadListInitialResult {
  return {
    ...result,
    threads: summarizeThreadsForRemoteList(result.threads),
  };
}

export function summarizeThreadListPage(result: ThreadListPage): ThreadListPage {
  return {
    ...result,
    threads: summarizeThreadsForRemoteList(result.threads),
  };
}
