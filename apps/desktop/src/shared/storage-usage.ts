export type StorageCategoryId =
  | "database"
  | "logs"
  | "claudeSessions"
  | "codexHome"
  | "piAgent"
  | "otherUserData";

export type StorageUnmeteredId = never;

export interface StorageCategoryUsage {
  id: StorageCategoryId;
  path: string;
  bytes: number;
  exists: boolean;
  detail?: {
    threadCount?: number;
    fileCount?: number;
  };
}

export interface StorageUnmeteredItem {
  id: string;
  reason: string;
}

export interface StorageUsageSnapshot {
  totalBytes: number;
  categories: StorageCategoryUsage[];
  unmetered: StorageUnmeteredItem[];
}

export type StorageCleanupOlderThanUnit = "hours" | "days";

export type StorageCleanupAction =
  | "clearLogs"
  | "clearCodexHomeCaches"
  | "clearClaudeSessions"
  | "clearPiAgent"
  | "clearOldConversations"
  | "clearAllConversations"
  | "vacuumDatabase";

export interface StorageCleanupRequest {
  action: StorageCleanupAction;
  options?: {
    /** Only for clearLogs: delete upstream-*.log older than N days (mtime). */
    olderThanDays?: number;
    /**
     * For clearOldConversations: retention amount (positive).
     * Combined with olderThanUnit; required for that action.
     */
    olderThanValue?: number;
    /** For clearOldConversations: hours or days. Required with olderThanValue. */
    olderThanUnit?: StorageCleanupOlderThanUnit;
    /**
     * For clearClaudeSessions: remove only Eco worktree project dirs with no active Eco session.
     * For clearPiAgent orphansOnly: remove pi-agent/<threadId> dirs with no matching Eco thread.
     * Full clearPiAgent also deletes Eco threads whose coreKind is pi.
     */
    orphansOnly?: boolean;
  };
}

export interface StorageCleanupResult {
  ok: boolean;
  freedBytes?: number;
  deletedCount?: number;
  skippedThreadIds?: string[];
  errors?: string[];
  message?: string;
}

/** Retained by the main process so progress survives settings navigation. */
export interface StorageCleanupProgress {
  request: StorageCleanupRequest;
  status: "running" | "completed";
  phase: "preparing" | "conversations" | "files";
  processedCount: number;
  totalCount: number;
  deletedCount: number;
  skippedCount: number;
  failedCount: number;
  result?: StorageCleanupResult;
}
