export const DISPLAY_RESTORE_ACCELERATOR = "CommandOrControl+Shift+L";

export type DisplayDimmingMethod = "backlight" | "software";

export interface DisplayControlMonitor {
  id: number;
  key: string;
  name: string;
  internal: boolean;
  method?: DisplayDimmingMethod;
  status: "ready" | "dimmed" | "unsupported" | "restorePending";
  error?: string;
}

export interface DisplayControlState {
  preventAutoLock: boolean;
  dimmed: boolean;
  brightnessAvailable: boolean;
  displays: DisplayControlMonitor[];
  pendingRestores: number;
  brightnessError?: string;
  error?: string;
}

export interface DisplayControlChange {
  control: "preventAutoLock" | "dimmed";
  enabled: boolean;
}
