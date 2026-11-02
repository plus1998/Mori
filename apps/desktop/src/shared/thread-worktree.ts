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
  location?: ThreadWorkLocation;
  branchExists?: boolean;
  merged?: "git" | "confirmed" | "unmerged";
  branchCommit?: string;
  targetCommit?: string;
  canClean?: boolean;
  canReattach?: boolean;
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
