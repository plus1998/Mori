import path from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export const GUM_VERSION = "17.2.16";
export function focusHookBuildProfile(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return {
    target: "darwin-arm64", library: "libmori-browser-focus.dylib", platformSource: "platform-macos.c",
    archive: `frida-gum-devkit-${GUM_VERSION}-macos-arm64.tar.xz`,
    sha256: "dd3a5500740903bba6117204f8d6df6b5228b8137e95b44eedbbaeff477e807f",
    members: ["frida-gum.h", "libfrida-gum.a"],
  };
  if (platform === "win32" && arch === "x64") return {
    target: "win32-x64", library: "mori-browser-focus.dll", platformSource: "platform-windows.c",
    archive: `frida-gum-devkit-${GUM_VERSION}-windows-x86_64.tar.xz`,
    sha256: "24a7d3af1bf0851c565ba776c1f661810ed4f21ebd7c04a29f91af72616de5d6",
    members: ["frida-gum.h", "frida-gum.lib"],
  };
  return undefined;
}

export function parseWindowsBuildEnvironment(text) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at);
    entries.set(key.toLowerCase(), [key, line.slice(at + 1)]);
  }
  return Object.fromEntries(entries.values());
}

/** Discover VS without requiring the caller to use a Developer Command Prompt. */
export function windowsCompilerEnvironment(env = process.env, run = spawnSync, exists = existsSync) {
  const present = run("where.exe", ["cl.exe"], { env, encoding: "utf8" });
  if (present.status === 0 && env.VSCMD_ARG_TGT_ARCH === "x64") return env;
  const programFiles = env["ProgramFiles(x86)"] ?? env.ProgramFiles ?? "C:\\Program Files (x86)";
  const vswhere = path.win32.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!exists(vswhere)) {
    if (present.status === 0 && !env.VSCMD_ARG_TGT_ARCH) return env;
    throw new Error("Windows focus Hook requires Visual Studio 2022 Build Tools: Desktop development with C++ and a Windows SDK. cl.exe/vswhere.exe was not found.");
  }
  const installation = run(vswhere, ["-utf8", "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { env, encoding: "utf8" });
  const directory = installation.status === 0 ? installation.stdout.trim() : "";
  if (!directory) throw new Error("Visual Studio C++ x64 toolchain was not found; install the Desktop development with C++ workload and Windows SDK.");
  const vcvars = path.win32.join(directory, "VC", "Auxiliary", "Build", "vcvars64.bat");
  if (!exists(vcvars)) throw new Error(`Visual Studio x64 environment script is missing: ${vcvars}`);
  // cmd /s removes the outer quote pair. Keep the batch path quoted, and disable
  // delayed expansion; do not pass environment contents through another shell.
  const result = run(env.ComSpec ?? "cmd.exe", ["/d", "/u", "/v:off", "/s", "/c", `"call "${vcvars}" >nul && set"`], {
    env, encoding: "utf16le", windowsVerbatimArguments: true,
  });
  if (result.status !== 0) throw new Error(`Visual Studio x64 environment setup failed (exit ${result.status})`);
  const configured = parseWindowsBuildEnvironment(result.stdout);
  if (configured.VSCMD_ARG_TGT_ARCH !== "x64") throw new Error("Visual Studio did not configure an x64 compiler environment");
  return configured;
}

export function windowsFocusCompileArguments({ sources, cache, objectDir, output }) {
  return ["/nologo", "/LD", "/O2", "/MT", "/std:c11", "/W3", "/utf-8", "/DNDEBUG", `/I${cache}`,
    `/Fo${objectDir}\\`, ...sources, "/link", "/MACHINE:X64", "/INCREMENTAL:NO", "/OPT:REF", "/OPT:ICF",
    `/OUT:${output}`, `/IMPLIB:${path.win32.join(objectDir, "mori-browser-focus.lib")}`, `/LIBPATH:${cache}`,
    "kernel32.lib", "user32.lib", "advapi32.lib", "shell32.lib", "ole32.lib", "uuid.lib", "secur32.lib", "bcrypt.lib"];
}
