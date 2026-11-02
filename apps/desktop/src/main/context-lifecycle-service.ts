import { extractCompactPostTokens } from "@eco/runtime/sdk";
import type { ContextWindowMonitor } from "./context-window-monitor";

export interface ContextLifecycleMonitor {
  markCompactCompleted: ContextWindowMonitor["markCompactCompleted"];
  noteCompactionObserved: ContextWindowMonitor["noteCompactionObserved"];
}

export interface ContextLifecycleServiceInput {
  monitor: ContextLifecycleMonitor;
  emitLiveContext(threadId: string): void;
  applySdkContextUsageBreakdown(threadId: string, payload: unknown): void;
  recordCompactionBoundary(threadId: string, payload: Record<string, unknown>, sourceEventId?: string): void;
  onCompactionCompleted?(threadId: string): void;
}

export interface ContextLifecycleService {
  afterRunRefresh(threadId: string, worktreePath?: string): Promise<void>;
  noteCompactionObserved(threadId: string): void;
  handleSdkContextEvent(input: { threadId: string; eventId: string; payload: unknown }): boolean;
}

export function createContextLifecycleService(input: ContextLifecycleServiceInput): ContextLifecycleService {
  return {
    async afterRunRefresh(threadId) {
      input.emitLiveContext(threadId);
    },
    noteCompactionObserved(threadId) {
      input.monitor.noteCompactionObserved(threadId);
    },
    handleSdkContextEvent(event) {
      if (!isRecord(event.payload)) {
        return false;
      }
      const payload = event.payload;
      if (payload.type === "sdk_context_usage" && payload.ecoSdkContextUsage !== undefined) {
        input.applySdkContextUsageBreakdown(event.threadId, payload.ecoSdkContextUsage);
        return true;
      }
      if (payload.subtype === "compact_boundary") {
        input.recordCompactionBoundary(event.threadId, payload, event.eventId);
        const postTokens = extractCompactPostTokens(payload);
        input.monitor.markCompactCompleted(event.threadId, postTokens);
        input.emitLiveContext(event.threadId);
        input.onCompactionCompleted?.(event.threadId);
        return false;
      }
      if (payload.type === "system" && payload.subtype === "status" && payload.status === "compacting") {
        input.monitor.noteCompactionObserved(event.threadId);
      }
      return false;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
