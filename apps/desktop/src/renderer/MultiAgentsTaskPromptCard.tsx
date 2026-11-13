import { ChevronDown, GitFork } from "lucide-react";
import { useId, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MultiAgentsTaskPromptDisplay } from "../shared/multi-agents-task-prompt";
import { useActivityFeedLayoutChange } from "./activity-feed-layout-context";
import "./MultiAgentsTaskPromptCard.css";

export function MultiAgentsTaskPromptCard({
  task,
  prompt,
}: {
  task: MultiAgentsTaskPromptDisplay;
  prompt: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const onLayoutChange = useActivityFeedLayoutChange();
  useLayoutEffect(() => {
    onLayoutChange?.({ immediate: !expanded });
  }, [expanded, onLayoutChange]);

  return (
    <section className="multi-agents-task-prompt-card">
      <button
        type="button"
        className="multi-agents-task-prompt-trigger"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="multi-agents-task-prompt-icon">
          <GitFork size={16} aria-hidden />
        </span>
        <span className="multi-agents-task-prompt-heading">
          <span className="multi-agents-task-prompt-meta">
            <span>{t("activity.multiAgentsTask.title")}</span>
            <span className="multi-agents-task-prompt-member">{task.memberName}</span>
          </span>
          <span className="multi-agents-task-prompt-title">{task.title}</span>
          <span className="multi-agents-task-prompt-hint">
            {t(expanded ? "activity.multiAgentsTask.hidePrompt" : "activity.multiAgentsTask.showPrompt")}
          </span>
        </span>
        <ChevronDown
          size={14}
          className={`multi-agents-task-prompt-chevron${expanded ? " is-expanded" : ""}`}
          aria-hidden
        />
      </button>
      {expanded ? (
        <div id={bodyId} className="multi-agents-task-prompt-details">
          <pre>{prompt}</pre>
        </div>
      ) : null}
    </section>
  );
}
