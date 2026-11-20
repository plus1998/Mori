import { randomBytes } from "node:crypto";

/**
 * Thread-scoped bearer tokens for Eco's browser MCP gateway.
 * - UI / composer toggle stays `mori_agent_browser` (one logical server name).
 * - Each conversation gets a secret token; the gateway maps token → Eco threadId → CDP.
 * - Codex may share one MCP process: concurrent routing also uses the tool.started claim queue.
 */

export type BrowserThreadTokenRecord = {
  token: string;
  threadId: string;
  issuedAt: number;
};

export class BrowserMcpAuthRegistry {
  private readonly byToken = new Map<string, BrowserThreadTokenRecord>();
  private readonly byThread = new Map<string, string>();

  /** Idempotent: reuse existing thread token or mint once. */
  ensure(threadId: string): BrowserThreadTokenRecord {
    const tid = threadId.trim();
    if (!tid) {
      throw new Error("Browser MCP auth requires a thread id");
    }
    const existingToken = this.byThread.get(tid);
    if (existingToken) {
      const existing = this.byToken.get(existingToken);
      if (existing) {
        return existing;
      }
    }
    return this.mint(tid);
  }

  /** Force a new token for the thread (revokes the previous one). */
  rotate(threadId: string): BrowserThreadTokenRecord {
    this.revokeThread(threadId);
    return this.ensure(threadId);
  }

  /** @deprecated Prefer ensure(); kept as stable alias so call sites cannot silently rotate. */
  issue(threadId: string): BrowserThreadTokenRecord {
    return this.ensure(threadId);
  }

  resolve(token: string | undefined | null): BrowserThreadTokenRecord | undefined {
    const t = token?.trim();
    if (!t) {
      return undefined;
    }
    return this.byToken.get(t);
  }

  getTokenForThread(threadId: string): string | undefined {
    return this.byThread.get(threadId.trim());
  }

  revokeThread(threadId: string): void {
    const tid = threadId.trim();
    const token = this.byThread.get(tid);
    if (token) {
      this.byToken.delete(token);
    }
    this.byThread.delete(tid);
  }

  private mint(tid: string): BrowserThreadTokenRecord {
    const token = `ebt_${randomBytes(24).toString("base64url")}`;
    const record: BrowserThreadTokenRecord = {
      token,
      threadId: tid,
      issuedAt: Date.now(),
    };
    this.byToken.set(token, record);
    this.byThread.set(tid, token);
    return record;
  }
}

/** Shared secret so the stdio MCP child may call Eco control HTTP. */
export function createBrowserMcpControlSecret(): string {
  return `ecs_${randomBytes(24).toString("base64url")}`;
}
