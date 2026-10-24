import type {
  DisplayControlChange,
  DisplayControlMonitor,
  DisplayControlState,
} from "../shared/display-control";
import {
  createMacActivityAssertion,
  createMacBrightnessApi,
  displayLevelsAreMinimum,
  type MacBrightnessApi,
  type MacDisplayInfo,
  type MacDisplayLevels,
  minimumDisplayLevels,
} from "./mac-display-native";

interface ActivityAssertion {
  refresh(): void;
  release(): void;
}
interface DimmedDisplay {
  display: MacDisplayInfo;
  original: MacDisplayLevels;
  forceRestore?: boolean;
}
interface DisplayRecoveryShortcut {
  register(): void;
  unregister(): void;
}

export class DisplayControl {
  private activity: ActivityAssertion | undefined;
  private brightness: MacBrightnessApi | undefined;
  private readonly dimmedDisplays = new Map<string, DimmedDisplay>();
  private readonly seenDisplays = new Set<string>();
  private dimmingRequested = false;
  private shortcutRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private error: string | undefined;

  constructor(
    private readonly platform = process.platform,
    private readonly createActivity = createMacActivityAssertion,
    private readonly createBrightness: () => MacBrightnessApi = createMacBrightnessApi,
    private readonly recovery?: DisplayRecoveryShortcut,
  ) {}

  private getBrightness(): MacBrightnessApi {
    this.brightness ??= this.createBrightness();
    return this.brightness;
  }

