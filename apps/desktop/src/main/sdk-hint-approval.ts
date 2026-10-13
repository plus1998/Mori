import type { SdkToolPermissionDecision, SdkToolPermissionRequest } from "@eco/runtime";
import type { EcoApprovalReviewResult } from "./eco-approval-reviewer";

/** SDK dialog hints govern UI/defaults and persistent rules, not one-shot model review. */
export async function resolveSdkHintPermission(input: {
  request: SdkToolPermissionRequest;
  confirmationMode: string;
  review: () => Promise<EcoApprovalReviewResult>;
  onReview: (result: EcoApprovalReviewResult) => void;
  requestHuman: (review?: EcoApprovalReviewResult) => Promise<SdkToolPermissionDecision>;
}): Promise<SdkToolPermissionDecision> {
  if (input.confirmationMode === "auto") {
    const result = await input.review();
    input.onReview(result);
    if (result.action === "allow") return { behavior: "allow", updatedInput: input.request.input };
    if (result.action === "deny") return { behavior: "deny", message: result.rationale, interrupt: false };
    return input.requestHuman(result);
  }
  return input.requestHuman();
}
