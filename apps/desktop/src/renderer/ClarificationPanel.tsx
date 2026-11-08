import { ChevronLeft, ChevronRight, Info, Loader2, Pencil, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CLARIFICATION_CUSTOM_OPTION_LABEL,
  isClarificationQuestionReady,
  resolveClarificationQuestionAnswer,
} from "../shared/clarification";
import type { ClarificationAnswers, ClarificationRequest } from "../shared/ipc";

interface ClarificationPanelProps {
  request: ClarificationRequest;
  busy?: boolean;
  variant?: "feed" | "dock";
  onSubmit: (answers: ClarificationAnswers) => void;
  onDismiss: () => void;
}

const RECOMMENDED_LABEL_SUFFIX = /\s*(?:\(Recommended\)|（Recommended）|（推荐）)$/i;

function isRecommendedOption(option: { label: string; recommended?: boolean }): boolean {
  return option.recommended === true || RECOMMENDED_LABEL_SUFFIX.test(option.label);
}

function formatOptionLabel(label: string): string {
  return label.replace(RECOMMENDED_LABEL_SUFFIX, "").trim();
}

export function ClarificationPanel({
  request,
  busy,
  variant = "feed",
  onSubmit,
  onDismiss,
}: ClarificationPanelProps) {
  const { t } = useTranslation();
  const total = request.questions.length;
  const [questionIndex, setQuestionIndex] = useState(0);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [selections, setSelections] = useState<string[][]>(() =>
    request.questions.map((question) =>
      question.options.every((option) => option.label === CLARIFICATION_CUSTOM_OPTION_LABEL)
        ? [CLARIFICATION_CUSTOM_OPTION_LABEL]
        : [],
    ),
  );
  const [customTexts, setCustomTexts] = useState<string[]>(() => request.questions.map(() => ""));
  const customInputRef = useRef<HTMLTextAreaElement>(null);
  const selectionsRef = useRef(selections);
  const customTextsRef = useRef(customTexts);
  selectionsRef.current = selections;
  customTextsRef.current = customTexts;

  const question = request.questions[questionIndex];
  const displayOptions = useMemo(() => {
    if (!question) {
      return [];
    }
    const hasCustomRow = question.options.some(
      (option) => option.label === CLARIFICATION_CUSTOM_OPTION_LABEL,
    );
    if (hasCustomRow) {
      return question.options;
    }
    return [
      ...question.options,
      {
        label: CLARIFICATION_CUSTOM_OPTION_LABEL,
        description: t("approval.clarification.customDescription"),
      },
    ];
  }, [question, t]);

  const optionCount = displayOptions.length;
  const customInputOnly =
    optionCount === 1 && displayOptions[0]?.label === CLARIFICATION_CUSTOM_OPTION_LABEL;

  const recommendedIndex = useMemo(() => {
    if (!question) {
      return -1;
    }
    return displayOptions.findIndex(isRecommendedOption);
  }, [question, displayOptions]);

  const currentSelection = selections[questionIndex] ?? [];
  const currentCustomText = customTexts[questionIndex] ?? "";
  const questionReady = isClarificationQuestionReady(currentSelection, currentCustomText);
  const showCustomInput = currentSelection.includes(CLARIFICATION_CUSTOM_OPTION_LABEL);

  useEffect(() => {
    setHighlightIndex(recommendedIndex >= 0 ? recommendedIndex : 0);
  }, [questionIndex, recommendedIndex]);

  useEffect(() => {
    if (!showCustomInput || busy) {
      return;
    }
    customInputRef.current?.focus();
  }, [showCustomInput, questionIndex, busy]);

  const submitAll = useCallback(
    (selectionRows: string[][] = selectionsRef.current, texts: string[] = customTextsRef.current) => {
      const finalSelections = request.questions.map((_, index) =>
        resolveClarificationQuestionAnswer(selectionRows[index] ?? [], texts[index] ?? ""),
      );
      onSubmit({ toolUseId: request.toolUseId, selections: finalSelections });
    },
    [onSubmit, request.questions, request.toolUseId],
  );

  /**
   * Single-select fixed option: intermediate → next question; last → submit immediately.
   * Custom option only selects and focuses the free-form field.
   */
  function commitSingleSelect(selectionRows: string[][], nextSelection: string[]) {
    if (!question || question.multiSelect) {
      return;
    }
    if (nextSelection.includes(CLARIFICATION_CUSTOM_OPTION_LABEL)) {
      return;
    }
    const customText = customTextsRef.current[questionIndex] ?? "";
    if (!isClarificationQuestionReady(nextSelection, customText)) {
      return;
    }
    if (questionIndex >= total - 1) {
      submitAll(selectionRows, customTextsRef.current);
      return;
    }
    setQuestionIndex((index) => index + 1);
  }

  function selectOption(optionLabel: string) {
    if (!question || busy) {
      return;
    }
    setSelections((current) => {
      const next = current.map((row) => [...row]);
      let nextSelection: string[] = [];
      if (question.multiSelect) {
        const row = next[questionIndex] ?? [];
        if (optionLabel === CLARIFICATION_CUSTOM_OPTION_LABEL) {
          next[questionIndex] = row.includes(optionLabel)
            ? row.filter((item) => item !== optionLabel)
            : [...row.filter((item) => item !== CLARIFICATION_CUSTOM_OPTION_LABEL), optionLabel];
        } else {
          next[questionIndex] = row.includes(optionLabel)
            ? row.filter((item) => item !== optionLabel)
            : [...row, optionLabel];
        }
        nextSelection = next[questionIndex] ?? [];
      } else {
        next[questionIndex] = [optionLabel];
        nextSelection = next[questionIndex] ?? [];
        queueMicrotask(() => commitSingleSelect(next, nextSelection));
      }
      return next;
    });
  }

  function completeCurrentQuestion() {
    if (!question || !questionReady || busy) {
      return;
    }
    if (questionIndex >= total - 1) {
      submitAll();
      return;
    }
    setQuestionIndex((index) => index + 1);
  }

  function submitCustomFromInput() {
    if (!question || busy) {
      return;
    }
    const selection = selectionsRef.current[questionIndex] ?? [];
    const customText = customTextsRef.current[questionIndex] ?? "";
    if (!selection.includes(CLARIFICATION_CUSTOM_OPTION_LABEL)) {
      return;
    }
    if (!isClarificationQuestionReady(selection, customText)) {
      return;
    }
    if (questionIndex >= total - 1) {
      submitAll(selectionsRef.current, customTextsRef.current);
      return;
    }
    setQuestionIndex((index) => index + 1);
  }

  const isLastQuestion = questionIndex >= total - 1;
  const docked = variant === "dock";
  const showConfirmFooter = Boolean(question?.multiSelect && isLastQuestion);
  const showMultiSelectContinue = Boolean(question?.multiSelect && !isLastQuestion);
  const showBusyFooter = Boolean(busy && isLastQuestion && !question?.multiSelect);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (busy || !question) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const inCustomField = target?.tagName === "TEXTAREA";

      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (inCustomField) {
        // Custom free-form: Enter submits (or advances) when ready; Shift+Enter keeps newline.
        if (event.key === "Enter" && !event.shiftKey) {
          if (
            !isClarificationQuestionReady(
              selectionsRef.current[questionIndex] ?? [],
              customTextsRef.current[questionIndex] ?? "",
            )
          ) {
            return;
          }
          event.preventDefault();
          submitCustomFromInput();
        }
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightIndex((index) => (index + 1) % Math.max(optionCount, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightIndex((index) => (index - 1 + Math.max(optionCount, 1)) % Math.max(optionCount, 1));
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const option = displayOptions[highlightIndex];
        if (!option) {
          return;
        }
        if (option.label === CLARIFICATION_CUSTOM_OPTION_LABEL) {
          selectOption(option.label);
          return;
        }
        if (question.multiSelect) {
          selectOption(option.label);
          return;
        }
        setSelections((current) => {
          const next = current.map((row) => [...row]);
          next[questionIndex] = [option.label];
          const nextSelection = next[questionIndex] ?? [];
          queueMicrotask(() => commitSingleSelect(next, nextSelection));
          return next;
        });
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, question, highlightIndex, optionCount, questionIndex, total, onDismiss, displayOptions]);

  if (!question) {
    return null;
  }

  const panelBody = (
    <>
      <header className="clarification-top">
        <p className="clarification-title">{question.question}</p>
        <div className="clarification-header-actions">
          {total > 1 ? (
            <div className="clarification-pagination">
              <button
                type="button"
                className="clarification-page-btn"
                disabled={busy || questionIndex === 0}
                onClick={() => setQuestionIndex((index) => index - 1)}
                aria-label={t("approval.clarification.previous")}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="clarification-page-label">
                {questionIndex + 1} / {total}
              </span>
              <button
                type="button"
                className="clarification-page-btn"
                disabled={busy || questionIndex >= total - 1 || !questionReady}
                onClick={() => setQuestionIndex((index) => index + 1)}
                aria-label={t("approval.clarification.next")}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          ) : null}
          {docked ? (
            <button
              type="button"
              className="clarification-close"
              disabled={busy}
              onClick={onDismiss}
              aria-label={t("approval.clarification.close")}
            >
              <X size={18} />
            </button>
          ) : null}
        </div>
      </header>

      {!customInputOnly ? (
        <ul className="clarification-option-list" aria-label={t("approval.clarification.options")}>
          {displayOptions.map((option, optionIndex) => {
            const selected = currentSelection.includes(option.label);
            const highlighted = highlightIndex === optionIndex;
            const recommended = isRecommendedOption(option);
            return (
              <li key={option.label}>
                <button
                  type="button"
                  aria-pressed={selected}
                  className={[
                    "clarification-option-row",
                    selected ? "is-selected" : "",
                    highlighted ? "is-highlighted" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  disabled={busy}
                  onMouseEnter={() => setHighlightIndex(optionIndex)}
                  onClick={() => selectOption(option.label)}
                >
                  <span className="clarification-option-index">
                    {option.label === CLARIFICATION_CUSTOM_OPTION_LABEL ? (
                      <Pencil size={14} strokeWidth={1.75} aria-hidden />
                    ) : (
                      optionIndex + 1
                    )}
                  </span>
                  <span className="clarification-option-body">
                    <span className="clarification-option-label">
                      {formatOptionLabel(option.label)}
                      {recommended ? (
                        <span className="clarification-recommended">
                          {t("approval.clarification.recommended")}
                        </span>
                      ) : null}
                    </span>
                    {option.description ? (
                      <span className="clarification-option-desc">{option.description}</span>
                    ) : null}
                  </span>
                  {option.description ? (
                    <span className="clarification-info" title={option.description}>
                      <Info size={14} aria-hidden />
                    </span>
                  ) : null}
                  {docked && selected && option.label !== CLARIFICATION_CUSTOM_OPTION_LABEL ? (
                    <ChevronRight className="clarification-option-arrow" size={18} aria-hidden />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {showCustomInput ? (
        <div className="clarification-custom">
          <label className="clarification-custom-label" htmlFor={`clarification-custom-${request.toolUseId}`}>
            {t("approval.clarification.customLabel")}
            {!currentCustomText.trim() ? (
              <span className="clarification-custom-required">{t("approval.clarification.required")}</span>
            ) : null}
          </label>
          <textarea
            id={`clarification-custom-${request.toolUseId}`}
            ref={customInputRef}
            className="clarification-custom-input"
            disabled={busy}
            rows={3}
            placeholder={t("approval.clarification.placeholder")}
            value={currentCustomText}
            onChange={(event) => {
              const value = event.target.value;
              setCustomTexts((current) => {
                const next = [...current];
                next[questionIndex] = value;
                return next;
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                if (!isClarificationQuestionReady(currentSelection, currentCustomText)) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                submitCustomFromInput();
              }
            }}
          />
          <p className="clarification-custom-hint">{t("approval.clarification.customHint")}</p>
        </div>
      ) : null}

      <footer className="clarification-footer">
        {showBusyFooter ? (
          <button type="button" className="clarification-continue" disabled>
            <Loader2 size={14} className="spinning" aria-hidden />
            {t("approval.clarification.submitting")}
          </button>
        ) : null}
        {showConfirmFooter ? (
          <button
            type="button"
            className="clarification-continue"
            disabled={busy || !questionReady}
            onClick={completeCurrentQuestion}
          >
            {busy ? (
              <>
                <Loader2 size={14} className="spinning" aria-hidden />
                {t("approval.clarification.submitting")}
              </>
            ) : (
              t("approval.clarification.completeSelection")
            )}
          </button>
        ) : null}
        {showMultiSelectContinue ? (
          <>
            <button type="button" className="clarification-dismiss" disabled={busy} onClick={onDismiss}>
              {busy ? (
                <>
                  <Loader2 size={14} className="spinning" aria-hidden />
                  {t("common.processing")}
                </>
              ) : docked ? (
                t("common.skip")
              ) : (
                <>
                  {t("common.dismiss")} <kbd>ESC</kbd>
                </>
              )}
            </button>
            <button
              type="button"
              className="clarification-continue"
              disabled={busy || !questionReady}
              onClick={completeCurrentQuestion}
            >
              {t("approval.clarification.completeSelection")}
            </button>
          </>
        ) : null}
        {!isLastQuestion && !question.multiSelect ? (
          <button type="button" className="clarification-dismiss" disabled={busy} onClick={onDismiss}>
            {busy ? (
              <>
                <Loader2 size={14} className="spinning" aria-hidden />
                {t("common.processing")}
              </>
            ) : docked ? (
              t("common.skip")
            ) : (
              <>
                {t("common.dismiss")} <kbd>ESC</kbd>
              </>
            )}
          </button>
        ) : null}
      </footer>
    </>
  );

  if (docked) {
    return (
      <div className="codex-composer is-compact clarification-dock-shell">
        <section
          className="composer-primary clarification-dock-inner"
          aria-label={t("approval.clarification.label")}
        >
          {panelBody}
        </section>
      </div>
    );
  }

  return (
    <section className="clarification-panel codex-style" aria-label={t("approval.clarification.label")}>
      {panelBody}
    </section>
  );
}
