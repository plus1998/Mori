import { Check, Clock3, Image, LayoutTemplate, Plus, X } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { type SessionMode, togglePlusMenuSessionMode } from "../shared/session-mode";
import { sessionModeUi } from "../shared/session-mode-ui";
import { ComposerHoverTooltip, useComposerIconOnlyToolbar } from "./ComposerHoverTooltip";
import { SessionModeIcon } from "./ComposerPlanModeToggle";
import { clampComposerFloatingLeft, composerFloatingAvailableWidth } from "./composer-floating";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";

const MENU_WIDTH = 220;
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

export type ComposerPlusMenuAction = "plan" | "ask" | "image" | "route" | "scheduled-message";

function menuStyleForAnchor(anchor: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(MENU_WIDTH, composerFloatingAvailableWidth(VIEWPORT_MARGIN));
  const spaceAbove = rect.top - VIEWPORT_MARGIN;
  const preferredBottom = window.innerHeight - rect.top + ANCHOR_GAP;
  const openAbove = spaceAbove >= 160;
  if (openAbove) {
    return {
      position: "fixed",
      left: clampComposerFloatingLeft(rect.left, width, VIEWPORT_MARGIN),
      bottom: preferredBottom,
      width,
      zIndex: 10000,
    };
  }
  return {
    position: "fixed",
    left: clampComposerFloatingLeft(rect.left, width, VIEWPORT_MARGIN),
    top: rect.bottom + ANCHOR_GAP,
    width,
    zIndex: 10000,
  };
}

interface ComposerPlusMenuProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
  sessionMode: SessionMode;
  canEditMode: boolean;
  canOpenRoute: boolean;
  showRoute?: boolean | undefined;
  saving?: boolean | undefined;
  onSelectMode: (sessionMode: SessionMode) => void;
  onPickImage: () => void;
  onOpenRoute: () => void;
  onAddScheduledMessage?: (() => void) | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

export function ComposerPlusMenu({
  buttonRef,
  sessionMode,
  canEditMode,
  canOpenRoute,
  showRoute = true,
  saving,
  onSelectMode,
  onPickImage,
  onOpenRoute,
  onAddScheduledMessage,
  onOpenChange,
}: ComposerPlusMenuProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>(() => ({ visibility: "hidden" }));

  const setMenuOpen = useCallback(
    (next: boolean) => {
      if (openRef.current === next) {
        return;
      }
      openRef.current = next;
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const updatePanelPosition = useCallback(() => {
    const anchor = buttonRef.current;
    if (!anchor) {
      return;
    }
    setPanelStyle(menuStyleForAnchor(anchor));
  }, [buttonRef]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePanelPosition();
    window.addEventListener("resize", updatePanelPosition);
    window.addEventListener("scroll", updatePanelPosition, true);
    return () => {
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
      setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, buttonRef, setMenuOpen]);

  function handleAction(action: ComposerPlusMenuAction) {
    setMenuOpen(false);
    // Defer so the menu unmounts before nested popovers / file picker open.
    window.setTimeout(() => {
      switch (action) {
        case "plan":
        case "ask":
          if (canEditMode && !saving) {
            onSelectMode(togglePlusMenuSessionMode(sessionMode, action));
          }
          break;
        case "image":
          onPickImage();
          break;
        case "route":
          if (canOpenRoute) {
            onOpenRoute();
          }
          break;
        case "scheduled-message":
          onAddScheduledMessage?.();
          break;
      }
    }, 0);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={["composer-plus-trigger", open ? "is-active" : ""].filter(Boolean).join(" ")}
        title={t("composer.plus.menu")}
        aria-label={t("composer.plus.menu")}
        aria-expanded={open}
        onClick={() => setMenuOpen(!open)}
      >
        <Plus size={COMPOSER_TOOLBAR_ICON_PX} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} aria-hidden />
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="composer-codex-popover composer-plus-menu"
              role="menu"
              aria-label={t("composer.plus.menu")}
              style={panelStyle}
            >
              <ComposerPlusMenuPanel
                sessionMode={sessionMode}
                canEditMode={canEditMode}
                canOpenRoute={canOpenRoute}
                showRoute={showRoute}
                {...(saving !== undefined ? { saving } : {})}
                onSelectMode={(mode) => {
                  if (mode === "plan" || mode === "ask") {
                    handleAction(mode);
                  }
                }}
                onPickImage={() => handleAction("image")}
                onOpenRoute={() => handleAction("route")}
                onAddScheduledMessage={onAddScheduledMessage ? () => handleAction("scheduled-message") : undefined}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function ComposerPlusMenuPanel({
  sessionMode,
  canEditMode,
  canOpenRoute,
  showRoute = true,
  saving,
  onSelectMode,
  onPickImage,
  onOpenRoute,
  onAddScheduledMessage,
}: {
  sessionMode: SessionMode;
  canEditMode: boolean;
  canOpenRoute: boolean;
  showRoute?: boolean | undefined;
  saving?: boolean | undefined;
  onSelectMode: (sessionMode: SessionMode) => void;
  onPickImage: () => void;
  onOpenRoute: () => void;
  onAddScheduledMessage?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <ul className="composer-plus-menu-list">
      <PlusMenuRow
        icon={<SessionModeIcon mode="plan" />}
        label={sessionModeUi("plan").title}
        selected={sessionMode === "plan"}
        disabled={!canEditMode || Boolean(saving)}
        onSelect={() => onSelectMode("plan")}
      />
      <PlusMenuRow
        icon={<SessionModeIcon mode="ask" />}
        label={sessionModeUi("ask").title}
        selected={sessionMode === "ask"}
        disabled={!canEditMode || Boolean(saving)}
        onSelect={() => onSelectMode("ask")}
      />
      <li className="composer-plus-menu-divider" aria-hidden />
      <PlusMenuRow
        icon={<Image size={18} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} aria-hidden />}
        label={t("composer.plus.image")}
        onSelect={onPickImage}
      />
      {onAddScheduledMessage ? <PlusMenuRow
        icon={<Clock3 size={18} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} aria-hidden />}
        label={t("scheduling.messageAction")}
        onSelect={onAddScheduledMessage}
      /> : null}
      {showRoute ? (
        <PlusMenuRow
          icon={<LayoutTemplate size={18} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} aria-hidden />}
          label={t("composer.plus.route")}
          disabled={!canOpenRoute}
          onSelect={onOpenRoute}
        />
      ) : null}
    </ul>
  );
}

