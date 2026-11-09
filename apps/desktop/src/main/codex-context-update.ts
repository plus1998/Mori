import type { CodexContextSnapshotResolution } from "@eco/runtime";
import type { ContextSnapshotScheduler } from "./context-snapshot-scheduler";
import type { ContextWindowMonitor } from "./context-window-monitor";

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
    if (!Number.isSafeInteger(catalogLimit) || catalogLimit <= 0) {
      throw new Error(`模型 ${providerId}/${modelId} 的上下文窗口无效。`);
    }
    await input.monitor.updateOccupied(threadId, resolution.billingRole, resolution.contextOccupied, {
      modelId,
      catalogLimit,
    });
    input.scheduler.clearError(threadId);
    input.scheduler.emitLiveFromMonitor(threadId);
  } catch (error) {
    input.scheduler.setError(threadId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
