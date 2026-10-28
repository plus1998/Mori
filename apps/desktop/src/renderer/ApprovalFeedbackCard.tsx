import { ShieldX } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ApprovalFeedback } from "../shared/approval-feedback";
import "./ApprovalFeedbackCard.css";

export function ApprovalFeedbackCard({ feedback }: { feedback: ApprovalFeedback }) {
  const { t } = useTranslation();
  return (
    <section
      className="approval-feedback-card"
      aria-label={t("activity.approvalRejected", { tool: feedback.toolLabel })}
    >
      <div className="approval-feedback-header">
        <ShieldX size={16} strokeWidth={1.8} aria-hidden />
        <span>{t("activity.approvalRejected", { tool: feedback.toolLabel })}</span>
      </div>
      <div className="approval-feedback-label">{t("activity.approvalFeedback")}</div>
      <div className="approval-feedback-body">{feedback.feedback}</div>
    </section>
  );
}
