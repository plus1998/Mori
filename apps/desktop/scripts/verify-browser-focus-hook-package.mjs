import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function verifyWindowsFocusHookPackage(appOutDir) {
  const filename = path.join(appOutDir, "resources", "app.asar.unpacked", "dist", "native", "browser-focus-hook", "win32-x64", "mori-browser-focus.dll");
  if (!existsSync(filename)) throw new Error(`Windows focus Hook DLL is missing from the package: ${filename}. Run node scripts/build-browser-focus-hook.mjs --target win32-x64 before packaging; a macOS dylib cannot replace this DLL.`);
  const bytes = readFileSync(filename);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ" || pe < 64 || pe + 24 > bytes.length ||
      bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664 || !(bytes.readUInt16LE(pe + 22) & 0x2000)) {
    throw new Error(`Packaged focus Hook is not a Windows x64 DLL: ${filename}`);
  }
  return filename;
}
