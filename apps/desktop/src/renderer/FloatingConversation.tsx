import { Check, ChevronUp, GripVertical, LoaderCircle, MessageSquare, Minus, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { ThreadRunProjectionTimelineItem } from "../shared/ipc";
import { floatingConversationResultPreview } from "./floating-conversation-result";
import { useFloatingConversationFocus } from "./use-floating-conversation-focus";
import { useFloatingConversationPosition } from "./use-floating-conversation-position";
import "./floating-conversation.css";

type FloatingStatus = "ready" | "running" | "attention";

/** Owns presentation only; the original Feed and Composer remain mounted. */
export function FloatingConversation({
  enabled, landing, paneRef, threadId, title, status, overlayHeight, timeline, requiresApproval,
  onRestore, onViewResult, composer, children,
}: {
  enabled: boolean;
  landing: boolean;
  paneRef: RefObject<HTMLDivElement | null>;
  threadId?: string | undefined;
  title?: string | undefined;
  status: FloatingStatus;
  overlayHeight: number;
  timeline?: readonly ThreadRunProjectionTimelineItem[] | undefined;
  requiresApproval: boolean;
  onRestore: () => void;
  onViewResult: () => void;
  composer: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [minimized, setMinimized] = useState(true);
  const [feedOpen, setFeedOpen] = useState(false);
  const [completionThreadId, setCompletionThreadId] = useState<string>();
  const [portalTarget, setPortalTarget] = useState<HTMLDivElement | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const ballRef = useRef<HTMLButtonElement>(null);
  const focus = useFloatingConversationFocus(enabled);
  const drag = useFloatingConversationPosition({ paneRef, conversationRef, ballRef, enabled: enabled && Boolean(portalTarget), minimized });
  const preview = useMemo(
    () => enabled && completionThreadId === threadId ? floatingConversationResultPreview(timeline ?? []) : "",
    [enabled, completionThreadId, threadId, timeline],
  );

  useEffect(() => {
    setPortalTarget(enabled ? paneRef.current : null);
  }, [enabled, paneRef]);

  useEffect(() => {
    if (!enabled) {
      setMinimized(true);
      setFeedOpen(false);
    }
    setCompletionThreadId(undefined);
    if (!enabled || !threadId) return;
    return window.eco?.onThreadEvent((event) => {
      if (!event || typeof event !== "object" || !("threadId" in event) || event.threadId !== threadId || !("type" in event)) return;
      if (event.type === "thread.completed") setCompletionThreadId(threadId);
      if (event.type === "thread.started") setCompletionThreadId(undefined);
    });
  }, [enabled, threadId]);

  const restore = (showFeed = requiresApproval) => {
    setMinimized(false);
    if (showFeed) setFeedOpen(true);
    setCompletionThreadId(undefined);
    requestAnimationFrame(onRestore);
  };
  const notification = enabled && !(feedOpen && focus.focused && !minimized) && completionThreadId === threadId && completionThreadId ? (
    <FloatingConversationNotification
      title={title ?? t("composer.floating.newConversation")}
      preview={preview}
      onOpen={() => {
        restore(true);
        requestAnimationFrame(onViewResult);
      }}
      onDismiss={() => setCompletionThreadId(undefined)}
    />
  ) : null;
  const statusLabel = status === "ready" ? "" : t(`composer.floating.${status}`);

  return (
    <>
      <div
        ref={conversationRef}
        className={[
          "codex-chat-shell", landing ? "is-landing" : "is-conversation",
          enabled ? "is-floating-conversation" : "",
          enabled && focus.focused ? "is-floating-active" : "",
          enabled && feedOpen && focus.focused ? "is-floating-feed-open" : "",
          enabled && minimized ? "is-floating-minimized" : "",
        ].filter(Boolean).join(" ")}
        inert={enabled && minimized ? true : undefined}
        {...focus.focusProps}
        onPointerDown={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return;
          if (event.target instanceof Element && event.target.closest("button, input, textarea, [contenteditable=true], a, [role], [draggable=true]")) return;
          drag.onPointerDown(event);
        }}
        onClickCapture={drag.onClickCapture}
        style={{ "--composer-input-overlays-height": `${enabled ? 0 : overlayHeight}px` } as CSSProperties}
      >
        {enabled ? (
          <div className="floating-conversation-header">
            <button type="button" className="floating-conversation-minimize"
              onClick={() => {
                setMinimized(true);
                requestAnimationFrame(() => ballRef.current?.focus({ preventScroll: true }));
              }}
              aria-label={t("composer.floating.minimize")} title={t("composer.floating.minimize")}>
              <Minus size={16} aria-hidden />
            </button>
            {status === "running" ? (
              <span className="floating-conversation-status" role="status" aria-label={statusLabel}>
                <LoaderCircle size={14} className="spinning" aria-hidden />
              </span>
            ) : null}
            <button type="button" className="floating-conversation-toggle"
              onClick={() => {
                setFeedOpen(open => !open);
                setCompletionThreadId(undefined);
              }} aria-expanded={feedOpen}
              aria-label={t(feedOpen ? "composer.floating.hideFeed" : "composer.floating.showFeed")}
              title={t(feedOpen ? "composer.floating.hideFeed" : "composer.floating.showFeed")}>
              <MessageSquare size={14} aria-hidden />
              <span>{title ?? t("composer.floating.newConversation")}</span>
              <ChevronUp size={14} className={feedOpen ? "is-expanded" : ""} aria-hidden />
            </button>
            <button type="button" className="floating-conversation-drag-handle" {...drag}
              aria-label={t("composer.floating.drag")} title={t("composer.floating.drag")}>
              <GripVertical size={14} aria-hidden />
            </button>
          </div>
        ) : null}
        {children}
        {composer}
      </div>
      {!minimized && notification && conversationRef.current ? createPortal(notification, conversationRef.current) : null}
      {enabled && minimized && portalTarget ? createPortal(
        <div className="floating-conversation-launcher">
          {notification}
          <button ref={ballRef} type="button" className="floating-conversation-ball" data-status={status}
            {...drag} onClick={() => restore()}
            aria-label={[t("composer.floating.restore"), statusLabel].filter(Boolean).join(" · ")}
            title={[t("composer.floating.restore"), statusLabel, t("composer.floating.drag")].filter(Boolean).join(" · ")}>
            <MessageSquare size={21} strokeWidth={1.75} aria-hidden />
            {status !== "ready" ? <span className="floating-conversation-ball-status" aria-hidden /> : null}
          </button>
        </div>, portalTarget,
      ) : null}
    </>
  );
}

export function FloatingConversationNotification({ title, preview, onOpen, onDismiss }: {
  title: string;
  preview: string;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const notificationRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = notificationRef.current;
    const anchor = card?.parentElement;
    const pane = anchor?.closest<HTMLElement>(".codex-main-pane");
    if (!card || !anchor || !pane) return;
    const place = () => {
      const bounds = pane.getBoundingClientRect();
      card.style.maxWidth = `${Math.max(0, bounds.width - 32)}px`;
      const surface = anchor.getBoundingClientRect();
      const size = card.getBoundingClientRect();
      const preferredLeft = anchor.classList.contains("floating-conversation-launcher") ? surface.right - size.width : surface.left;
      const left = Math.max(bounds.left + 16, Math.min(preferredLeft, bounds.right - 16 - size.width));
      const top = Math.max(bounds.top + 56, Math.min(surface.top - 14 - size.height, bounds.bottom - 16 - size.height));
      card.style.left = `${left - surface.left - anchor.clientLeft}px`;
      card.style.right = "auto";
      card.style.bottom = `${surface.bottom - (anchor.offsetHeight - anchor.clientHeight - anchor.clientTop) - top - size.height}px`;
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(card);
    resize.observe(anchor);
    resize.observe(pane);
    const position = new MutationObserver(place);
    position.observe(pane, { attributes: true, attributeFilter: ["style"] });
    return () => { resize.disconnect(); position.disconnect(); };
  }, []);
  return (
    <div ref={notificationRef} className="floating-conversation-notification" role="status">
      <button type="button" className="floating-conversation-notification-close"
        aria-label={t("composer.floating.dismissNotification")} onClick={onDismiss}>
        <X size={11} aria-hidden />
      </button>
      <button type="button" className="floating-conversation-notification-content" onClick={onOpen}
        aria-label={t("composer.floating.viewResult", { title })}>
        <span className="floating-conversation-notification-heading">
          <span className="floating-conversation-notification-check"><Check size={12} aria-hidden /></span>
          <strong>{title}</strong>
        </span>
        {preview ? <span className="floating-conversation-notification-preview">{preview}</span> : null}
      </button>
    </div>
  );
}
