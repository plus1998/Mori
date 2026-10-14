import { Bell } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SidebarAttentionItem, SidebarAttentionKind } from "./sidebar-attention-items";

interface SidebarAttentionButtonProps {
  items: readonly SidebarAttentionItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectThread: (threadId: string) => void;
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
}: SidebarAttentionButtonProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const hasItems = items.length > 0;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        onOpenChange(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
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
        <div className="sidebar-core-attention-menu" role="dialog" aria-label={t("nav.attentionTitle")}>
          <div className="sidebar-core-attention-menu-header">{t("nav.attentionTitle")}</div>
          {hasItems ? (
            <ul className="sidebar-core-attention-list">
              {items.map((item) => (
                <li key={item.id}>
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
                </li>
              ))}
            </ul>
          ) : (
            <p className="sidebar-core-attention-empty">{t("nav.attentionEmpty")}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
