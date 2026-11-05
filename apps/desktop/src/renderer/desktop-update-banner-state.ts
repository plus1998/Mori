import type { DesktopUpdateState } from "../shared/desktop-update";

export type SidebarUpdateActionKind =
  | "version"
  | "checking"
  | "download"
  | "progress"
  | "preparing"
  | "restart"
  | "installing"
  | "error"
  | "manual";

export interface SidebarUpdateAction {
  kind: SidebarUpdateActionKind;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  error?: string;
  manualReason?: DesktopUpdateState["reason"];
}

export function resolveSidebarUpdateAction(state: DesktopUpdateState | undefined): SidebarUpdateAction {
  const currentVersion = state?.currentVersion?.trim() ?? "";
  if (!state) {
    return { kind: "version", currentVersion };
  }

  if (state.phase === "disabled" && state.capability === "disabled") {
    return { kind: "version", currentVersion };
  }

  if (state.phase === "disabled") {
    return {
      kind: "manual",
      currentVersion,
      ...(state.reason ? { manualReason: state.reason } : {}),
    };
  }

  switch (state.phase) {
    case "checking":
      return { kind: "checking", currentVersion };
    case "available":
      return {
        kind: state.capability === "auto" ? "download" : "manual",
        currentVersion,
        ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
        ...(state.capability !== "auto" && state.reason ? { manualReason: state.reason } : {}),
      };
    case "downloading":
      return {
        kind: "progress",
        currentVersion,
        ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
        percent: Math.max(0, Math.min(100, Math.round(state.progress?.percent ?? 0))),
      };
    case "downloaded":
      return {
        kind: "restart",
        currentVersion,
        ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
      };
    case "preparing":
      return { kind: "preparing", currentVersion };
    case "installing":
      return {
        kind: "installing",
        currentVersion,
        ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
      };
    case "error":
      return {
        kind: "error",
        currentVersion,
        ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
        ...(state.error ? { error: state.error } : {}),
      };
    case "idle":
    default:
      return { kind: "version", currentVersion };
  }
}

/** @deprecated Prefer resolveSidebarUpdateAction; kept for call sites that only need download CTA. */
export function shouldShowSidebarUpdateDownload(state: DesktopUpdateState | undefined): boolean {
  return resolveSidebarUpdateAction(state).kind === "download";
}

export function sidebarSettingsVersionLabel(state: DesktopUpdateState | undefined): string {
  return state?.currentVersion?.trim() ?? "";
}
