import { Check, ChevronRight, Hand, Shield, ShieldAlert, Terminal } from "lucide-react";
import {
  type CSSProperties,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { BashReviewMode } from "../../../../packages/bash-policy/src";
import { BASH_REVIEW_UI, bashReviewUi } from "../shared/bash-review-ui";
import { ComposerHoverTooltip, useComposerIconOnlyToolbar } from "./ComposerHoverTooltip";
import { composerFloatingStyleForAnchor, observeComposerFloatingViewport } from "./composer-floating";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";

const POPOVER_WIDTH = 320;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;
const MIN_POPOVER_HEIGHT = 120;

interface ComposerBashReviewToggleProps {
  bashReviewMode: BashReviewMode;
  canEdit: boolean;
  saving?: boolean | undefined;
  onToggle: (bashReviewMode: BashReviewMode) => void;
  variant?: "toolbar" | "menu";
}

export function ComposerBashReviewToggle({
  bashReviewMode,
  canEdit,
  saving,
  onToggle,
  variant = "toolbar",
}: ComposerBashReviewToggleProps) {
  const { t } = useTranslation();
  const iconOnly = useComposerIconOnlyToolbar();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));

  const clickable = canEdit && !saving;
  const current = bashReviewUi(bashReviewMode);
  const className = ["composer-toolbar-trigger", clickable ? "is-clickable" : "", open ? "is-active" : ""]
    .filter(Boolean)
    .join(" ");

  const updatePanelPosition = useCallback(() => {
    const anchor = buttonRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(
      composerFloatingStyleForAnchor(anchor, {
        width: POPOVER_WIDTH,
        minHeight: MIN_POPOVER_HEIGHT,
        prefer: "above",
        align: "start",
        margin: VIEWPORT_MARGIN,
        gap: ANCHOR_GAP,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePanelPosition();
    const stopObservingViewport = observeComposerFloatingViewport(updatePanelPosition);
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
      stopObservingViewport();
      window.removeEventListener("resize", updatePanelPosition);
      window.removeEventListener("scroll", updatePanelPosition, true);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function selectMode(mode: BashReviewMode) {
    if (mode !== bashReviewMode) {
      onToggle(mode);
    }
    setOpen(false);
  }

  const control = clickable ? (
    <button
      ref={buttonRef}
      type="button"
      className={className}
      data-mode={bashReviewMode}
      disabled={saving}
      aria-pressed={bashReviewMode !== "allow_all"}
      aria-label={t(current.title)}
      aria-expanded={open}
      onClick={() => setOpen((currentOpen) => !currentOpen)}
    >
      <span className="composer-toolbar-trigger-icon" aria-hidden>
        <BashReviewToolbarIcon mode={bashReviewMode} />
      </span>
      {iconOnly && variant !== "menu" ? null : <span className="composer-toolbar-trigger-label">{t(current.title)}</span>}
      {variant === "menu" ? <ChevronRight size={14} aria-hidden /> : null}
    </button>
  ) : (
    <span className={className} data-mode={bashReviewMode} aria-label={t("bash.review.readonlyTitle")}>
      <span className="composer-toolbar-trigger-icon" aria-hidden>
        <BashReviewToolbarIcon mode={bashReviewMode} />
      </span>
      {iconOnly && variant !== "menu" ? null : <span className="composer-toolbar-trigger-label">{t(current.title)}</span>}
    </span>
  );

  return (
    <>
      <ComposerHoverTooltip content={t(current.title)} disabled={variant === "menu" || !iconOnly || open}>
        <span className="composer-orchestration-wrap">{control}</span>
      </ComposerHoverTooltip>
      {open && clickable ? (
        <ComposerBashReviewPopover
          panelRef={panelRef}
          panelStyle={variant === "menu" ? { ...panelStyle, zIndex: 10001 } : panelStyle}
          bashReviewMode={bashReviewMode}
          disabled={Boolean(saving)}
          onSelect={selectMode}
        />
      ) : null}
    </>
  );
}

function ComposerBashReviewPopover({
  panelRef,
  panelStyle,
  bashReviewMode,
  disabled,
  onSelect,
}: {
  panelRef: RefObject<HTMLDivElement | null>;
  panelStyle: CSSProperties;
  bashReviewMode: BashReviewMode;
  disabled: boolean;
  onSelect: (mode: BashReviewMode) => void;
}) {
  const { t } = useTranslation();
  return createPortal(
    <div
      ref={panelRef}
      className="composer-codex-popover composer-bash-review-popover"
      role="dialog"
      aria-label={t("bash.review.popoverLabel")}
      style={panelStyle}
    >
      <header className="composer-codex-popover-header">
        <p className="composer-codex-popover-title">{t("bash.review.popoverTitle")}</p>
      </header>
      <ul className="composer-codex-popover-list">
        {BASH_REVIEW_UI.map((option) => {
          const selected = option.value === bashReviewMode;
          return (
            <li key={option.value}>
              <button
                type="button"
                className={selected ? "composer-codex-popover-item active" : "composer-codex-popover-item"}
                disabled={disabled}
                aria-pressed={selected}
                onClick={() => onSelect(option.value)}
              >
                <span className="composer-bash-review-popover-icon" data-mode={option.value} aria-hidden>
                  <BashReviewModeIcon mode={option.value} />
                </span>
                <span className="composer-codex-popover-body">
                  <span className="composer-codex-popover-item-title">{t(option.title)}</span>
                  <span className="composer-codex-popover-item-desc">{t(option.description)}</span>
                </span>
                <span
                  className={
                    selected ? "composer-codex-popover-check" : "composer-codex-popover-check is-placeholder"
                  }
                  aria-hidden
                >
                  <Check size={14} strokeWidth={2.25} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

function BashReviewToolbarIcon({ mode }: { mode: BashReviewMode }) {
  if (mode === "always") {
    return <Hand size={14} strokeWidth={1.75} />;
  }
  if (mode === "auto") {
    return <Shield size={14} strokeWidth={1.75} />;
  }
  return <ShieldAlert size={14} strokeWidth={1.75} />;
}

function BashReviewModeIcon({ mode }: { mode: BashReviewMode }) {
  if (mode === "always") {
    return <Hand size={COMPOSER_TOOLBAR_ICON_PX} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />;
  }
  if (mode === "auto") {
    return (
      <span className="composer-bash-review-icon-stack">
        <Shield size={COMPOSER_TOOLBAR_ICON_PX} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />
        <Terminal size={7} strokeWidth={2.25} className="composer-bash-review-icon-badge" />
      </span>
    );
  }
  return <ShieldAlert size={COMPOSER_TOOLBAR_ICON_PX} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} />;
}
