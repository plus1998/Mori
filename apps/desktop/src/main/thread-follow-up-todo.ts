import { randomUUID } from "node:crypto";
import { stableHash } from "@eco/shared";
import type { PromptImageAttachment } from "../shared/ipc";
import { TODO_MAX_IMAGE_BYTES, TODO_MAX_IMAGES, type ProjectTodo } from "../shared/project-todos";
import type { ConversationStore } from "./conversation-store";
import type { ProjectTodoStore } from "./project-todo-store";

/** Called under the thread's delivery lock; no image bytes cross the mobile RPC. */
export async function moveQueuedFollowUpToTodo(
  input: { threadId: string; followUpId: string },
  deps: {
    conversations: ConversationStore;
    todos: ProjectTodoStore;
    readAttachment: (attachment: PromptImageAttachment) => Promise<string>;
    thumbnail: (bytes: Buffer) => string;
  },
) {
  const source = deps.conversations.getThreadFollowUp(input.threadId, input.followUpId);
  if (!source || source.status !== "queued") throw new Error("Follow-up message is no longer queued.");
  const thread = deps.conversations.getThread(input.threadId);
  if (!thread) throw new Error("Thread was not found.");
  if ((source.attachments?.length ?? 0) > TODO_MAX_IMAGES) {
    throw new Error(`A todo supports at most ${TODO_MAX_IMAGES} images.`);
  }
  const images = await Promise.all((source.attachments ?? []).map(async (attachment) => {
    const data = await deps.readAttachment(attachment);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > TODO_MAX_IMAGE_BYTES) throw new Error("Todo image exceeds 5 MB.");
    return { id: randomUUID(), mediaType: attachment.mediaType, data, thumbnail: deps.thumbnail(bytes) };
  }));
  let todo: ProjectTodo | undefined;
  const followUp = deps.conversations.cancelThreadFollowUp(input.threadId, input.followUpId, (db, current) => {
    // Image loading yields to the event loop. Never archive a stale version if
    // another client edited the message while its originals were being read.
    if (stableHash(current) !== stableHash(source)) throw new Error("Queued message changed. Refresh and try again.");
    todo = deps.todos.saveInCurrentTransaction({
      projectPath: thread.workspacePath,
      text: current.prompt,
      images,
      completed: false,
      status: "pending",
    }, db);
  });
  if (!followUp || !todo) throw new Error("Follow-up message is no longer queued.");
  return { followUp, todo };
}
