export type ThreadDevelopmentMode = "direct" | "isolated";
export type ThreadWorktreeLifecycle = "creating" | "active" | "missing" | "removed" | "error";

export interface ThreadWorktreeRecord {
  id: string;
  threadId: string;
  workspacePath: string;
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
  targetBranch: string;
  baseCommit: string;
  state: ThreadWorktreeLifecycle;
  createdAt: string;
  updatedAt: string;
  threadTitle?: string;
  repositoryRoot?: string;
  /** Git administrative directory identifies this checkout across branch switches. */
  gitDirectory?: string;
  gitIdentity?: string;
  /** Empty means detached HEAD. branchName remains the Mori-owned branch only. */
  checkoutBranch?: string;
  lastHeadCommit?: string;
  error?: string;
  /** User acknowledgement applies only to this exact branch tip and target history. */
  confirmedCommit?: string;
  confirmedTargetCommit?: string;
}

export interface ThreadWorkLocation {
  mode: ThreadDevelopmentMode | "needs_choice";
  worktree?: ThreadWorktreeRecord;
  /** The next turn must rebuild context from saved conversation history. */
  contextResetPending?: boolean;
}

export interface ThreadWorktreeStatus {
  exists: boolean;
  workspacePath: string;
  worktreePath: string;
  changedFiles: string[];
  ignoredFiles?: string[];
  location?: ThreadWorkLocation;
  branchExists?: boolean;
  merged?: "git" | "confirmed" | "unmerged";
  branchCommit?: string;
  ownedBranchCommit?: string;
  targetCommit?: string;
  canClean?: boolean;
  canReattach?: boolean;
  canForget?: boolean;
  blockingReasons?: string[];
  error?: string;
}

export interface ThreadWorktreeActionRequest {
  threadId: string;
  /** Reject a stale click after another worktree has been selected. */
  worktreeId: string;
  expectedBranchCommit?: string;
  expectedTargetCommit?: string;
}

export interface ThreadWorkLocationRequest {
  threadId: string;
  choice: "project" | "new_worktree" | "reattach";
  worktreeId?: string;
}

export interface WorktreeSettings {
  /** Empty selects the platform-specific Mori data directory. */
  rootPath: string;
}

export interface WorktreeSettingsSnapshot extends WorktreeSettings {
  defaultRootPath: string;
}

export interface ManagedWorktree extends ThreadWorktreeStatus {
  record: ThreadWorktreeRecord;
  threadTitle: string;
  threadExists: boolean;
  attached: boolean;
  busy: boolean;
}
