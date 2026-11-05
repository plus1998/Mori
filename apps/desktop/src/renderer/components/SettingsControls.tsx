import type { ComponentPropsWithRef } from "react";
import "./settings-controls.css";

type SettingsButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "dialog";
};

export function SettingsButton({
  variant = "secondary",
  size = "sm",
  className,
  type = "button",
  ...props
}: SettingsButtonProps) {
  return (
    <button
      {...props}
      type={type}
      data-variant={variant}
      data-size={size}
      className={["settings-ui-button", className].filter(Boolean).join(" ")}
    />
  );
}

export function SettingsInput({ className, ...props }: ComponentPropsWithRef<"input">) {
  return <input {...props} className={["settings-ui-input", className].filter(Boolean).join(" ")} />;
}

export function SettingsTextarea({ className, ...props }: ComponentPropsWithRef<"textarea">) {
  return (
    <textarea
      {...props}
      className={["settings-ui-input", "settings-ui-textarea", className].filter(Boolean).join(" ")}
    />
  );
}

export function SettingsSelect({
  variant = "field",
  className,
  ...props
}: ComponentPropsWithRef<"select"> & { variant?: "field" | "inline" }) {
  return (
    <select
      {...props}
      data-variant={variant}
      className={["settings-ui-input", "settings-ui-select", className].filter(Boolean).join(" ")}
    />
  );
}
