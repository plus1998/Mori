import type {
  DisplayControlChange,
  DisplayControlMonitor,
  DisplayControlState,
} from "../shared/display-control";
import { createMacActivityAssertion, createMacBrightnessApi } from "./mac-display-native";
import { createWindowsActivityAssertion, createWindowsBrightnessApi } from "./windows-display-native";
import {
  displayLevelsAreMinimum,
  minimumDisplayLevels,
  type ActivityAssertion,
  type BrightnessApi,
  type DisplayInfo,
  type DisplayLevels,
} from "./display-native";

interface DimmedDisplay {
  display: DisplayInfo;
  original: DisplayLevels;
  forceRestore?: boolean;
}
interface DisplayRecoveryShortcut {
  register(): void;
  unregister(): void;
}

export class DisplayControl {
  private activity: ActivityAssertion | undefined;
  private brightness: BrightnessApi | undefined;
  private readonly dimmedDisplays = new Map<string, DimmedDisplay>();
  private readonly seenDisplays = new Set<string>();
  private dimmingRequested = false;
  private shortcutRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private error: string | undefined;

  constructor(
    private readonly platform = process.platform,
    private readonly createActivity = platform === "win32"
      ? createWindowsActivityAssertion
      : createMacActivityAssertion,
    private readonly createBrightness: () => BrightnessApi = platform === "win32"
      ? createWindowsBrightnessApi
      : createMacBrightnessApi,
    private readonly recovery?: DisplayRecoveryShortcut,
  ) {}

