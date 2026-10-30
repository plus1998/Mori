import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUM_VERSION, focusHookBuildProfile, windowsCompilerEnvironment, windowsFocusCompileArguments } from "./browser-focus-hook-build.mjs";
import { windowsCrossTools, compileWindowsFocusCross } from "./browser-focus-hook-cross.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const requestedTarget = process.argv.find(arg => arg.startsWith("--target="))?.slice("--target=".length)
  ?? (process.argv.includes("--target") ? process.argv[process.argv.indexOf("--target") + 1] : undefined);
if (process.argv.includes("--target") && !requestedTarget) throw new Error("--target requires darwin-arm64 or win32-x64");
const [targetPlatform, targetArch] = (requestedTarget ?? `${process.platform}-${process.arch}`).split("-");
const profile = focusHookBuildProfile(targetPlatform, targetArch);
if (requestedTarget && !profile) throw new Error(`Unsupported focus Hook target: ${requestedTarget}`);
const crossWindows = profile?.target === "win32-x64" && process.platform === "darwin";
if (profile && profile.target !== `${process.platform}-${process.arch}` && !crossWindows) throw new Error(`Unsupported focus Hook cross build: ${process.platform}-${process.arch} -> ${profile.target}`);
if (!profile) {
  console.log(`[browser-focus-hook] ${process.platform}-${process.arch}: native click isolation is not supported`);
} else {
  const electronVersion = require("electron/package.json").version;
  if (electronVersion !== "45.1.0") throw new Error(`Browser focus Hook requires Electron 45.1.0, found ${electronVersion}`);
  const sourceRoot = path.join(root, "native/browser-focus-hook");
  const sources = [path.join(sourceRoot, "focus-hook.c"), path.join(sourceRoot, profile.platformSource)];
  const output = path.join(root, "dist/native/browser-focus-hook", profile.target);
  const library = path.join(output, profile.library);
  const notice = readFileSync(path.join(sourceRoot, "NOTICE.txt"));
  const hash = createHash("sha256").update(profile.target).update(notice);
  for (const filename of [...sources, path.join(sourceRoot, "platform.h"), fileURLToPath(import.meta.url), path.join(root, "scripts/browser-focus-hook-build.mjs"), path.join(root, "scripts/browser-focus-hook-cross.mjs")]) hash.update(readFileSync(filename));
  const key = hash.digest("hex");
  const stamp = path.join(output, "build-key");
  if (!existsSync(library) || !existsSync(stamp) || readFileSync(stamp, "utf8") !== key) {
    // Discover the compiler before downloading a devkit we cannot compile.
    const compilerEnv = process.platform === "win32" ? windowsCompilerEnvironment() : process.env;
    const crossTools = crossWindows ? windowsCrossTools() : undefined;
    const cache = path.join(os.homedir(), ".cache/mori-native", `frida-gum-${GUM_VERSION}-${profile.target}`);
    mkdirSync(cache, { recursive: true });
    const archive = path.join(cache, "devkit.tar.xz");
    if (!existsSync(archive)) {
      const response = await fetch(`https://github.com/frida/frida/releases/download/${GUM_VERSION}/${profile.archive}`, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`Frida Gum download failed: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== profile.sha256) throw new Error("Downloaded Frida Gum checksum mismatch");
      writeFileSync(`${archive}.${process.pid}.tmp`, bytes);
      renameSync(`${archive}.${process.pid}.tmp`, archive);
    }
    if (createHash("sha256").update(readFileSync(archive)).digest("hex") !== profile.sha256) throw new Error(`Frida Gum devkit checksum mismatch: ${archive}`);
    // Windows 10+ ships bsdtar, which can read the official xz devkit too.
    execFileSync("tar", ["-xJf", archive, "-C", cache, ...profile.members]);
    mkdirSync(output, { recursive: true });
    const temporaryLibrary = `${library}.${process.pid}.tmp`;
    if (crossTools) {
      compileWindowsFocusCross({ tools: crossTools, sources, cache, objectDir: path.join(cache, "objects", key), output: temporaryLibrary });
    } else if (process.platform === "win32") {
      const objectDir = path.join(cache, "objects", key);
      mkdirSync(objectDir, { recursive: true });
      const args = windowsFocusCompileArguments({ sources, cache, objectDir, output: temporaryLibrary });
      execFileSync("cl.exe", args, { env: compilerEnv, cwd: objectDir, stdio: "inherit" });
    } else {
      const exports = ["install", "uninstall", "depth", "blocked", "allowed", "error"];
      execFileSync("xcrun", ["clang", "-std=c11", "-O2", "-arch", "arm64", "-mmacosx-version-min=13.0",
        "-dynamiclib", "-fvisibility=hidden", ...sources, "-I", cache, "-L", cache, "-lfrida-gum", "-lresolv", "-lm",
        ...exports.map(name => `-Wl,-exported_symbol,_mori_browser_focus_${name}`),
        "-Wl,-install_name,@rpath/libmori-browser-focus.dylib", "-o", temporaryLibrary], { stdio: "inherit" });
      execFileSync("codesign", ["--force", "--sign", "-", temporaryLibrary], { stdio: "inherit" });
    }
    renameSync(temporaryLibrary, library);
    writeFileSync(path.join(output, "NOTICE.txt"), notice);
    writeFileSync(stamp, key);
    console.log(`[browser-focus-hook] Built ${library}`);
  }
}
