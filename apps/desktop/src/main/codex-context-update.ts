import type { CodexContextSnapshotResolution } from "@eco/runtime";
import type { ContextSnapshotScheduler } from "./context-snapshot-scheduler";
import type { ContextWindowMonitor } from "./context-window-monitor";

// Catalog lookups may finish out of order, especially across model switches.
const pendingUpdates = new WeakMap<object, Map<string, symbol>>();

export async function applyCodexContextUpdate(
  resolution: CodexContextSnapshotResolution,
  input: {
    monitor: Pick<ContextWindowMonitor, "updateOccupied">;
    scheduler: Pick<ContextSnapshotScheduler, "setError" | "clearError" | "emitLiveFromMonitor">;
    resolveModelLimit: (identity: {
      threadId: string;
      role: CodexContextSnapshotResolution["billingRole"];
      providerId: string;
      modelId: string;
    }) => Promise<number>;
  },
): Promise<void> {
  const threadId = resolution.ecoThreadId;
  let updates = pendingUpdates.get(input.scheduler);
  if (!updates) {
    updates = new Map();
    pendingUpdates.set(input.scheduler, updates);
  }
  const key = `${threadId}\u0000${resolution.billingRole}`;
  const generation = Symbol();
  updates.set(key, generation);
  const isCurrent = () => updates.get(key) === generation;
  try {
    const providerId = resolution.providerId?.trim();
    if (!providerId) throw new Error("缺少供应商身份（providerId），无法确定上下文窗口。");
    const modelId = resolution.context.modelId?.trim();
    if (!modelId) throw new Error("缺少模型身份（modelId），无法确定上下文窗口。");
    const catalogLimit = await input.resolveModelLimit({
      threadId,
      role: resolution.billingRole,
      providerId,
      modelId,
    });
    if (!isCurrent()) return;
    if (!Number.isSafeInteger(catalogLimit) || catalogLimit <= 0) {
      throw new Error(`模型 ${providerId}/${modelId} 的上下文窗口无效。`);
    }
    await input.monitor.updateOccupied(threadId, resolution.billingRole, resolution.contextOccupied, {
      modelId,
      catalogLimit,
    });
    if (!isCurrent()) return;
    input.scheduler.clearError(threadId);
    input.scheduler.emitLiveFromMonitor(threadId);
  } catch (error) {
    if (isCurrent()) input.scheduler.setError(threadId, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (isCurrent()) updates.delete(key);
  }
}
