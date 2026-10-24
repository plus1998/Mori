import { Check, ChevronRight, Clock3, Image, LayoutTemplate, Plus, X } from "lucide-react";
import { type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { type SessionMode, togglePlusMenuSessionMode } from "../shared/session-mode";
import { sessionModeUi } from "../shared/session-mode-ui";
import { ComposerHoverTooltip, useComposerIconOnlyToolbar } from "./ComposerHoverTooltip";
import { SessionModeIcon } from "./ComposerPlanModeToggle";
import { ComposerAbovePanel } from "./ComposerAbovePanel";
import { COMPOSER_TOOLBAR_ICON_PX, COMPOSER_TOOLBAR_ICON_STROKE } from "./composer-icon-metrics";

interface MenuActions {
  sessionMode: SessionMode;
  canEditMode: boolean;
  canOpenRoute: boolean;
  showRoute?: boolean | undefined;
  saving?: boolean | undefined;
  onSelectMode: (sessionMode: SessionMode) => void;
  onPickImage: () => void;
  onOpenRoute: () => void;
  onAddScheduledMessage?: (() => void) | undefined;
  newConversation?: boolean | undefined;
}

export function ComposerPlusMenu({
  buttonRef,
  anchorRef,
  open,
  panelActive,
  onOpenChange,
  ...actions
}: MenuActions & {
  buttonRef: RefObject<HTMLButtonElement | null>;
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  panelActive: boolean;
  onOpenChange(open: boolean): void;
}) {
  const { t } = useTranslation();
  const close = () => onOpenChange(false);
  const select = (action: () => void) => {
    close();
    action();
  };
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`composer-plus-trigger${panelActive ? " is-active" : ""}`}
        title={t("composer.plus.menu")}
        aria-label={t("composer.plus.menu")}
        aria-expanded={panelActive}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!panelActive)}
      >
        <Plus size={COMPOSER_TOOLBAR_ICON_PX} strokeWidth={COMPOSER_TOOLBAR_ICON_STROKE} aria-hidden />
      </button>
      {open ? (
        <ComposerAbovePanel
          anchorRef={anchorRef}
          triggerRef={buttonRef}
          className="composer-plus-menu"
          role="menu"
          label={t("composer.plus.menu")}
          onClose={close}
        >
          <ComposerPlusMenuPanel
            {...actions}
            onSelectMode={(mode) =>
              select(() =>
                actions.onSelectMode(
                  mode === "plan" || mode === "ask"
                    ? togglePlusMenuSessionMode(actions.sessionMode, mode)
                    : mode,
                ),
              )
            }
            onPickImage={() => select(actions.onPickImage)}
            onOpenRoute={() => select(actions.onOpenRoute)}
            onAddScheduledMessage={
              actions.onAddScheduledMessage ? () => select(actions.onAddScheduledMessage!) : undefined
            }
          />
        </ComposerAbovePanel>
      ) : null}
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
  newConversation,
}: MenuActions) {
  const { t } = useTranslation();
  return (
    <ul
      className="composer-plus-menu-list"
      onKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      <li className="composer-plus-menu-section" role="presentation">
        {t("composer.plus.modeSection")}
      </li>
      <PlusMenuRow
        icon={<SessionModeIcon mode="plan" />}
        label={sessionModeUi("plan").title}
        description={t("composer.plus.planHint")}
        selected={sessionMode === "plan"}
        toggle
        disabled={!canEditMode || Boolean(saving)}
        onSelect={() => onSelectMode("plan")}
      />
      <PlusMenuRow
        icon={<SessionModeIcon mode="ask" />}
        label={sessionModeUi("ask").title}
        description={t("composer.plus.askHint")}
        selected={sessionMode === "ask"}
        toggle
        disabled={!canEditMode || Boolean(saving)}
        onSelect={() => onSelectMode("ask")}
      />
      <li className="composer-plus-menu-section" role="presentation">
        {t("composer.plus.actionSection")}
      </li>
      <PlusMenuRow
        icon={<Image size={18} aria-hidden />}
        label={t("composer.plus.image")}
        description={t("composer.plus.imageHint")}
        onSelect={onPickImage}
      />
      {onAddScheduledMessage ? (
        <PlusMenuRow
          icon={<Clock3 size={18} aria-hidden />}
          label={t("scheduling.messageAction")}
          description={t(newConversation ? "composer.plus.firstMessageHint" : "composer.plus.scheduleHint")}
          next
          onSelect={onAddScheduledMessage}
        />
      ) : null}
      {showRoute ? (
        <>
          <li className="composer-plus-menu-section" role="presentation">
            {t("composer.plus.route")}
          </li>
          <PlusMenuRow
            icon={<LayoutTemplate size={18} aria-hidden />}
            label={t("composer.route.profiles")}
            description={t("composer.plus.routeHint")}
            next
            disabled={!canOpenRoute}
            onSelect={onOpenRoute}
          />
        </>
      ) : null}
    </ul>
  );
}

function PlusMenuRow({
  icon,
  label,
  description,
  selected = false,
  disabled = false,
  next,
  toggle,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  description: string;
  selected?: boolean;
  disabled?: boolean;
  next?: boolean;
  toggle?: boolean;
  onSelect(): void;
}) {
  const { t } = useTranslation();
  return (
    <li role="none">
      <button
        type="button"
        role={toggle ? "menuitemcheckbox" : "menuitem"}
        className={`composer-plus-menu-item${selected ? " is-selected" : ""}`}
        disabled={disabled}
        aria-checked={toggle ? selected : undefined}
        onClick={onSelect}
      >
        <span className="composer-plus-menu-item-icon" aria-hidden>
          {icon}
        </span>
        <span className="composer-plus-menu-item-label">{label}</span>
        <span className="composer-plus-menu-item-description">{description}</span>
        {selected ? (
          <span className="composer-plus-menu-item-check">
            <Check size={14} aria-hidden />
            {t("composer.plus.enabled")}
          </span>
        ) : next ? (
          <ChevronRight size={15} className="composer-plus-menu-item-chevron" aria-hidden />
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
