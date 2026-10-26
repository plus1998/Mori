import { CodexTurnRouteRegistry, type CodexTurnTokenUsageSnapshot } from "@eco/runtime";
import type { AccountUsageRecord } from "./account-usage-store";

/** Request-time account ownership, separate from the conversation billing projector. */
export class CodexAccountUsageTracker {
  private readonly routes = new CodexTurnRouteRegistry();
  private readonly accounts = new Map<string, string>();

  start(
    threadId: string,
    turnId: string,
    identity: { accountId: string; modelId: string } | undefined,
  ): void {
    if (!identity) return;
    const key = JSON.stringify([threadId, turnId]);
    if (this.accounts.has(key)) return;
    this.accounts.set(key, identity.accountId);
    this.routes.register(threadId, turnId, {
      aliasModelId: identity.modelId,
      upstreamModelId: identity.modelId,
      providerId: "openai",
    });
  }

  observe(
    threadId: string,
    turnId: string,
    snapshot: CodexTurnTokenUsageSnapshot,
    now: number,
  ): { record: AccountUsageRecord; aggregate: boolean } | undefined {
    const previous = this.routes.peek(threadId, turnId)?.appServerTokenUsage;
    const route = this.routes.observeTokenUsage(threadId, turnId, snapshot);
    const accountId = this.accounts.get(JSON.stringify([threadId, turnId]));
    const current = route?.appServerTokenUsage;
    if (!route || !current || !accountId) return;
    const input = current.inputTokens - (previous?.inputTokens ?? 0);
    const cached = current.cachedInputTokens - (previous?.cachedInputTokens ?? 0);
    const output = current.outputTokens - (previous?.outputTokens ?? 0);
    const reasoning = current.reasoningOutputTokens - (previous?.reasoningOutputTokens ?? 0);
    if (!input && !output) return;
    return {
      record: {
        kind: "chatgpt_login",
        accountId,
        modelId: route.upstreamModelId,
        eventId: JSON.stringify(["codex", threadId, turnId, current]),
        observedAt: now,
        inputTokens: input - cached,
        outputTokens: output,
        cacheReadTokens: cached,
        cacheCreationTokens: 0,
        reasoningTokens: reasoning,
      },
      aggregate:
        input !== snapshot.last.inputTokens ||
        cached !== snapshot.last.cachedInputTokens ||
        output !== snapshot.last.outputTokens,
    };
  }

  finish(threadId: string, turnId: string): void {
    this.routes.clearTurn(threadId, turnId);
    this.accounts.delete(JSON.stringify([threadId, turnId]));
  }

  clearThread(threadId: string): void {
    this.routes.clearThread(threadId);
    for (const key of this.accounts.keys())
      if ((JSON.parse(key) as string[])[0] === threadId) this.accounts.delete(key);
  }
}
