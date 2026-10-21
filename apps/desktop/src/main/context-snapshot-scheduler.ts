import {
  alignBreakdownSegmentsToOccupied,
  normalizeContextSegments,
  parseSdkGetContextUsageBreakdown,
} from "@eco/runtime";
import type { ThreadContextSnapshot, ThreadRoleContextSnapshot } from "../shared/ipc";
import type { ContextMonitorRoleSnapshot, ContextWindowMonitor } from "./context-window-monitor";
import { logEcoDiag, shortThreadId } from "./eco-diag-log";

export interface ContextSnapshotSchedulerOptions {
  monitor: ContextWindowMonitor;
  emitContext: (threadId: string, snapshot: ThreadContextSnapshot) => void;
}

export class ContextSnapshotScheduler {
  /** Planner-only breakdown segments from SDK `getContextUsage()` (once per turn `result`). */
  private readonly lastPlannerSegments = new Map<string, ThreadContextSnapshot["segments"]>();
  private readonly lastEmitted = new Map<string, ThreadContextSnapshot>();

  constructor(private readonly options: ContextSnapshotSchedulerOptions) {}

  applySdkContextUsageBreakdown(threadId: string, payload: unknown): boolean {
    const parsed = parseSdkGetContextUsageBreakdown(payload);
    if (!parsed) {
      logEcoDiag("context.sdk_breakdown_parse", {
        threadId: shortThreadId(threadId),
        ok: false,
        payloadKind: typeof payload,
      });
      return false;
    }
    logEcoDiag("context.sdk_breakdown_parse", {
      threadId: shortThreadId(threadId),
      ok: true,
      occupied: parsed.occupied,
      limit: parsed.limit,
      occupancyPct: parsed.occupancyPct ?? null,
      segmentCount: parsed.segments.length,
      segments: parsed.segments.slice(0, 8).map((segment) => ({
        key: segment.key,
        tokens: segment.tokens,
      })),
    });
    void this.options.monitor.updateOccupied(threadId, "main", parsed.occupied, {
      limit: parsed.limit,
    });
    if (parsed.segments.length > 0) {
      this.lastPlannerSegments.set(threadId, parsed.segments);
    }
    this.emitLiveFromMonitor(threadId);
    return true;
  }

  /** Real-time meter from usage / monitor — never marked stale. */
  emitLiveFromMonitor(threadId: string): void {
    const snapshot = this.buildSnapshot(threadId);
    if (!snapshot) {
      return;
    }
    this.lastEmitted.set(threadId, snapshot);
    this.options.emitContext(threadId, snapshot);
  }

  /** @deprecated Use emitLiveFromMonitor; kept for call sites being migrated. */
  emitFromMonitor(threadId: string, _stale = false): void {
    this.emitLiveFromMonitor(threadId);
  }

  getDisplaySnapshot(threadId: string): ThreadContextSnapshot | undefined {
    return this.lastEmitted.get(threadId) ?? this.buildSnapshot(threadId);
  }

  restoreSnapshot(threadId: string, snapshot: ThreadContextSnapshot): void {
    const plannerRole = snapshot.roles?.find((role) => role.role === "main");
    const plannerSegments =
      plannerRole?.segments.filter((segment) => segment.tokens > 0) ?? snapshot.segments;
    if (plannerSegments.length > 0) {
      this.lastPlannerSegments.set(threadId, normalizeContextSegments(plannerSegments));
    }
    this.options.monitor.restoreFromContextSnapshot(threadId, snapshot);
    const normalized = this.buildSnapshot(threadId);
    if (normalized) {
      this.lastEmitted.set(threadId, normalized);
    }
  }

  clearThread(threadId: string): void {
    this.lastPlannerSegments.delete(threadId);
    this.lastEmitted.delete(threadId);
    this.options.monitor.clearThread(threadId);
  }

  clearSubagentState(threadId: string): void {
    const emitted = this.lastEmitted.get(threadId);
    const plannerRole = emitted?.roles?.find((role) => role.role === "main");
    if (!emitted || !plannerRole) {
      this.lastEmitted.delete(threadId);
      return;
    }

    this.lastEmitted.set(threadId, {
      occupied: plannerRole.occupied,
      limit: plannerRole.limit,
      occupancyPct: plannerRole.occupancyPct,
      limitsResolved: plannerRole.limitsResolved,
      displayRole: "main",
      segments: plannerRole.segments,
      roles: [plannerRole],
      instances: [],
      updatedAt: Date.now(),
      ...(plannerRole.modelId && { modelId: plannerRole.modelId }),
      ...(plannerRole.maxOutputTokens !== undefined && { maxOutputTokens: plannerRole.maxOutputTokens }),
    });
  }

  private buildSnapshot(threadId: string): ThreadContextSnapshot | undefined {
    const monitorSnap = this.options.monitor.getSnapshot(threadId);
    if (!monitorSnap || monitorSnap.occupied <= 0) {
      return undefined;
    }
    const roles = monitorSnap.roles.map((role) => this.buildRoleSnapshot(threadId, role));
    const active = roles.find((role) => role.role === monitorSnap.displayRole) ?? roles[0];
    if (!active) {
      return undefined;
    }
    return {
      occupied: active.occupied,
      limit: active.limit,
      occupancyPct: active.occupancyPct,
      limitsResolved: active.limitsResolved,
      displayRole: active.role,
      segments: active.segments,
      roles,
      instances: monitorSnap.instances ?? [],
      updatedAt: Date.now(),
      ...(active.modelId && { modelId: active.modelId }),
      ...(active.maxOutputTokens !== undefined && { maxOutputTokens: active.maxOutputTokens }),
    };
  }

  private buildRoleSnapshot(threadId: string, role: ContextMonitorRoleSnapshot): ThreadRoleContextSnapshot {
    const segments =
      role.role === "main"
        ? this.plannerSegmentsForRole(threadId, role.occupied)
        : role.occupied > 0
          ? [fallbackSegment(role.occupied)]
          : [];
    return {
      role: role.role,
      occupied: role.occupied,
      limit: role.limit,
      occupancyPct: role.occupancyPct,
      limitsResolved: role.limitsResolved,
      segments,
      ...(role.modelId && { modelId: role.modelId }),
      ...(role.maxOutputTokens !== undefined && { maxOutputTokens: role.maxOutputTokens }),
    };
  }

  private plannerSegmentsForRole(threadId: string, occupied: number): ThreadRoleContextSnapshot["segments"] {
    const raw = this.lastPlannerSegments.get(threadId);
    if (!raw || raw.length === 0) {
      return occupied > 0 ? [fallbackSegment(occupied)] : [];
    }
    return alignBreakdownSegmentsToOccupied(raw, occupied);
  }
}

function fallbackSegment(tokens: number): ThreadContextSnapshot["segments"][number] {
  return {
    key: "conversation",
    label: "会话",
    tokens,
    color: "#ea580c",
  };
}
