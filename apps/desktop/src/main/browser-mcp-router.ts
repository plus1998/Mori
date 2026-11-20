/**
 * Concurrent Codex shares one mori_agent_browser MCP process. Tool calls do not carry Eco
 * threadId, so we bind them via (1) bearer token when present and (2) FIFO claims registered
 * when Eco sees tool.started for that thread.
 */

export type BrowserToolClaim = {
  threadId: string;
  toolName: string;
  toolUseId?: string;
  at: number;
};

const MAX_CLAIM_AGE_MS = 60_000;
const MAX_QUEUE = 64;

export class BrowserMcpToolClaimRouter {
  private readonly queue: BrowserToolClaim[] = [];

  noteUpcoming(threadId: string, toolName?: string, toolUseId?: string): void {
    const tid = threadId.trim();
    if (!tid) {
      return;
    }
    const normalizedToolUseId = toolUseId?.trim();
    if (
      normalizedToolUseId &&
      this.queue.some((claim) => claim.threadId === tid && claim.toolUseId === normalizedToolUseId)
    ) {
      return;
    }
    this.queue.push({
      threadId: tid,
      toolName: (toolName ?? "").trim().toLowerCase(),
      ...(normalizedToolUseId && { toolUseId: normalizedToolUseId }),
      at: Date.now(),
    });
    while (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
    }
    this.prune();
  }

  /**
   * Prefer exact tool name match, else oldest non-expired claim.
   * Returns undefined when concurrent callers left no claim (caller must fail loud).
   */
  claim(toolName?: string): string | undefined {
    return this.claimDetails(toolName)?.threadId;
  }

  claimDetails(toolName?: string, threadId?: string): BrowserToolClaim | undefined {
    this.prune();
    if (this.queue.length === 0) {
      return undefined;
    }
    const want = (toolName ?? "").trim().toLowerCase();
    const wantedThreadId = threadId?.trim();
    if (want) {
      const bare = want.includes("__") ? want.split("__").pop()! : want;
      const idx = this.queue.findIndex((c) => {
        if (wantedThreadId && c.threadId !== wantedThreadId) {
          return false;
        }
        if (!c.toolName) {
          return true;
        }
        return c.toolName === bare || c.toolName.endsWith(bare) || bare.includes(c.toolName);
      });
      if (idx >= 0) {
        const [hit] = this.queue.splice(idx, 1);
        return hit;
      }
    }
    const fallbackIndex = wantedThreadId
      ? this.queue.findIndex((claim) => claim.threadId === wantedThreadId)
      : 0;
    if (fallbackIndex < 0) {
      return undefined;
    }
    const [first] = this.queue.splice(fallbackIndex, 1);
    return first;
  }

  private prune(): void {
    const now = Date.now();
    while (this.queue.length > 0) {
      const head = this.queue[0]!;
      if (now - head.at <= MAX_CLAIM_AGE_MS) {
        break;
      }
      this.queue.shift();
    }
  }
}
