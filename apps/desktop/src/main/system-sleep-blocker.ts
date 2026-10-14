/**
 * Keeps the OS from sleeping while Eco has running or scheduled work.
 * Uses `prevent-app-suspension` (system sleep), not display-sleep.
 *
 * Electron `powerSaveBlocker` is injected by the caller so unit tests need not load Electron.
 */
export interface PowerSaveBlockerApi {
  start(type: "prevent-app-suspension" | "prevent-display-sleep"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

export class SystemSleepBlocker {
  private blockerId: number | undefined;
  private disposed = false;

  constructor(private readonly api: PowerSaveBlockerApi) {}

  get isBlocking(): boolean {
    return this.blockerId !== undefined && this.api.isStarted(this.blockerId);
  }

  sync(shouldBlock: boolean, options: { refresh?: boolean } = {}): void {
    if (this.disposed) return;
    if (shouldBlock) {
      if (this.blockerId !== undefined && this.api.isStarted(this.blockerId)) {
        if (!options.refresh) return;
        // Electron coalesces blockers of the same type. Release first so resume
        // actually renews the native assertion instead of only replacing its JS id.
        this.api.stop(this.blockerId);
        this.blockerId = undefined;
      }
      this.blockerId = this.api.start("prevent-app-suspension");
      return;
    }
    if (this.blockerId === undefined) {
      return;
    }
    if (this.api.isStarted(this.blockerId)) {
      this.api.stop(this.blockerId);
    }
    this.blockerId = undefined;
  }

  dispose(): void {
    this.sync(false);
    this.disposed = true;
  }
}
