#!/usr/bin/env node
/**
 * Install the Electron binary when the package manager skipped it.
 *
 * Electron 42+ downloads lazily instead of during postinstall. Install explicitly before
 * rebuilding/testing so a plain require('electron') in a Node/Bun probe cannot unexpectedly
 * start a download and time out. electron-builder downloads its own distribution separately.
 *
 * Run the installer Electron itself ships, then verify the binary really exists. A missing
 * binary after a successful install.js is a hard error, not a warning.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(desktopRoot, "package.json"));
const electronPackage = path.dirname(require.resolve("electron/package.json"));
const binary = resolveBinary(electronPackage);

if (existsSync(binary)) {
  console.log(`[electron] binary already installed: ${binary}`);
} else {
  console.log(`[electron] ${binary} missing; running install.js in ${electronPackage}`);
  const result = spawnSync(process.execPath, ["install.js"], { cwd: electronPackage, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`electron install.js exited with ${result.status ?? "a signal"} in ${electronPackage}`);
  }
  const installed = resolveBinary(electronPackage);
  if (!existsSync(installed)) {
    throw new Error(`electron install.js succeeded but ${installed} is still missing`);
  }
  console.log(`[electron] binary installed: ${installed}`);
}

/**
 * Electron records the binary location relative to `dist/` in `path.txt` — on macOS that is
 * `Electron.app/Contents/MacOS/Electron`, not `dist/electron`. Fall back to the per-platform
 * default when the pointer file has not been written yet.
 */
function resolveBinary(packageDirectory) {
  const dist = path.join(packageDirectory, "dist");
  const pointer = path.join(packageDirectory, "path.txt");
  if (existsSync(pointer)) {
    const relative = readFileSync(pointer, "utf8").trim();
    if (relative) return path.join(dist, relative);
  }
  if (process.platform === "darwin") {
    return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  }
  return path.join(dist, process.platform === "win32" ? "electron.exe" : "electron");
}
