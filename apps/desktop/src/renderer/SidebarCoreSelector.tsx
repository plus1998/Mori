import type { CoreKind } from "@eco/runtime/core-runtime";
import { Check, ChevronDown, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { composerFloatingViewport } from "./composer-floating";
import { i18n } from "./i18n";
import { SidebarAttentionButton } from "./SidebarAttentionButton";
import type { SidebarAttentionItem } from "./sidebar-attention-items";

interface SidebarCoreSelectorProps {
  coreKind: CoreKind | undefined;
  locked: boolean;
  busy: boolean;
  codexAvailable: boolean;
  codexUnavailableReason?: string;
  codexVersion?: string;
  piAvailable?: boolean;
  piUnavailableReason?: string;
  piVersion?: string;
  cursorAvailable?: boolean;
  cursorUnavailableReason?: string;
  cursorVersion?: string;
  claudeVersion?: string;
  cursorProbeLoading?: boolean;
  /** @deprecated ACP region is always shown; kept so callers compiling against older props still typecheck. */
  acpCursorEnabled?: boolean;
  /** @deprecated Selecting Cursor starts the check; kept for older callers. */
  onAcpCursorEnabledChange?: (enabled: boolean) => void;
  /** @deprecated Selecting Cursor starts the check; kept for older callers. */
  onReprobeCursor?: () => void;
  /** @deprecated ACP region is always shown; kept so callers compiling against older props still typecheck. */
  acpCoreVisible?: boolean;
  attentionItems: readonly SidebarAttentionItem[];
  onChange: (coreKind: CoreKind) => void;
  onOpenSearch: () => void;
  onSelectAttentionThread: (threadId: string) => void;
  /** Test-only: start with the menu open. */
  initialMenuOpen?: boolean;
}

const coreOptions: Array<{ kind: CoreKind; label: string; iconSrc: string }> = [
  { kind: "codex", label: "Codex", iconSrc: "./agent-icons/codex.ico" },
  { kind: "claude", label: "Claude Code", iconSrc: "./agent-icons/claude-code.ico" },
  { kind: "pi", label: "π", iconSrc: "./agent-icons/pi.svg" },
  { kind: "acp", label: "Cursor", iconSrc: "./agent-icons/cursor.ico" },
];

/** Built-in Eco cores only. ACP/Cursor lives in its own menu region. */
export function runtimeCoreOptions(): typeof coreOptions {
  return coreOptions.filter((option) => option.kind !== "acp");
}

const CORE_MENU_TOOLTIP_MAX_HALF_WIDTH = 130;

function CoreMenuButton({
  children,
  version,
  hint,
  ...props
}: {
  children: React.ReactNode;
  version?: string;
  /** Unavailable / probing copy; takes precedence over version. */
  hint?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const tooltip = hint?.trim() || (version ? `v${version}` : undefined);

  const show = useCallback(() => {
    if (!tooltip) return;
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const viewport = composerFloatingViewport();
    const center = rect.left + rect.width / 2;
    const clampedCenter = Math.max(
      viewport.left + CORE_MENU_TOOLTIP_MAX_HALF_WIDTH,
      Math.min(center, viewport.right - CORE_MENU_TOOLTIP_MAX_HALF_WIDTH),
    );
    setPos({ top: rect.top - 8, left: clampedCenter });
    setHovered(true);
  }, [tooltip]);

  return (
    <>
      <button
        ref={buttonRef}
        // The reason a core is unavailable is drawn by the tooltip below, which only exists
        // while the row is hovered or focused. `title` carries the same words for the readers
        // that never see that tooltip: assistive technology announces it on focus, and it is
        // the only place the reason is visible without a pointer.
        {...(tooltip ? { title: tooltip } : {})}
        {...props}
        onMouseEnter={show}
        onMouseLeave={() => setHovered(false)}
        onFocus={show}
        onBlur={() => setHovered(false)}
      >
        {children}
      </button>
      {hovered && tooltip
        ? createPortal(
            <span
              className="sidebar-core-menu-tooltip"
              role="tooltip"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                transform: "translate(-50%, -100%)",
              }}
            >
              {tooltip}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

/** @deprecated Use `runtimeCoreOptions`. ACP is never mixed into the runtime list. */
export function visibleCoreOptions(_acpCoreVisible?: boolean): typeof coreOptions {
  return runtimeCoreOptions();
}

export function coreDisplayName(coreKind: CoreKind | undefined): string {
  if (coreKind === "codex") return "Codex";
  if (coreKind === "claude") return "Claude Code";
  if (coreKind === "pi") return "π";
  if (coreKind === "acp") return "Cursor";
  return i18n.t("sidebar.unknownCore");
}

/** Brand icon for a core, for surfaces that show the logo instead of the core name. */
export function coreIconSrc(coreKind: CoreKind | undefined): string {
  return coreOptions.find((option) => option.kind === coreKind)?.iconSrc ?? "./agent-icons/other.svg";
}

function AcpCoreTag() {
  return (
    <span className="sidebar-core-acp-tag" aria-hidden="true">
      {i18n.t("sidebar.acpLabel")}
    </span>
  );
}

function CoreHeadingLabel({ coreKind }: { coreKind: CoreKind | undefined }) {
  return (
    <span className="sidebar-core-heading-label">
      <span>{coreDisplayName(coreKind)}</span>
      {coreKind === "acp" ? <AcpCoreTag /> : null}
    </span>
  );
}

export function SidebarCoreSelector({
  coreKind,
  locked,
  busy,
  codexAvailable,
  codexUnavailableReason,
  codexVersion,
  piAvailable = true,
  piUnavailableReason,
  piVersion,
  cursorAvailable = false,
  cursorUnavailableReason,
  cursorVersion,
  claudeVersion,
  cursorProbeLoading = false,
  attentionItems,
  onChange,
  onOpenSearch,
  onSelectAttentionThread,
  initialMenuOpen = false,
}: SidebarCoreSelectorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialMenuOpen);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const editable = !locked && !busy;
  const runtimeOptions = runtimeCoreOptions();

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!editable) setOpen(false);
  }, [editable]);

  return (
    <div ref={rootRef} className="sidebar-core-selector">
      {editable ? (
        <button
          type="button"
          className="sidebar-core-heading is-editable"
          aria-label={t("sidebar.currentCore", {
            core: coreKind === "acp" ? `Cursor ${t("sidebar.acpLabel")}` : coreDisplayName(coreKind),
          })}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => {
            setAttentionOpen(false);
            setOpen((current) => !current);
          }}
        >
          <CoreHeadingLabel coreKind={coreKind} />
          <ChevronDown size={15} aria-hidden />
        </button>
      ) : (
        <div className="sidebar-core-heading">
          <CoreHeadingLabel coreKind={coreKind} />
        </div>
      )}

      <div className="sidebar-core-actions">
        <button
          type="button"
          className="sidebar-core-search"
          aria-label={t("nav.search")}
          title={t("nav.search")}
          onClick={() => {
            setOpen(false);
            setAttentionOpen(false);
            onOpenSearch();
          }}
        >
          <Search size={17} aria-hidden />
        </button>
        <SidebarAttentionButton
          items={attentionItems}
          open={attentionOpen}
          onOpenChange={(next) => {
            if (next) setOpen(false);
            setAttentionOpen(next);
          }}
          onSelectThread={onSelectAttentionThread}
        />
      </div>

      {open ? (
        <div className="sidebar-core-menu" role="menu" aria-label={t("sidebar.selectCore")}>
          <section className="sidebar-core-menu-region" aria-labelledby="sidebar-core-runtime-label">
            <h2 id="sidebar-core-runtime-label" className="sidebar-core-menu-region-label">
              {t("sidebar.runtimeCoresSection")}
            </h2>
            {runtimeOptions.map((option) => {
              const selected = option.kind === coreKind;
              const unavailable =
                (option.kind === "codex" && !codexAvailable) || (option.kind === "pi" && !piAvailable);
              const unavailableReason =
                option.kind === "codex"
                  ? codexUnavailableReason
                  : option.kind === "pi"
                    ? piUnavailableReason
                    : undefined;
              const version =
                option.kind === "codex"
                  ? codexVersion
                  : option.kind === "claude"
                    ? claudeVersion
                    : option.kind === "pi"
                      ? piVersion
                      : undefined;
              return (
                <CoreMenuButton
                  key={option.kind}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={selected ? "is-selected" : ""}
                  disabled={unavailable}
                  {...(version ? { version } : {})}
                  {...(unavailable && unavailableReason ? { hint: unavailableReason } : {})}
                  onClick={() => {
                    onChange(option.kind);
                    setOpen(false);
                  }}
                >
                  <span className="sidebar-core-menu-label">
                    <img className="sidebar-core-icon" src={option.iconSrc} alt="" aria-hidden="true" />
                    <span className="sidebar-core-menu-name">{option.label}</span>
                  </span>
                  {selected ? <Check size={15} aria-hidden /> : null}
                </CoreMenuButton>
              );
            })}
          </section>

          <section className="sidebar-core-menu-region" aria-labelledby="sidebar-core-acp-label">
            <h2 id="sidebar-core-acp-label" className="sidebar-core-menu-region-label">
              {t("sidebar.acpSection")}
            </h2>
            <CoreMenuButton
              type="button"
              role="menuitemradio"
              aria-checked={coreKind === "acp"}
              className={coreKind === "acp" ? "is-selected" : ""}
              {...(cursorVersion ? { version: cursorVersion } : {})}
              {...(cursorProbeLoading
                ? { hint: t("settings.defaultAgent.cursorProbing") }
                : !cursorAvailable && cursorUnavailableReason
                  ? { hint: cursorUnavailableReason }
                  : {})}
              onClick={() => {
                onChange("acp");
                setOpen(false);
              }}
            >
              <span className="sidebar-core-menu-label">
                <img className="sidebar-core-icon" src="./agent-icons/cursor.ico" alt="" aria-hidden="true" />
                <span className="sidebar-core-menu-name">
                  <span>Cursor</span>
                  <AcpCoreTag />
                </span>
              </span>
              {coreKind === "acp" ? <Check size={15} aria-hidden /> : null}
            </CoreMenuButton>
          </section>
        </div>
      ) : null}
    </div>
  );
}
