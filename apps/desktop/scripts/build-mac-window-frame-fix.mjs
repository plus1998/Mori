import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin") {
  const desktop = fileURLToPath(new URL("../", import.meta.url));
  const output = "dist/native/mac-window-frame-fix.dylib";
  mkdirSync(new URL("../dist/native/", import.meta.url), { recursive: true });
  execFileSync("xcrun", [
    "clang", "-O2", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=13.0",
    "-dynamiclib", "-fobjc-arc", "-fvisibility=hidden", "-framework", "AppKit",
    "native/mac-window-frame-fix.m", "-o", output,
  ], { cwd: desktop, stdio: "inherit" });
  execFileSync("codesign", ["--force", "--sign", "-", output], { cwd: desktop, stdio: "inherit" });
}
