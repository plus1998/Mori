import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopUpdateState } from "../src/shared/desktop-update";

let feedVersion: string | undefined;
let checkedVersion: string | undefined;
let checkError: Error | undefined;
let downloadError: Error | undefined;
const operations: string[] = [];
const updater = Object.assign(new EventEmitter(), {
  setFeedURL: mock(() => {}),
  checkForUpdates: mock(async () => {
    operations.push("check");
    updater.emit("checking-for-update");
    if (checkError) throw checkError;
    if (!feedVersion) {
      updater.emit("update-not-available", { version: "1.0.0" });
      return { isUpdateAvailable: false };
    }
    checkedVersion = feedVersion;
    updater.emit("update-available", { version: checkedVersion });
    return { isUpdateAvailable: true };
  }),
  quitAndInstall: mock(() => {}),
  downloadUpdate: mock(async () => {
    operations.push(`download:${checkedVersion}`);
    if (downloadError) throw downloadError;
    updater.emit("update-downloaded", { version: checkedVersion });
    nativeAutoUpdater.emit("update-downloaded");
    return [];
  }),
});
const setProxy = mock(async () => {});
const powerMonitor = new EventEmitter();
const nativeAutoUpdater = new EventEmitter();

mock.module("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0" },
  net: { isOnline: () => true },
  powerMonitor,
  autoUpdater: nativeAutoUpdater,
  session: { fromPartition: () => ({ setProxy }) },
  shell: { openExternal: async () => {} },
}));
mock.module("electron-updater", () => ({ default: { autoUpdater: updater } }));

const { DesktopUpdateService } = await import("../src/main/desktop-update-service");
let service: InstanceType<typeof DesktopUpdateService>;
let manifestDirectory: string;
let states: DesktopUpdateState[];
const originalAppImage = process.env.APPIMAGE;

beforeEach(async () => {
  feedVersion = "1.1.0";
  checkedVersion = undefined;
  checkError = undefined;
  downloadError = undefined;
  operations.length = 0;
  updater.removeAllListeners();
  updater.checkForUpdates.mockClear();
  updater.downloadUpdate.mockClear();
  setProxy.mockReset();
  setProxy.mockImplementation(async () => {});
  if (process.platform === "linux") process.env.APPIMAGE = "/tmp/Eco.AppImage";
  manifestDirectory = mkdtempSync(join(tmpdir(), "eco-update-test-"));
  const manifestPath = join(manifestDirectory, "release.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "1.0.0",
      channel: "latest",
      // A fixed self-signed release has no commercial signature but supports updates.
      unsigned: true,
      releaseUrl: "https://example.com/releases",
      updateFeedUrl: "https://example.com/feed",
      updateModes: { darwin: "auto", win32: "auto", linux: "auto" },
    }),
  );
  states = [];
  service = new DesktopUpdateService({ manifestPath, onStateChange: (state) => states.push(state) });
  service.start();
  await service.checkForUpdates();
  expect(service.getState().phase).toBe("available");
  operations.length = 0;
  states.length = 0;
  updater.checkForUpdates.mockClear();
});

afterEach(() => {
  service.dispose();
  updater.removeAllListeners();
  rmSync(manifestDirectory, { recursive: true, force: true });
  if (originalAppImage === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = originalAppImage;
});

test("download refreshes the feed and downloads the newly published version", async () => {
  feedVersion = "1.2.0";

  const state = await service.downloadUpdate();

  expect(operations).toEqual(["check", "download:1.2.0"]);
  expect(state).toMatchObject({ phase: "downloaded", availableVersion: "1.2.0" });
  expect(states.map((state) => state.phase)).toContain("checking");
});

test("download proceeds when the available version is unchanged", async () => {
  const state = await service.downloadUpdate();

  expect(operations).toEqual(["check", "download:1.1.0"]);
  expect(state.phase).toBe("downloaded");
});

test("failed refresh reports the error without downloading the stale version", async () => {
  checkError = new Error("net::ERR_CONNECTION_RESET");

  const state = await service.downloadUpdate();

  expect(state).toMatchObject({ phase: "error", error: "NETWORK_ERROR" });
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
});

test("withdrawn update clears the old version and skips download", async () => {
  feedVersion = undefined;

  const state = await service.downloadUpdate();

  expect(state).toMatchObject({ phase: "idle", reason: "up-to-date" });
  expect(state.availableVersion).toBeUndefined();
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
});

test("repeated download clicks during proxy setup only check and download once", async () => {
  let releaseProxy!: () => void;
  setProxy.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releaseProxy = resolve;
      }),
  );
  feedVersion = "1.2.0";

  const firstDownload = service.downloadUpdate();
  const secondDownload = service.downloadUpdate();
  expect(service.getState().phase).toBe("checking");
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  releaseProxy();
  await Promise.all([firstDownload, secondDownload]);

  expect(operations).toEqual(["check", "download:1.2.0"]);
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
});

