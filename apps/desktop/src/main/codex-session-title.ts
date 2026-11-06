import type { CodexThreadMap } from "./codex-thread-map";

/** Child and unmapped threads must never rename the parent Mori conversation. */
export function forwardCodexSessionTitle(
  threadMap: Pick<CodexThreadMap, "getEcoThreadId">,
  payload: unknown,
  onName: ((ecoThreadId: string, name: string) => void) | undefined,
): void {
  if (!payload || typeof payload !== "object") return;
  const { threadId, threadName } = payload as { threadId?: unknown; threadName?: unknown };
  if (typeof threadId !== "string" || typeof threadName !== "string" || !threadName.trim()) return;
  const ecoThreadId = threadMap.getEcoThreadId(threadId);
  if (ecoThreadId) onName?.(ecoThreadId, threadName);
}
