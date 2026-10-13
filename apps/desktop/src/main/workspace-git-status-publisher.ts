import path from "node:path";

import type { GitWorkingTreeStatus } from "../shared/ipc";
import { type GitRunner, getGitWorkingTreeStatus } from "./git-operations";

export const WORKSPACE_GIT_STATUS_DEBOUNCE_MS = 500;

export interface WorkspaceGitStatusSummary {
  workspacePath: string;
  dirtyFileCount: number;
  insertions: number;
  deletions: number;
}

export function workspaceGitStatusFingerprint(summary: WorkspaceGitStatusSummary): string {
  return `${summary.dirtyFileCount}:${summary.insertions}:${summary.deletions}`;
}

export function gitStatusToSummary(status: GitWorkingTreeStatus): WorkspaceGitStatusSummary {
  return {
    workspacePath: status.workspacePath,
    dirtyFileCount: status.dirtyFileCount,
    insertions: status.insertions,
    deletions: status.deletions,
  };
}

export type WorkspaceGitStatusPublishListener = (summary: WorkspaceGitStatusSummary) => void;

export class WorkspaceGitStatusPublisher {
  private readonly fingerprints = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly run: GitRunner,
    private readonly onPublish: WorkspaceGitStatusPublishListener,
    private readonly debounceMs = WORKSPACE_GIT_STATUS_DEBOUNCE_MS,
    private readonly loadSummary?: (workspacePath: string) => Promise<WorkspaceGitStatusSummary>,
  ) {}

  schedule(workspacePath: string): void {
    const resolved = path.resolve(workspacePath);
    const existing = this.timers.get(resolved);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timers.delete(resolved);
      void this.publishIfChanged(resolved);
    }, this.debounceMs);
    this.timers.set(resolved, timer);
  }

  async publishIfChanged(workspacePath: string): Promise<boolean> {
    const resolved = path.resolve(workspacePath);
    try {
      const summary = this.loadSummary
        ? await this.loadSummary(resolved)
        : gitStatusToSummary(await getGitWorkingTreeStatus(resolved, this.run, { fetchIfStale: false }));
      const fingerprint = workspaceGitStatusFingerprint(summary);
      if (this.fingerprints.get(resolved) === fingerprint) {
        return false;
      }
      this.fingerprints.set(resolved, fingerprint);
      this.onPublish(summary);
      return true;
    } catch {
      return false;
    }
  }

  reset(workspacePath?: string): void {
    if (workspacePath) {
      this.fingerprints.delete(path.resolve(workspacePath));
      return;
    }
    this.fingerprints.clear();
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