test("download errors after refresh remain visible", async () => {
  feedVersion = "1.2.0";
  downloadError = new Error("Download checksum mismatch");

  const state = await service.downloadUpdate();

  expect(operations).toEqual(["check", "download:1.2.0"]);
  expect(state).toMatchObject({ phase: "error", error: "Download checksum mismatch" });
});

test("download cannot restart an update that is ready to install", async () => {
  await service.downloadUpdate();
  operations.length = 0;

  const state = await service.downloadUpdate();

  expect(state.phase).toBe("downloaded");
  expect(operations).toEqual([]);
});

test("self-signed releases automatically check on resume without downloading", async () => {
  updater.emit("update-not-available");
  feedVersion = "1.2.0";

  powerMonitor.emit("resume");
  await service.checkForUpdates(false);

  expect(service.getState()).toMatchObject({
    phase: "available",
    capability: "auto",
    availableVersion: "1.2.0",
  });
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
});

test.skipIf(process.platform !== "darwin")("macOS waits for native unpacking and validation before offering restart", async () => {
  updater.emit("download-progress", { percent: 100, transferred: 100, total: 100, bytesPerSecond: 10 });
  updater.emit("update-downloaded", { version: "1.1.0" });
  expect(service.getState().phase).toBe("preparing");
  await service.checkForUpdates();
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  nativeAutoUpdater.emit("update-downloaded");
  expect(service.getState().phase).toBe("downloaded");
});

test("manual checks cannot overwrite an active download", async () => {
  updater.emit("download-progress", { percent: 40, transferred: 40, total: 100, bytesPerSecond: 10 });
  const state = await service.checkForUpdates();
  expect(state.phase).toBe("downloading");
  expect(state.progressUpdatedAt).toBeGreaterThan(0);
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
});

test("installation waits for the independent window to open before quitting", async () => {
  service.dispose();
  updater.removeAllListeners();
  let ready!: () => void;
  const monitor = { start: mock(() => new Promise<void>(resolve => { ready = resolve; })), failed: mock(() => {}) };
  service = new DesktopUpdateService({ manifestPath: join(manifestDirectory, "release.json"), onStateChange: () => {}, installMonitor: monitor });
  service.start();
  await service.checkForUpdates();
  await service.downloadUpdate();
  updater.quitAndInstall.mockClear();
  const installing = service.installUpdate();
  expect(service.getState().phase).toBe("installing");
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  ready();
  await installing;
  expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
});

test("a failed progress window leaves the downloaded update available for retry", async () => {
  service.dispose();
  updater.removeAllListeners();
  const monitor = { start: mock(async () => { throw new Error("Progress window launch failed"); }), failed: mock(() => {}) };
  service = new DesktopUpdateService({ manifestPath: join(manifestDirectory, "release.json"), onStateChange: () => {}, installMonitor: monitor });
  service.start();
  await service.checkForUpdates();
  await service.downloadUpdate();
  updater.quitAndInstall.mockClear();
  expect(await service.installUpdate()).toMatchObject({ phase: "downloaded", error: "Progress window launch failed" });
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(monitor.failed).toHaveBeenCalledWith("Progress window launch failed");
});
