import { ChevronLeft, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CLARIFICATION_CUSTOM_OPTION_LABEL } from "../shared/clarification";
import type { ClarificationRequest } from "../shared/ipc";

export function ComposerClarification({
  request,
  index,
  text,
  busy,
  onPage,
  onSelect,
  onDismiss,
}: {
  request: ClarificationRequest;
  index: number;
  text: string;
  busy: boolean;
  onPage(index: number): void;
  onSelect(option: string): void;
  onDismiss(): void;
}) {
  const { t } = useTranslation();
  const question = request.questions[index]!;
  const options = question.options.filter(option => option.label !== CLARIFICATION_CUSTOM_OPTION_LABEL);
  return (
    <section className="composer-clarification" aria-label={t("approval.clarification.label")}>
      <header className="clarification-top">
        <p className="clarification-title">{question.question}</p>
        <div className="clarification-header-actions">
          {request.questions.length > 1 ? (
            <div className="clarification-pagination">
              <button type="button" className="clarification-page-btn"
                disabled={busy || index === 0} onClick={() => onPage(index - 1)}
                aria-label={t("approval.clarification.previous")}>
                <ChevronLeft size={16} />
              </button>
              <span className="clarification-page-label">{index + 1} / {request.questions.length}</span>
            </div>
          ) : null}
          <button type="button" className="clarification-close" disabled={busy} onClick={onDismiss}
            aria-label={t("approval.clarification.close")}>
            <X size={18} />
          </button>
        </div>
      </header>
      {options.length ? (
        <ul className="clarification-option-list" aria-label={t("approval.clarification.options")}>
          {options.map((option, i) => {
            const selected = text.trim() === option.label;
            return (
              <li key={option.label}>
                <button type="button" className={`clarification-option-row${selected ? " is-selected" : ""}`}
                  aria-pressed={selected} disabled={busy} onClick={() => onSelect(option.label)}>
                  <span className="clarification-option-index" aria-hidden>{i + 1}</span>
                  <span className="clarification-option-body">
                    <span className="clarification-option-label">{option.label}</span>
                    {option.description ? <span className="clarification-option-desc">{option.description}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
