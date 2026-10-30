#!/usr/bin/env node
/**
 * Copy the host-platform open-computer-use native runtime into
 * packaging/open-computer-use for electron-builder extraResources
 * (avoid shipping every OS binary).
 *
 * macOS: must ship the whole "Open Computer Use.app" bundle (not the bare
 * executable). The binary is signed as part of the bundle; running the bare
 * executable outside the bundle is SIGKILLed by the system, and the
 * app-agent proxy + TCC permission identity ("Open Computer Use") only work
 * with the bundle. Layout mirrors the npm package: dist/Open Computer Use.app.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativePackTarget } from "./native-pack-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const outDir = path.join(desktopRoot, "packaging", "open-computer-use");
const { platform, arch } = nativePackTarget();

function nativeRelativePath(platform, arch) {
  const key = `${platform}-${arch === "x86_64" ? "x64" : arch}`;
  switch (key) {
    case "darwin-arm64":
    case "darwin-x64":
      return ["dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"];
    case "linux-arm64":
      return ["dist", "linux", "arm64", "open-computer-use"];
    case "linux-x64":
      return ["dist", "linux", "amd64", "open-computer-use"];
    case "win32-arm64":
      return ["dist", "windows", "arm64", "open-computer-use.exe"];
    case "win32-x64":
      return ["dist", "windows", "amd64", "open-computer-use.exe"];
    default:
      return undefined;
  }
}

const relative = nativeRelativePath(platform, arch);
if (!relative) {
  console.error(`No open-computer-use binary mapping for ${platform}/${arch}`);
  process.exit(1);
}

const packageRoots = [
  path.join(desktopRoot, "node_modules", "@qwen-code", "open-computer-use"),
  path.join(desktopRoot, "..", "..", "node_modules", "@qwen-code", "open-computer-use"),
];

const packageRoot = packageRoots.find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
if (!packageRoot) {
  console.error(
    "open-computer-use package not found. Install @qwen-code/open-computer-use dependency first.",
  );
  process.exit(1);
}

// Start clean so stale layouts (e.g. an old bare-binary copy) never shadow
// the bundle.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function copyRecursive(source, dest) {
  fs.cpSync(source, dest, { recursive: true, dereference: false });
}

if (platform === "darwin") {
  const appBundleSource = path.join(packageRoot, "dist", "Open Computer Use.app");
  if (!fs.existsSync(appBundleSource)) {
    console.error(`open-computer-use app bundle not found at ${appBundleSource}`);
    process.exit(1);
  }
  const appBundleDest = path.join(outDir, "dist", "Open Computer Use.app");
  fs.mkdirSync(path.dirname(appBundleDest), { recursive: true });
  copyRecursive(appBundleSource, appBundleDest);
  const executable = path.join(appBundleDest, "Contents", "MacOS", "OpenComputerUse");
  try {
    fs.chmodSync(executable, 0o755);
  } catch {
    // ignore
  }
  console.log(`Prepared ${appBundleDest} from ${appBundleSource}`);
} else {
  const source = path.join(packageRoot, ...relative);
  if (!fs.existsSync(source)) {
    console.error(`open-computer-use native binary not found at ${source}`);
    process.exit(1);
  }
  const destName = platform === "win32" ? "open-computer-use.exe" : "open-computer-use";
  const dest = path.join(outDir, destName);
  fs.copyFileSync(source, dest);
  if (platform !== "win32") {
    try {
      fs.chmodSync(dest, 0o755);
    } catch {
      // ignore
    }
  }
  console.log(`Prepared ${dest} from ${source}`);
}
