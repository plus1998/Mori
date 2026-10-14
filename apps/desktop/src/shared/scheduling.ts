import type { CoreKind } from "@eco/runtime";
import type { ThreadRuntimeConfig } from "./thread-runtime-config";
import { buildEcoMcpHubToolUsage } from "./mcp-hub-tool-usage";

export type ScheduleTrigger =
  | { type: "at"; at: string }
  | { type: "interval"; everySeconds: number; anchorAt: string }
  | { type: "cron"; expression: string; timezone: string };

export interface ScheduleExecutionProfile {
  coreKind: CoreKind;
  runtimeConfig: ThreadRuntimeConfig;
}

export type ScheduleCreateInput = {
  /** Stable key: retries of the same creation return the same definition. */
  requestId: string;
  name: string;
  trigger: ScheduleTrigger;
  maxLatenessSeconds?: number;
} & (
  | { kind: "session_message"; threadId: string; prompt: string }
  | { kind: "scheduled_task"; workspacePath: string; prompt: string; executionProfile: ScheduleExecutionProfile }
);

export interface ScheduleDefinition {
  id: string;
  kind: "session_message" | "scheduled_task";
  name: string;
  prompt: string;
  trigger: ScheduleTrigger;
  enabled: boolean;
  maxLatenessSeconds: number;
  source: "user" | "agent";
  originThreadId?: string;
  threadId?: string;
  workspacePath?: string;
  executionProfile?: ScheduleExecutionProfile;
  revision: number;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** Original creation payload fingerprint; edits never change its idempotency identity. */
  creationSignature?: string;
}

export interface ScheduleUpdateInput {
  id: string;
  expectedRevision: number;
  name?: string;
  prompt?: string;
  trigger?: ScheduleTrigger;
  enabled?: boolean;
  maxLatenessSeconds?: number;
  workspacePath?: string;
  executionProfile?: ScheduleExecutionProfile;
}

export type ScheduleOccurrenceStatus = "pending" | "dispatching" | "running" | "waiting_user" | "completed" | "failed" | "skipped" | "unknown" | "cancelled";
export interface ScheduleOccurrence {
  id: string;
  scheduleId: string;
  scheduledAt: string;
  status: ScheduleOccurrenceStatus;
  definition: ScheduleDefinition;
  threadId?: string;
  followUpId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulingSnapshot {
  schedules: ScheduleDefinition[];
  occurrences: ScheduleOccurrence[];
}

/** A paused one-shot whose planned date has passed; re-arming it has no future tick to offer. */
export function isExpiredOneShotSchedule(definition: ScheduleDefinition, now = Date.now()): boolean {
  return !definition.enabled && definition.trigger.type === "at" && Date.parse(definition.trigger.at) <= now;
}

export const SCHEDULING_MCP_SERVER = "eco_scheduling";
export const SCHEDULING_PROMPT = [
  "Built-in scheduling (Eco): continue this conversation after a delay, or run independent scheduled tasks in new conversations; inspect, update and cancel schedules.",
  buildEcoMcpHubToolUsage({ server: SCHEDULING_MCP_SERVER }),
  "Choose a conversation wakeup to continue current work. Independent task prompts must include all required context because each occurrence starts a new conversation.",
  "Execution requires Eco running on an awake local computer; a conversation wakeup does not wake a sleeping computer.",
].join("\n");
