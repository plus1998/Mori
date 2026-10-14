import type { SdkToolPermissionDecision, SdkToolPermissionRequest } from "@eco/runtime";
import { modelApprovalOutcome } from "./approval-model-outcome";
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
    const raw = await input.review();
    const result: EcoApprovalReviewResult =
      raw.action === "deny"
        ? { ...raw, action: "human_required", rationale: modelApprovalOutcome(raw).rationale }
        : raw;
    input.onReview(result);
    if (result.action === "allow") return { behavior: "allow", updatedInput: input.request.input };
    return input.requestHuman(result);
  }
  return input.requestHuman();
}
