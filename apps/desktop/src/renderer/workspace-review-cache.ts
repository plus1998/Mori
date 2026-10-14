import type { WorkspaceDiffResult, WorkspaceFileDiffResult } from "../shared/ipc";

const summaries = new Map<string, WorkspaceDiffResult>();
const files = new Map<
  string,
  { result?: WorkspaceFileDiffResult; pending?: Promise<WorkspaceFileDiffResult> }
>();
const MAX_FILES = 32;
const MAX_BYTES = 16 * 1024 * 1024;

export function cacheWorkspaceReviewSummary(diff: WorkspaceDiffResult): void {
  summaries.delete(diff.workspacePath);
  summaries.set(diff.workspacePath, diff);
  while (summaries.size > 8) {
    const oldest = summaries.keys().next().value;
    if (oldest === undefined) break;
    summaries.delete(oldest);
  }
}

export function readWorkspaceReviewSummary(workspacePath: string): WorkspaceDiffResult | undefined {
  return summaries.get(workspacePath);
}

export function invalidateWorkspaceReviewSummary(workspacePath: string): void {
  summaries.delete(workspacePath);
}

export function readCachedWorkspaceFileDiff(key: string): WorkspaceFileDiffResult | undefined {
  return files.get(key)?.result;
}

/** Cache lifetime is the workspace/file revision, independent of panel mounting. */
export function loadCachedWorkspaceFileDiff(
  key: string,
  load: () => Promise<WorkspaceFileDiffResult>,
): Promise<WorkspaceFileDiffResult> {
  const existing = files.get(key);
  if (existing?.result) return Promise.resolve(existing.result);
  if (existing?.pending) return existing.pending;
  const entry: { result?: WorkspaceFileDiffResult; pending?: Promise<WorkspaceFileDiffResult> } = {};
  const pending = load().then(
    (result) => {
      if (files.get(key) === entry) {
        entry.result = result;
        delete entry.pending;
        if (result.patch.length * 2 + (result.imagePreview?.base64.length ?? 0) * 2 > MAX_BYTES)
          files.delete(key);
        let bytes = [...files.values()].reduce(
          (sum, value) =>
            sum +
            (value.result?.patch.length ?? 0) * 2 +
            (value.result?.imagePreview?.base64.length ?? 0) * 2,
          0,
        );
        for (const [oldKey, old] of files) {
          if (files.size <= MAX_FILES && bytes <= MAX_BYTES) break;
          if (old.pending || oldKey === key) continue;
          files.delete(oldKey);
          bytes -= (old.result?.patch.length ?? 0) * 2 + (old.result?.imagePreview?.base64.length ?? 0) * 2;
        }
      }
      return result;
    },
    (error) => {
      if (files.get(key) === entry) files.delete(key);
      throw error;
    },
  );
  entry.pending = pending;
  files.set(key, entry);
  return pending;
}
