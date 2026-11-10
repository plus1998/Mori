import { composerReferences, composerReferenceToken, type ComposerReference } from "../shared/composer-references";
import type { ThreadSummary } from "../shared/ipc";

export const CONVERSATION_REFERENCE_DRAG_MIME = "application/x-mori-conversation-reference";

export function startConversationReferenceDrag(
  transfer: DataTransfer,
  thread: Pick<ThreadSummary, "id" | "title" | "workspacePath">,
): void {
  const token = composerReferenceToken({
    kind: "conversation", id: thread.id, label: thread.title, detail: thread.workspacePath,
  });
  transfer.setData(CONVERSATION_REFERENCE_DRAG_MIME, token);
  transfer.setData("text/plain", token);
  transfer.effectAllowed = "copy";
}

export function readConversationReferenceDrag(transfer: DataTransfer): ComposerReference | undefined {
  const token = transfer.getData(CONVERSATION_REFERENCE_DRAG_MIME);
  const [reference] = composerReferences(token);
  if (reference?.kind !== "conversation" || composerReferenceToken(reference) !== token) return undefined;
  return reference;
}
