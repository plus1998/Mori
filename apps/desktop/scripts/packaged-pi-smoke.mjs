#!/usr/bin/env node
/** Run the packaged PI probe with Electron's Node loader enabled. */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(desktopRoot, "package.json"));
const electronPackage = path.dirname(require.resolve("electron/package.json"));
const ensure = spawnSync(
  process.execPath,
  [path.join(desktopRoot, "scripts", "ensure-electron-binary.mjs")],
  {
    cwd: desktopRoot,
    stdio: "inherit",
  },
);
if (ensure.status !== 0) {
  process.exit(ensure.status ?? 1);
}

const pointer = path.join(electronPackage, "path.txt");
const relativeBinary = existsSync(pointer)
  ? readFileSync(pointer, "utf8").trim()
  : process.platform === "darwin"
    ? path.join("Electron.app", "Contents", "MacOS", "Electron")
    : process.platform === "win32"
      ? "electron.exe"
      : "electron";
const electronBinary = path.join(electronPackage, "dist", relativeBinary);
const probe = spawn(
  electronBinary,
  [
    path.join(desktopRoot, "scripts", "verify-packaged-pi-runtime.mjs"),
    "--search",
    path.join(desktopRoot, "release"),
  ],
  {
    cwd: desktopRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  },
);
probe.once("error", (error) => {
  console.error(`无法启动 Electron 打包冒烟：${error.message}`);
  process.exitCode = 1;
});
probe.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
