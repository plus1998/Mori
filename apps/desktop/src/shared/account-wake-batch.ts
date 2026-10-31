export type AccountWakeRepeat = "daily" | "once";
export interface AccountWakeBatchInput {
  id?: string;
  expectedRevision?: number;
  name: string;
  time: string;
  timezone: string;
  repeat: AccountWakeRepeat;
  accountIds: string[];
  enabled: boolean;
}
export interface AccountWakeItem {
  accountId: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "unknown" | "skipped";
  error?: string;
  quotaError?: string;
}
export interface AccountWakeRun {
  id: string;
  source: "scheduled" | "manual" | "retry";
  scheduledAt: string;
  status: "running" | "completed" | "interrupted" | "missed";
  startedAt: string;
  finishedAt?: string;
  items: AccountWakeItem[];
}
export interface AccountWakeBatch {
  id: string;
  revision: number;
  name: string;
  time: string;
  timezone: string;
  repeat: AccountWakeRepeat;
  accountIds: string[];
  enabled: boolean;
  nextRunAt: string | null;
  lastRun?: AccountWakeRun;
}
export interface AccountWakeBatchState {
  version: 1;
  batches: AccountWakeBatch[];
}
