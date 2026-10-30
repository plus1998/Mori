export interface ApprovalFeedback {
  toolLabel: string;
  feedback: string;
}

/** Decode only the complete envelope emitted by injectCodexApprovalFeedback.
 * Keep model instructions in storage; show the user's feedback in the feed.
 */
export function parseApprovalFeedback(text: string): ApprovalFeedback | undefined {
  const match =
    /^The user rejected the preceding ([^\r\n]+) approval\.\r?\nUser feedback: ([\s\S]+)\r?\nDo not retry the rejected request unless the user explicitly asks for it again\.$/.exec(
      text.trim(),
    );
  const feedback = match?.[2]?.trim();
  if (!match?.[1] || !feedback) return undefined;
  return { toolLabel: match[1], feedback };
}
