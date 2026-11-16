import { Bell, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
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

export function SidebarAttentionButton({
  items,
  open,
  onOpenChange,
  onSelectThread,
  onDismissItems,
  dismissalError = false,
}: SidebarAttentionButtonProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const hasItems = items.length > 0;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
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
        onClick={() => onOpenChange(!open)}
      >
        <Bell size={17} aria-hidden />
        {hasItems ? <span className="sidebar-core-attention-dot" aria-hidden /> : null}
      </button>

      {open ? (
        <div
          ref={menuRef}
          className="sidebar-core-attention-menu"
          role="dialog"
          aria-label={t("nav.attentionTitle")}
          tabIndex={-1}
        >
          <div className="sidebar-core-attention-menu-header">
            <span>{t("nav.attentionTitle")}</span>
            {hasItems ? (
              <button
                type="button"
                className="sidebar-core-attention-dismiss-all"
                onClick={() => {
                  onDismissItems(items);
                  requestAnimationFrame(() => {
                    if (!rootRef.current?.contains(document.activeElement)) menuRef.current?.focus();
                  });
                }}
              >
                {t("nav.ignoreAllNotifications")}
              </button>
            ) : null}
          </div>
          {hasItems ? (
            <ul className="sidebar-core-attention-list">
              {items.map((item, index) => (
                <li key={item.id} className="sidebar-core-attention-row">
                  <button
                    type="button"
                    className="sidebar-core-attention-item"
                    onClick={() => {
                      onSelectThread(item.threadId);
                      onOpenChange(false);
                    }}
                  >
                    <span className="sidebar-core-attention-item-kind">{t(kindLabelKey[item.kind])}</span>
                    <span className="sidebar-core-attention-item-title">{item.title}</span>
                    {item.detail ? (
                      <span className="sidebar-core-attention-item-detail">{item.detail}</span>
                    ) : null}
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
                      const nextId = items[index + 1]?.id ?? items[index - 1]?.id;
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
              ))}
            </ul>
          ) : (
            <p className="sidebar-core-attention-empty" role="status">
              {t("nav.attentionEmpty")}
            </p>
          )}
          {dismissalError ? (
            <p className="sidebar-core-attention-error" role="alert">
              {t("nav.ignoreNotificationsError")}
            </p>
          ) : null}
          <p className="sidebar-core-attention-hint">{t("nav.ignoreNotificationsHint")}</p>
        </div>
      ) : null}
    </div>
  );
}
