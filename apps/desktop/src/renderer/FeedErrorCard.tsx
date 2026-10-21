import { ChevronDown, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import "./FeedErrorCard.css";

interface FeedErrorCardProps {
  message: ReactNode;
  context?: ReactNode;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  title?: string;
}

export function FeedErrorCard({
  message,
  context,
  detail,
  actionLabel,
  onAction,
  title,
}: FeedErrorCardProps) {
  const copy = (
    <>
      {context ? <span className="feed-error-card-context">{context}</span> : null}
      <span className="feed-error-card-message">{message}</span>
    </>
  );

  return (
    <section className="feed-error-card" role="alert" {...(title ? { title } : {})}>
      <CircleAlert className="feed-error-card-icon" size={18} strokeWidth={1.8} aria-hidden />
      {detail ? (
        <details className="feed-error-card-details">
          <summary className="feed-error-card-copy">
            {copy}
            <ChevronDown className="feed-error-card-disclosure" size={14} strokeWidth={2} aria-hidden />
          </summary>
          <pre className="feed-error-card-detail">{detail}</pre>
        </details>
      ) : (
        <div className="feed-error-card-copy">{copy}</div>
      )}
      {onAction && actionLabel ? (
        <button
          type="button"
          className="feed-error-card-retry"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onAction();
          }}
        >
          {actionLabel}
        </button>
      ) : null}
    </section>
  );
}
