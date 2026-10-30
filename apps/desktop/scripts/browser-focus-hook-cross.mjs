import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function executable(name) {
  try { return execFileSync("/usr/bin/which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return undefined; }
}

export function windowsCrossTools() {
  const privateXwin = path.join(os.homedir(), ".cache/mori-native/tools/bin/xwin");
  const xwin = process.env.MORI_XWIN ?? executable("xwin") ?? (existsSync(privateXwin) ? privateXwin : undefined);
  if (!xwin) throw new Error("Mac Windows cross build needs xwin: brew install xwin (or set MORI_XWIN).");
  const clang = process.env.MORI_WIN_CLANG ?? execFileSync("xcrun", ["--find", "clang"], { encoding: "utf8" }).trim();
  let linker = process.env.MORI_LLD_LINK ?? executable("lld-link");
  let linkerPrefix = [];
  if (!linker) {
    // rustup ships a native LLVM linker that also supports the PE/COFF flavor.
    try {
      const rustc = executable("rustc") ?? path.join(os.homedir(), ".cargo/bin/rustc");
      const sysroot = execFileSync(rustc, ["--print", "sysroot"], { encoding: "utf8" }).trim();
      const host = execFileSync(rustc, ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
      const candidate = host && path.join(sysroot, "lib/rustlib", host, "bin/rust-lld");
      if (candidate && existsSync(candidate)) { linker = candidate; linkerPrefix = ["-flavor", "link"]; }
    } catch { /* report the missing tool below */ }
  }
  if (!linker) throw new Error("Mac Windows cross build needs lld-link (brew install lld) or rustup's rust-lld; MORI_LLD_LINK may specify lld-link.");
  return { xwin, clang, linker, linkerPrefix };
}

export function windowsCrossSdk(tools) {
  const sdk = process.env.MORI_WINDOWS_SYSROOT ?? path.join(os.homedir(), ".cache/mori-native/windows-sdk-17");
  const required = ["crt/include/vcruntime.h", "sdk/include/um/windows.h", "crt/lib/x86_64/libcmt.lib", "sdk/lib/um/x86_64/kernel32.lib", "sdk/lib/ucrt/x86_64/libucrt.lib"];
  const complete = () => required.every(name => existsSync(path.join(sdk, name)));
  if (process.env.MORI_WINDOWS_SYSROOT) {
    if (!complete()) throw new Error(`Incomplete Windows x64 sysroot: ${sdk}`);
    return sdk;
  }
  if (!complete() || !existsSync(path.join(sdk, ".mori-ready"))) {
    console.log("[browser-focus-hook] Preparing Microsoft CRT/Windows SDK in the user cache (first cross build only)");
    const cache = path.join(os.homedir(), ".cache/mori-native/xwin-17-cache");
    execFileSync(tools.xwin, ["--accept-license", "--manifest-version", "17", "--arch", "x86_64", "--cache-dir", cache, "splat", "--output", sdk], { stdio: "inherit" });
    if (!complete()) throw new Error(`xwin did not produce a complete Windows x64 sysroot: ${sdk}`);
    writeFileSync(path.join(sdk, ".mori-ready"), "xwin; manifest 17; x86_64 desktop\n");
  }
  return sdk;
}

export function windowsCrossCompileArguments({ source, object, cache, sdk }) {
  const includes = ["crt/include", "sdk/include/ucrt", "sdk/include/um", "sdk/include/shared"];
  return ["--target=x86_64-pc-windows-msvc", "-fms-runtime-lib=static", "-std=c11", "-O2", "-DNDEBUG", "-D_WIN32_WINNT=0x0a00",
    "-I", cache, ...includes.flatMap(name => ["-isystem", path.join(sdk, name)]), "-c", source, "-o", object];
}

export function compileWindowsFocusCross({ tools, sources, cache, objectDir, output }) {
  const sdk = windowsCrossSdk(tools);
  mkdirSync(objectDir, { recursive: true });
  const objects = sources.map(source => {
    const object = path.join(objectDir, `${path.basename(source)}.obj`);
    execFileSync(tools.clang, windowsCrossCompileArguments({ source, object, cache, sdk }), { stdio: "inherit" });
    return object;
  });
  const libraries = ["crt/lib/x86_64", "sdk/lib/um/x86_64", "sdk/lib/ucrt/x86_64"];
  execFileSync(tools.linker, [...tools.linkerPrefix, "/dll", "/machine:x64", `/out:${output}`,
    `/implib:${path.join(objectDir, "mori-browser-focus.lib")}`, "/opt:ref", "/opt:icf", ...objects,
    `/libpath:${cache}`, ...libraries.map(name => `/libpath:${path.join(sdk, name)}`),
    "kernel32.lib", "user32.lib", "advapi32.lib", "shell32.lib", "ole32.lib", "uuid.lib", "secur32.lib", "bcrypt.lib"], { stdio: "inherit" });
}