  private getBrightness(): BrightnessApi {
    this.brightness ??= this.createBrightness();
    return this.brightness;
  }

  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private disposal: Promise<void> | undefined;

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Display controls are closing."));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  getState(): Promise<DisplayControlState> {
    return this.enqueue(() => this.readState());
  }

  private async readState(): Promise<DisplayControlState> {
    const displays: DisplayControlMonitor[] = [];
    let brightnessError: string | undefined;
    if (this.platform === "darwin" || this.platform === "win32") {
      try {
        const api = this.getBrightness();
        for (const display of await api.displays()) {
          const record = this.dimmedDisplays.get(display.key);
          try {
            const levels = await api.get(display.id, record?.original.method);
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

  set(input: DisplayControlChange): Promise<DisplayControlState> {
    return this.enqueue(() => this.apply(input));
  }

  private async apply(input: DisplayControlChange): Promise<DisplayControlState> {
    if (this.platform !== "darwin" && this.platform !== "win32")
      throw new Error("Display controls require macOS or Windows.");
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
        await this.startDimming();
      } else if (!input.enabled) {
        this.dimmingRequested = false;
        await this.restoreBrightness();
      }
    } catch (error) {
      this.error = String(error);
      throw error;
    } finally {
      this.syncTimer();
    }
    return this.readState();
  }

  toggle(control: DisplayControlChange["control"]): Promise<DisplayControlState> {
    return this.enqueue(() =>
      this.apply({
        control,
        enabled: control === "preventAutoLock" ? !this.activity : !this.dimmingRequested,
      }),
    );
  }

  private async startDimming(): Promise<void> {
    await this.restoreBrightness();
    if (this.dimmedDisplays.size) throw new Error("Reconnect displays to finish restoring brightness first.");
    const api = this.getBrightness();
    const displays = await api.displays();
    const targets: DimmedDisplay[] = [];
    for (const display of displays) {
      try {
        targets.push({ display, original: await api.get(display.id) });
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
      for (const target of targets) await this.dimDisplay(target);
      this.dimmingRequested = true;
    } catch (error) {
      this.dimmingRequested = false;
      try {
        await this.restoreBrightness();
      } catch (restoreError) {
        throw new Error(`${String(error)}; ${String(restoreError)}`);
      }
      throw error;
    }
  }

  private async dimDisplay(target: DimmedDisplay): Promise<void> {
    const api = this.getBrightness();
    // Track before writing: a partially successful native call must be restorable.
    target.forceRestore = true;
    this.dimmedDisplays.set(target.display.key, target);
    await api.set(target.display.id, minimumDisplayLevels(target.original));
    if (!displayLevelsAreMinimum(await api.get(target.display.id, target.original.method))) {
      throw new Error(`Display ${target.display.id}: dimming could not be verified.`);
    }
    target.forceRestore = false;
  }

  private syncTimer(): void {
    if (!this.activity && !this.dimmingRequested && !this.dimmedDisplays.size) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer && !this.closing) {
      let refreshing = false;
      this.timer = setInterval(() => {
        // WMI/DDC may be slow. Keep idle activity independent of that queue.
        this.refreshActivity();
        if (refreshing) return;
        refreshing = true;
        void this.refresh()
          .catch((error) => {
            this.error = String(error);
          })
          .finally(() => {
            refreshing = false;
          });
      }, 1000);
      this.timer.unref();
    }
    if (!this.dimmingRequested && !this.dimmedDisplays.size && this.shortcutRegistered) {
      this.recovery?.unregister();
      this.shortcutRegistered = false;
    }
  }

  refresh(): Promise<void> {
    return this.enqueue(() => this.refreshInternal());
  }

  private refreshActivity(): void {
    try {
      this.activity?.refresh();
    } catch (error) {
      this.error = String(error);
      this.activity?.release();
      this.activity = undefined;
    }
  }

  private async refreshInternal(): Promise<void> {
    this.refreshActivity();
    if (this.dimmingRequested || this.dimmedDisplays.size) {
      try {
        const api = this.getBrightness();
        const displays = await api.displays();
        if (this.dimmingRequested) {
          for (const display of displays) {
            const record = this.dimmedDisplays.get(display.key);
            if (record) {
              record.display = display;
              // Brightness keys (or another app changing a gamma table) recover
              // the whole group; never force a manually restored monitor dark.
              if (!displayLevelsAreMinimum(await api.get(display.id, record.original.method))) {
                this.dimmedDisplays.delete(display.key);
                this.dimmingRequested = false;
                break;
              }
            } else if (!this.seenDisplays.has(display.key)) {
              this.seenDisplays.add(display.key);
              let original: DisplayLevels;
              try {
                original = await api.get(display.id);
              } catch {
                continue;
              } // Explicitly reported as unsupported in getState().
              await this.dimDisplay({ display, original });
            }
          }
        }
        if (!this.dimmingRequested) await this.restoreBrightness(displays);
      } catch (error) {
        this.error = String(error);
      }
    }
    this.syncTimer();
  }

  private async restoreBrightness(displays?: DisplayInfo[]): Promise<void> {
    if (!this.dimmedDisplays.size) return;
    const api = this.getBrightness();
    const connected = new Map((displays ?? (await api.displays())).map((display) => [display.key, display]));
    const errors: string[] = [];
    for (const [key, record] of this.dimmedDisplays) {
      const display = connected.get(key);
      // Keep originals for reconnection; numeric ids may be reused by other screens.
      if (!display) continue;
      try {
        if (record.forceRestore || displayLevelsAreMinimum(await api.get(display.id, record.original.method)))
          await api.set(display.id, record.original);
        this.dimmedDisplays.delete(key);
      } catch (error) {
        errors.push(`Display ${display.id}: ${String(error)}`);
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.disposal = this.queue.then(async () => {
      this.activity?.release();
      this.activity = undefined;
      this.dimmingRequested = false;
      try {
        await this.restoreBrightness();
      } catch (error) {
        // Quit may be cancelled after a restore failure. Keep originals and the
        // recovery shortcut alive so the running app can retry.
        this.closing = false;
        this.disposal = undefined;
        this.error = String(error);
        this.syncTimer();
        throw error;
      }
      if (this.shortcutRegistered) this.recovery?.unregister();
      this.shortcutRegistered = false;
      this.brightness?.dispose?.();
    });
    return this.disposal;
  }
}
