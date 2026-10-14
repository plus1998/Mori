/** Model advice may auto-allow one action; an adverse prediction never rejects on the user's behalf. */
export function modelApprovalOutcome(review: {
  action: "allow" | "human_required" | "deny";
  rationale: string;
}): { action: "allow" | "human_required"; rationale: string } {
  return review.action === "deny"
    ? {
        action: "human_required",
        rationale: `审批模型建议拒绝，已转交用户决定。${review.rationale}`,
      }
    : { action: review.action, rationale: review.rationale };
}
