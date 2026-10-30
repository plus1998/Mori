#!/usr/bin/env node
/**
 * Copy the host-platform agent-browser binary into packaging/agent-browser
 * for electron-builder extraResources.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativePackTarget } from "./native-pack-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const outDir = path.join(desktopRoot, "packaging", "agent-browser");
const { platform, arch } = nativePackTarget();

function platformBinaryName(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return "agent-browser-darwin-arm64";
  if (platform === "darwin" && (arch === "x64" || arch === "x86_64")) return "agent-browser-darwin-x64";
  if (platform === "linux" && arch === "arm64") return "agent-browser-linux-arm64";
  if (platform === "linux" && (arch === "x64" || arch === "x86_64")) return "agent-browser-linux-x64";
  if (platform === "win32" && (arch === "x64" || arch === "x86_64")) return "agent-browser-win32-x64.exe";
  return undefined;
}

const binaryName = platformBinaryName(platform, arch);
if (!binaryName) {
  console.error(`No agent-browser binary mapping for ${platform}/${arch}`);
  process.exit(1);
}

const candidates = [
  path.join(desktopRoot, "node_modules", "agent-browser", "bin", binaryName),
  path.join(desktopRoot, "..", "..", "node_modules", "agent-browser", "bin", binaryName),
];

const source = candidates.find((candidate) => fs.existsSync(candidate));
if (!source) {
  console.error(`agent-browser binary not found (${binaryName}). Install agent-browser dependency first.`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
for (const filename of ["agent-browser", "agent-browser.exe"]) fs.rmSync(path.join(outDir, filename), { force: true });
const destName = platform === "win32" ? "agent-browser.exe" : "agent-browser";
const dest = path.join(outDir, destName);
fs.copyFileSync(source, dest);
try {
  fs.chmodSync(dest, 0o755);
} catch {
  // Windows
}
console.log(`Prepared ${dest} from ${source}`);
