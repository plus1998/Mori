import type { BrowserWindow } from "electron";
import {
  type DesktopNotificationKind,
  type NotificationSettingsSnapshot,
  preferenceAllowsDesktopNotification,
} from "../shared/notification-settings";

type NotificationWindow = Pick<BrowserWindow, "isDestroyed" | "isVisible" | "isMinimized" | "isFocused">;

export function evaluateDesktopNotificationPolicy(
  kind: DesktopNotificationKind,
  threadSelected: boolean,
  supported: boolean,
  settings: NotificationSettingsSnapshot,
  window: NotificationWindow | undefined,
): { ok: true } | { ok: false; reason: "unsupported" | "preference_disabled" } {
  if (!supported) {
    return { ok: false, reason: "unsupported" };
  }
  // DOM focus can move to a webview or native control while the window stays
  // active. Only the native window can decide whether it has lost focus.
  const activelyViewed = Boolean(
    threadSelected &&
      window &&
      !window.isDestroyed() &&
      window.isVisible() &&
      !window.isMinimized() &&
      window.isFocused(),
  );
  if (!preferenceAllowsDesktopNotification(settings, kind, activelyViewed)) {
    return { ok: false, reason: "preference_disabled" };
  }
  return { ok: true };
}
