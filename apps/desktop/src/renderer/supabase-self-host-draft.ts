import { composerReferenceToken } from "../shared/composer-references";
import type { SshBookmarkView } from "../shared/ssh-bookmarks";
import { sshBookmarkEndpointLabel } from "../shared/ssh-bookmarks";

/** The reference resolves connection details at send time; credentials stay in the bookmark store. */
export function appendSupabaseSelfHostDraft(
  previousPrompt: string,
  bookmark: SshBookmarkView,
  deploymentPrompt: string,
): string {
  const reference = composerReferenceToken({
    kind: "ssh",
    id: bookmark.id,
    label: bookmark.name,
    detail: sshBookmarkEndpointLabel(bookmark),
  });
  return [previousPrompt, `${reference}\n\n${deploymentPrompt}`].filter(Boolean).join("\n\n");
}
