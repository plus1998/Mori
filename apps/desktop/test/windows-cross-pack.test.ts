import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativePackTarget } from "../scripts/native-pack-target.mjs";
import { windowsX64OptionalPackages } from "../scripts/windows-cross-dependencies.mjs";
import { windowsCrossCompileArguments } from "../scripts/browser-focus-hook-cross.mjs";
import { setWindowsExecutableIcon, windowsExecutableCodeIdentity } from "../scripts/windows-exe-icon.mjs";

test("Windows cross build selects the target, pinned optional packages and MSVC ABI", () => {
  expect(nativePackTarget(["--platform", "win32", "--arch", "x64"], { platform: "darwin", arch: "arm64" })).toEqual({ platform: "win32", arch: "x64" });
  expect(() => nativePackTarget(["--platform"])).toThrow("requires a value");
  expect(windowsX64OptionalPackages({ optionalDependencies: {
    "@openai/codex-win32-x64": "npm:@openai/codex@0.163.0-win32-x64",
    "@openai/codex-win32-arm64": "npm:@openai/codex@0.163.0-win32-arm64",
    "@napi-rs/keyring-darwin-arm64": "1.3.0",
  } })).toEqual([{ name: "@openai/codex-win32-x64", spec: "@openai/codex@0.163.0-win32-x64", version: "0.163.0-win32-x64" }]);
  const args = windowsCrossCompileArguments({ source: "/src/focus.c", object: "/tmp/focus.obj", cache: "/cache/gum", sdk: "/cache/sdk" });
  expect(args).toContain("--target=x86_64-pc-windows-msvc");
  expect(args).toContain("-fms-runtime-lib=static");
  expect(args.at(-1)).toBe("/tmp/focus.obj");
});

function minimalWindowsExe() {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(1, 70); bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(0x22, 86);
  const opt = 88;
  bytes.writeUInt16LE(0x20b, opt); bytes.writeUInt32LE(0x1000, opt + 16); bytes.writeUInt32LE(0x1000, opt + 20);
  bytes.writeBigUInt64LE(0x140000000n, opt + 24); bytes.writeUInt32LE(0x1000, opt + 32); bytes.writeUInt32LE(0x200, opt + 36);
  bytes.writeUInt16LE(6, opt + 40); bytes.writeUInt16LE(6, opt + 48); bytes.writeUInt32LE(0x2000, opt + 56);
  bytes.writeUInt32LE(0x200, opt + 60); bytes.writeUInt16LE(3, opt + 68); bytes.writeUInt32LE(16, opt + 108);
  const section = opt + 240;
  bytes.write(".text", section); bytes.writeUInt32LE(1, section + 8); bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20); bytes.writeUInt32LE(0x60000020, section + 36);
  bytes[512] = 0xc3;
  return bytes;
}

test("pure JS Windows icon editing preserves executable code and requires no Wine", () => {
  const dir = mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "mori-win-icon-"));
  try {
    const filename = path.join(dir, "Mori.exe");
    const original = minimalWindowsExe();
    writeFileSync(filename, original);
    const icon = path.resolve(import.meta.dir, "../packaging/icon.ico");
    setWindowsExecutableIcon(filename, icon);
    const changed = readFileSync(filename);
    expect(changed.length).toBeGreaterThan(original.length);
    expect(windowsExecutableCodeIdentity(changed)).toBe(windowsExecutableCodeIdentity(original));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
