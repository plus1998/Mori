import {
  Bell,
  Check,
  CircleCheck,
  FileCheck2,
  ListX,
  MessageSquare,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { thinkingPreviewLine } from "./activity-log";
import { composerFloatingStyleForAnchor, observeComposerFloatingViewport } from "./composer-floating";
import type { SidebarAttentionItem, SidebarAttentionKind } from "./sidebar-attention-items";

interface SidebarAttentionButtonProps {
  items: readonly SidebarAttentionItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectThread: (threadId: string) => void;
  onDismissItems: (items: readonly SidebarAttentionItem[]) => void;
  dismissalError?: boolean;
}

const kindLabelKey: Record<SidebarAttentionKind, string> = {
  question: "nav.attentionKind.question",
  plan: "nav.attentionKind.plan",
  bash: "nav.attentionKind.bash",
  completed: "nav.attentionKind.completed",
};

const kindIcon = { question: MessageSquare, plan: FileCheck2, bash: Terminal, completed: CircleCheck };

export function SidebarAttentionButton({
  items,
  open,
  onOpenChange,
  onSelectThread,
  onDismissItems,
  dismissalError = false,
}: SidebarAttentionButtonProps) {
  const { t } = useTranslation();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [floatingStyle, setFloatingStyle] = useState<CSSProperties>();
  const hasItems = items.length > 0;
  const groups = [
    {
      key: "pending",
      label: t("nav.attentionPending"),
      items: items.filter((item) => item.kind !== "completed"),
    },
    {
      key: "completed",
      label: t("nav.attentionKind.completed"),
      items: items.filter((item) => item.kind === "completed"),
    },
  ];
  const orderedItems = groups.flatMap((group) => group.items);
  const indexById = new Map(orderedItems.map((item, index) => [item.id, index]));

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const reposition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      if (rect.right <= 0 || getComputedStyle(triggerRef.current).visibility === "hidden") {
        onOpenChange(false);
        return;
      }
      const style = composerFloatingStyleForAnchor(triggerRef.current, {
        width: 344,
        margin: 12,
        gap: 8,
        align: "end",
        prefer: "below",
      });
      setFloatingStyle({ ...style, maxHeight: Math.min(Number(style.maxHeight), 520) });
    };
    reposition();
    const stopObservingViewport = observeComposerFloatingViewport(reposition);
    const observer = new ResizeObserver(reposition);
    observer.observe(rootRef.current?.closest(".sidebar-core-selector") ?? triggerRef.current);
    const sidebar = rootRef.current?.closest(".codex-sidebar");
    sidebar?.addEventListener("transitionend", reposition);
    return () => {
      stopObservingViewport();
      observer.disconnect();
      sidebar?.removeEventListener("transitionend", reposition);
    };
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (
        event.target instanceof Node &&
        !rootRef.current?.contains(event.target) &&
        !menuRef.current?.contains(event.target)
      ) {
        onOpenChange(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onOpenChange]);

  const panel = open ? (
    <div
      ref={menuRef}
      id={`${id}-panel`}
      className="sidebar-core-attention-menu"
      style={floatingStyle}
      role="dialog"
      aria-label={t("nav.attentionTitle")}
      tabIndex={-1}
    >
      <div className="sidebar-core-attention-menu-header">
        <div className="sidebar-core-attention-heading">
          <h2>{t("nav.attentionTitle")}</h2>
          {hasItems ? (
            <span className="sidebar-core-attention-count" aria-hidden>
              {items.length}
            </span>
          ) : null}
        </div>
        {hasItems ? (
          <button
            type="button"
            className="sidebar-core-attention-dismiss-all"
            onClick={() => {
              onDismissItems(items);
              requestAnimationFrame(() => {
                if (!menuRef.current?.contains(document.activeElement)) menuRef.current?.focus();
              });
            }}
          >
            <ListX size={13} aria-hidden />
            {t("nav.ignoreAllNotifications")}
          </button>
        ) : null}
      </div>
      {hasItems ? (
        <div className="sidebar-core-attention-scroll">
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <section
                key={group.key}
                className="sidebar-core-attention-group"
                aria-labelledby={`${id}-${group.key}`}
              >
                <h3 id={`${id}-${group.key}`} className="sidebar-core-attention-group-heading">
                  {group.label}
                  <span aria-hidden>{group.items.length}</span>
                </h3>
                <ul className="sidebar-core-attention-list">
                  {group.items.map((item) => {
                    const KindIcon = kindIcon[item.kind];
                    const index = indexById.get(item.id) ?? 0;
                    return (
                      <li key={item.id} className="sidebar-core-attention-row" data-kind={item.kind}>
                        <button
                          type="button"
                          className="sidebar-core-attention-item"
                          onClick={() => {
                            onSelectThread(item.threadId);
                            onOpenChange(false);
                          }}
                        >
                          <span className="sidebar-core-attention-item-icon" aria-hidden>
                            <KindIcon size={17} strokeWidth={1.7} />
                          </span>
                          <span className="sidebar-core-attention-item-copy">
                            {item.kind !== "completed" ? (
                              <span className="sidebar-core-attention-item-kind">
                                {t(kindLabelKey[item.kind])}
                              </span>
                            ) : null}
                            <span className="sidebar-core-attention-item-title">{item.title}</span>
                            {item.detail ? (
                              <span className="sidebar-core-attention-item-detail">
                                {item.kind === "bash" ? item.detail : thinkingPreviewLine(item.detail, 220)}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        <button
                          ref={(button) => {
                            if (button) dismissButtonRefs.current.set(item.id, button);
                            else dismissButtonRefs.current.delete(item.id);
                          }}
                          type="button"
                          className="sidebar-core-attention-dismiss"
                          aria-label={t("nav.ignoreNotificationFor", { title: item.title })}
                          title={t("nav.ignoreNotification")}
                          onClick={(event) => {
                            const button = event.currentTarget;
                            const nextId = orderedItems[index + 1]?.id ?? orderedItems[index - 1]?.id;
                            onDismissItems([item]);
                            requestAnimationFrame(() => {
                              if (button.isConnected) return;
                              const nextButton = nextId ? dismissButtonRefs.current.get(nextId) : undefined;
                              (nextButton ?? menuRef.current)?.focus();
                            });
                          }}
                        >
                          <X size={14} aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
        </div>
      ) : (
        <div className="sidebar-core-attention-empty" role="status">
          <span className="sidebar-core-attention-empty-icon" aria-hidden>
            <Bell size={25} strokeWidth={1.4} />
            <span>
              <Check size={10} strokeWidth={2.5} />
            </span>
          </span>
          <strong>{t("nav.attentionEmpty")}</strong>
          <p>{t("nav.attentionEmptyHint")}</p>
        </div>
      )}
      {dismissalError ? (
        <p className="sidebar-core-attention-error" role="alert">
          {t("nav.ignoreNotificationsError")}
        </p>
      ) : null}
      <p className="sidebar-core-attention-hint">
        <ShieldCheck size={13} aria-hidden />
        <span>{t("nav.ignoreNotificationsHint")}</span>
      </p>
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="sidebar-core-attention">
      <button
        ref={triggerRef}
        type="button"
        className="sidebar-core-search sidebar-core-attention-trigger"
        aria-label={t("nav.attention")}
        title={t("nav.attention")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        onClick={() => onOpenChange(!open)}
      >
        <Bell size={17} aria-hidden />
        {hasItems ? <span className="sidebar-core-attention-dot" aria-hidden /> : null}
      </button>

      {panel && typeof document !== "undefined" ? createPortal(panel, document.body) : panel}
    </div>
  );
}