  getState(): DisplayControlState {
    const displays: DisplayControlMonitor[] = [];
    let brightnessError: string | undefined;
    if (this.platform === "darwin") {
      try {
        const api = this.getBrightness();
        for (const display of api.displays()) {
          const record = this.dimmedDisplays.get(display.key);
          try {
            const levels = api.get(display.id, record?.original.method);
            displays.push({
              ...display,
              method: levels.method,
              status: record ? (this.dimmingRequested ? "dimmed" : "restorePending") : "ready",
            });
          } catch (error) {
            displays.push({
              ...display,
              status: record ? "restorePending" : "unsupported",
              error: String(error),
              ...(record ? { method: record.original.method } : {}),
            });
          }
        }
      } catch (error) {
        brightnessError = String(error);
      }
    }
    return {
      preventAutoLock: !!this.activity,
      dimmed: this.dimmingRequested,
      brightnessAvailable: displays.some((display) => display.method !== undefined),
      displays,
      pendingRestores: this.dimmingRequested ? 0 : this.dimmedDisplays.size,
      ...(brightnessError ? { brightnessError } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  set(input: DisplayControlChange): DisplayControlState {
    if (this.platform !== "darwin") throw new Error("Display controls require macOS.");
    if (
      !input ||
      typeof input.enabled !== "boolean" ||
      !["preventAutoLock", "dimmed"].includes(input.control)
    ) {
      throw new Error("Invalid display control change.");
    }
    this.error = undefined;
    try {
      if (input.control === "preventAutoLock") {
        if (input.enabled && !this.activity) {
          const activity = this.createActivity();
          try {
            activity.refresh();
            this.activity = activity;
          } catch (error) {
            activity.release();
            throw error;
          }
        } else if (!input.enabled) {
          this.activity?.release();
          this.activity = undefined;
        }
      } else if (input.enabled && !this.dimmingRequested) {
        this.startDimming();
      } else if (!input.enabled) {
        this.dimmingRequested = false;
        this.restoreBrightness();
      }
    } catch (error) {
      this.error = String(error);
      throw error;
    } finally {
      this.syncTimer();
    }
    return this.getState();
  }

  private startDimming(): void {
    this.restoreBrightness();
    if (this.dimmedDisplays.size) throw new Error("Reconnect displays to finish restoring brightness first.");
    const api = this.getBrightness();
    const displays = api.displays();
    const targets: DimmedDisplay[] = [];
    for (const display of displays) {
      try {
        targets.push({ display, original: api.get(display.id) });
      } catch {
        /* Unsupported monitors remain explicitly listed in getState(). */
      }
    }
    if (!targets.length) throw new Error("No display supports backlight control or software dimming.");
    // Register a recovery path before making the physical screens dark.
    this.recovery?.register();
    this.shortcutRegistered = true;
    this.seenDisplays.clear();
    for (const display of displays) this.seenDisplays.add(display.key);
    try {
      for (const target of targets) this.dimDisplay(target);
      this.dimmingRequested = true;
    } catch (error) {
      this.dimmingRequested = false;
      try {
        this.restoreBrightness();
      } catch (restoreError) {
        throw new Error(`${String(error)}; ${String(restoreError)}`);
      }
      throw error;
    }
  }

  private dimDisplay(target: DimmedDisplay): void {
    const api = this.getBrightness();
    // Track before writing: a partially successful native call must be restorable.
    target.forceRestore = true;
    this.dimmedDisplays.set(target.display.key, target);
    api.set(target.display.id, minimumDisplayLevels(target.original));
    if (!displayLevelsAreMinimum(api.get(target.display.id, target.original.method))) {
      throw new Error(`Display ${target.display.id}: dimming could not be verified.`);
    }
    target.forceRestore = false;
  }

  private syncTimer(): void {
    if (!this.activity && !this.dimmingRequested && !this.dimmedDisplays.size) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) {
      this.timer = setInterval(() => this.refresh(), 1000);
      this.timer.unref();
    }
    if (!this.dimmingRequested && !this.dimmedDisplays.size && this.shortcutRegistered) {
      this.recovery?.unregister();
      this.shortcutRegistered = false;
    }
  }

  refresh(): void {
    try {
      this.activity?.refresh();
    } catch (error) {
      this.error = String(error);
      this.activity?.release();
      this.activity = undefined;
    }
    if (this.dimmingRequested || this.dimmedDisplays.size) {
      try {
        const api = this.getBrightness();
        const displays = api.displays();
        if (this.dimmingRequested) {
          for (const display of displays) {
            const record = this.dimmedDisplays.get(display.key);
            if (record) {
              record.display = display;
              // Brightness keys (or another app changing a gamma table) recover
              // the whole group; never force a manually restored monitor dark.
              if (!displayLevelsAreMinimum(api.get(display.id, record.original.method))) {
                this.dimmedDisplays.delete(display.key);
                this.dimmingRequested = false;
                break;
              }
            } else if (!this.seenDisplays.has(display.key)) {
              this.seenDisplays.add(display.key);
              let original: MacDisplayLevels;
              try {
                original = api.get(display.id);
              } catch {
                continue;
              } // Explicitly reported as unsupported in getState().
              this.dimDisplay({ display, original });
            }
          }
        }
        if (!this.dimmingRequested) this.restoreBrightness(displays);
      } catch (error) {
        this.error = String(error);
      }
    }
    this.syncTimer();
  }

  private restoreBrightness(displays?: MacDisplayInfo[]): void {
    if (!this.dimmedDisplays.size) return;
    const api = this.getBrightness();
    const connected = new Map((displays ?? api.displays()).map((display) => [display.key, display]));
    const errors: string[] = [];
    for (const [key, record] of this.dimmedDisplays) {
      const display = connected.get(key);
      // Keep originals for reconnection. Numeric CG ids may be reused by other screens.
      if (!display) continue;
      try {
        if (record.forceRestore || displayLevelsAreMinimum(api.get(display.id, record.original.method)))
          api.set(display.id, record.original);
        this.dimmedDisplays.delete(key);
      } catch (error) {
        errors.push(`Display ${display.id}: ${String(error)}`);
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.activity?.release();
    this.activity = undefined;
    this.dimmingRequested = false;
    try {
      this.restoreBrightness();
    } finally {
      if (this.shortcutRegistered) this.recovery?.unregister();
      this.shortcutRegistered = false;
    }
  }
}
