import type { ThreadPendingFollowUp } from "../shared/ipc";
import { formatThreadFollowUpPreview } from "./thread-follow-up-ui";
import { UserPromptBodyContent } from "./UserPromptBodyContent";

export function FollowUpPromptPreview({ followUp }: { followUp: ThreadPendingFollowUp }) {
  // Parse complete reference tokens; the single-line layout handles truncation.
  return (
    <span className="follow-up-card-text">
      <UserPromptBodyContent text={formatThreadFollowUpPreview(followUp, Infinity)} interactive={false} />
    </span>
  );
}
