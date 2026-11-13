import { SlidersHorizontal } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ComposerAbovePanel } from "./ComposerAbovePanel";

/** Compact fullscreen controls; the existing pickers keep their own save logic. */
export function ComposerFloatingSettings({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = t("composer.floating.settings");
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="composer-floating-settings-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(current => !current)}
      >
        <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />
      </button>
      {open ? (
        <ComposerAbovePanel
          anchorRef={triggerRef}
          triggerRef={triggerRef}
          className="composer-floating-settings-menu"
          label={label}
          width={280}
          align="end"
          onClose={() => setOpen(false)}
        >
          {children}
        </ComposerAbovePanel>
      ) : null}
    </>
  );
}
