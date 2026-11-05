import type { ComponentPropsWithRef } from "react";
import "./switch.css";

type SwitchSize = "default" | "sm";
type SwitchTone = "accent" | "neutral";

interface SwitchAppearance {
  checked: boolean;
  size?: SwitchSize;
  tone?: SwitchTone;
}

/** Visual track for an existing switch row/button; it has no interaction of its own. */
export function SwitchIndicator({ checked, size = "default", tone = "accent" }: SwitchAppearance) {
  return (
    <span
      className="mori-switch-track"
      data-size={size}
      data-tone={tone}
      data-state={checked ? "checked" : "unchecked"}
      aria-hidden="true"
    >
      <span className="mori-switch-thumb" />
    </span>
  );
}

export type SwitchProps = Omit<
  ComponentPropsWithRef<"button">,
  "children" | "type" | "role" | "aria-checked" | "onChange" | "defaultChecked"
> &
  SwitchAppearance & {
    onCheckedChange: (checked: boolean) => void;
  };

/** Controlled switch. Supply aria-label or aria-labelledby for its accessible name. */
export function Switch({
  checked,
  onCheckedChange,
  size = "default",
  tone = "accent",
  disabled,
  className,
  onClick,
  ...props
}: SwitchProps) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={["mori-switch", className].filter(Boolean).join(" ")}
      onClick={(event) => {
        onClick?.(event);
        if (!disabled && !event.defaultPrevented) onCheckedChange(!checked);
      }}
    >
      <SwitchIndicator checked={checked} size={size} tone={tone} />
    </button>
  );
}