function PlusMenuRow({
  icon,
  label,
  selected = false,
  disabled = false,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <li role="none">
      <button
        type="button"
        role="menuitem"
        className={["composer-plus-menu-item", selected ? "is-selected" : ""].filter(Boolean).join(" ")}
        disabled={disabled}
        aria-checked={selected || undefined}
        onClick={onSelect}
      >
        <span className="composer-plus-menu-item-icon" aria-hidden>
          {icon}
        </span>
        <span className="composer-plus-menu-item-label">{label}</span>
        {selected ? (
          <span className="composer-plus-menu-item-check" aria-hidden>
            <Check size={14} strokeWidth={2.25} />
          </span>
        ) : null}
      </button>
    </li>
  );
}

interface ComposerSessionModeTagProps {
  mode: SessionMode;
  onClose?: (() => void) | undefined;
}

/** Plan/Ask chip: labeled when space allows; icon-only + tooltip when collapsed. */
export function ComposerSessionModeTag({ mode, onClose }: ComposerSessionModeTagProps) {
  const { t } = useTranslation();
  const iconOnly = useComposerIconOnlyToolbar();
  if (mode !== "plan" && mode !== "ask") {
    return null;
  }

  const label = sessionModeUi(mode).title;
  const tooltipLabel = mode === "plan" ? t("composer.plus.planMode") : t("composer.plus.askMode");
  const canClose = Boolean(onClose);
  const exitLabel = t("composer.plus.exitMode", { mode: label });

  if (!iconOnly) {
    return (
      <span
        className={["composer-session-mode-tag", "is-expanded", canClose ? "" : "is-readonly"]
          .filter(Boolean)
          .join(" ")}
        aria-label={label}
      >
        <SessionModeIcon mode={mode} className="composer-session-mode-tag-icon" />
        <span className="composer-session-mode-tag-label">{label}</span>
        {canClose ? (
          <button
            type="button"
            className="composer-session-mode-tag-close"
            aria-label={exitLabel}
            onClick={onClose}
          >
            <X size={14} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} aria-hidden />
          </button>
        ) : null}
      </span>
    );
  }

  const iconButton = canClose ? (
    <button
      type="button"
      className="composer-session-mode-tag is-dismissible"
      aria-label={exitLabel}
      onClick={onClose}
    >
      <SessionModeIcon mode={mode} className="composer-session-mode-tag-icon is-mode" />
      <X
        size={COMPOSER_TOOLBAR_ICON_PX}
        strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE}
        aria-hidden
        className="composer-session-mode-tag-icon is-close"
      />
    </button>
  ) : (
    <span className="composer-session-mode-tag is-readonly" aria-label={label}>
      <SessionModeIcon mode={mode} className="composer-session-mode-tag-icon" />
    </span>
  );

  return <ComposerHoverTooltip content={tooltipLabel}>{iconButton}</ComposerHoverTooltip>;
}
