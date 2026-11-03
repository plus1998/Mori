import type {
  StorageCleanupProgress,
  StorageCleanupRequest,
  StorageCleanupResult,
} from "../shared/storage-usage";
import { runStorageCleanup, type StorageCleanupDeps } from "./storage-cleanup";

export function createStorageCleanupService(publish: (progress: StorageCleanupProgress) => void) {
  let progress: StorageCleanupProgress | null = null;
  const update = (next: StorageCleanupProgress) => {
    progress = next;
    publish(next);
  };
  return {
    getProgress: () => progress,
    async run(deps: StorageCleanupDeps, request: StorageCleanupRequest): Promise<StorageCleanupResult> {
      if (progress?.status === "running") throw new Error("A storage cleanup is already running.");
      let current: StorageCleanupProgress = {
        request,
        status: "running",
        phase: "preparing",
        processedCount: 0,
        totalCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        failedCount: 0,
      };
      update(current);
      let result: StorageCleanupResult;
      try {
        result = await runStorageCleanup(
          {
            ...deps,
            onProgress: (next) => {
              current = { ...next, request, status: "running" };
              update(current);
            },
          },
          request,
        );
      } catch (error) {
        result = { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
      }
      update({
        ...current,
        status: "completed",
        result,
        deletedCount: result.deletedCount ?? current.deletedCount,
        skippedCount: result.skippedThreadIds?.length ?? current.skippedCount,
        failedCount: result.errors?.length ?? 0,
      });
      return result;
    },
  };
}
