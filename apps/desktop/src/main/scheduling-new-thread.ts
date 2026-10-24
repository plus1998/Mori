import type { ThreadSummary } from "../shared/ipc";
import type { ScheduleDefinition, ScheduledMessageNewThread } from "../shared/scheduling";
import type { ConversationStore } from "./conversation-store";
import type { SchedulingStore } from "./scheduling-store";

/** No user message or run is created until the schedule is actually dispatched. */
export function saveNewScheduledMessageThread(
  definition: ScheduleDefinition, creationKey: string, input: ScheduledMessageNewThread,
  conversations: Pick<ConversationStore, "getThread" | "saveThread">,
  schedules: Pick<SchedulingStore, "insertInTransaction">,
): ThreadSummary {
  if (definition.kind !== "session_message" || !definition.threadId) throw new Error("不是定时消息。");
  if (conversations.getThread(definition.threadId)) throw new Error("目标会话已存在，不能覆盖已有会话。");
  const thread: ThreadSummary = {
    id: definition.threadId, title: definition.name, prompt: "", status: "idle", message: "",
    workspacePath: input.workspacePath, coreKind: input.executionProfile.coreKind,
    runtimeConfig: input.executionProfile.runtimeConfig,
    createdAt: definition.createdAt, updatedAt: definition.createdAt, coreLockedAt: definition.createdAt,
    ...(input.executionProfile.coreKind === "acp" ? { acpAgentId: "cursor" as const } : {}),
  };
  conversations.saveThread(thread, db => schedules.insertInTransaction(db, definition, creationKey));
  return thread;
}
