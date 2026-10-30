import type { EcoSubagentLaunchGate, EcoSubagentLaunchGateDecision } from "@eco/runtime";
import type { RuntimeAgentRole } from "../shared/ipc";

export interface SubagentConcurrencyGateOptions {
  maxConcurrentSubagents: number;
  readActiveSubagentCount: () => number;
  pendingTtlMs?: number;
  now?: () => number;
}

interface PendingLaunch {
  toolUseId: string;
  role?: RuntimeAgentRole;
  prompt?: string;
  expiresAt: number;
}

export class SubagentConcurrencyGate implements EcoSubagentLaunchGate {
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly pendingTtlMs: number;

  constructor(private readonly options: SubagentConcurrencyGateOptions) {
    this.pendingTtlMs = Math.max(1_000, options.pendingTtlMs ?? 30_000);
  }

  tryReserveLaunch(input: {
    toolUseId: string;
    role?: RuntimeAgentRole;
    prompt?: string;
  }): EcoSubagentLaunchGateDecision {
    const toolUseId = input.toolUseId.trim();
    if (!toolUseId) {
      return { ok: true };
    }
    this.pruneExpired();
    if (this.pending.has(toolUseId)) {
      return { ok: true };
    }

    const active = this.activeCount();
    const launching = this.pending.size;
    const limit = this.limit();
    if (active + launching >= limit) {
      return {
        ok: false,
        reason: [
          `Mori already has ${active + launching}/${limit} subagents active or launching`,
          `(active=${active}, launching=${launching}).`,
        ].join(" "),
      };
    }

    this.pending.set(toolUseId, {
      toolUseId,
      ...(input.role && { role: input.role }),
      ...(input.prompt && { prompt: input.prompt }),
      expiresAt: this.now() + this.pendingTtlMs,
    });
    return { ok: true };
  }

  releaseLaunch(input: { toolUseId?: string }): void {
    const toolUseId = input.toolUseId?.trim();
    if (toolUseId) {
      this.pending.delete(toolUseId);
    }
    this.pruneExpired();
  }

  clear(): void {
    this.pending.clear();
  }

  private activeCount(): number {
    const count = this.options.readActiveSubagentCount();
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  private limit(): number {
    const limit = this.options.maxConcurrentSubagents;
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, launch] of this.pending) {
      if (launch.expiresAt <= now) {
        this.pending.delete(key);
      }
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
