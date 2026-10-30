import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { focusHookBuildProfile, parseWindowsBuildEnvironment, windowsCompilerEnvironment, windowsFocusCompileArguments } from "../scripts/browser-focus-hook-build.mjs";
import { verifyWindowsFocusHookPackage } from "../scripts/verify-browser-focus-hook-package.mjs";
import { browserFocusHookProfile } from "../src/main/browser-agent-focus-profile";

test("build and runtime profiles select distinct pinned Windows/macOS libraries", () => {
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"]]) {
    const build = focusHookBuildProfile(platform, arch)!;
    expect(browserFocusHookProfile(platform!, arch!, "45.1.0")).toEqual({ target: build.target, library: build.library });
    expect(build.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(focusHookBuildProfile("win32", "arm64")).toBeUndefined();
  expect(() => browserFocusHookProfile("win32", "x64", "45.2.0")).toThrow("45.1.0");
});

test("VS environment parsing preserves Unicode and equals signs without duplicate PATH keys", () => {
  const env = parseWindowsBuildEnvironment("=C:=C:\\work\r\nPath=old\r\nPATH=C:\\工具\\bin\r\nTEMP=C:\\用户\\临时\r\nVALUE=a=b\r\n");
  expect(env).toEqual({ PATH: "C:\\工具\\bin", TEMP: "C:\\用户\\临时", VALUE: "a=b" });
});

test("VS discovery captures an x64 Unicode environment and does not use a missing compiler", () => {
  const calls: { command: string; args: string[]; options: any }[] = [];
  const env = windowsCompilerEnvironment({ "ProgramFiles(x86)": "C:\\Program Files (x86)" }, ((command: string, args: string[], options: any) => {
    calls.push({ command, args, options });
    if (command === "where.exe") return { status: 1, stdout: "" };
    if (command.endsWith("vswhere.exe")) return { status: 0, stdout: "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\r\n" };
    return { status: 0, stdout: "VSCMD_ARG_TGT_ARCH=x64\r\nPath=C:\\MSVC\\bin\r\nTEMP=C:\\用户\\Temp\r\n" };
  }) as any, () => true);
  expect(env.TEMP).toBe("C:\\用户\\Temp");
  expect(calls.at(-1)?.options.encoding).toBe("utf16le");
  expect(calls.at(-1)?.args).toContain("/u");
  expect(() => windowsCompilerEnvironment({}, (() => ({ status: 1, stdout: "" })) as any, () => false)).toThrow("Build Tools");
  const args = windowsFocusCompileArguments({ sources: ["C:\\a b\\focus.c"], cache: "C:\\cache", objectDir: "C:\\obj", output: "C:\\out\\focus.dll.tmp" });
  expect(args).toContain("/MT");
  expect(args).toContain("/MACHINE:X64");
  expect(args).toContain("C:\\a b\\focus.c");
  expect(args).toContain("/OUT:C:\\out\\focus.dll.tmp");
});

test("Windows package rejects missing DLLs, macOS libraries and wrong CPU binaries", () => {
  const dir = mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "mori-focus-package-test-"));
  try {
    expect(() => verifyWindowsFocusHookPackage(dir)).toThrow("DLL is missing");
    const filename = path.join(dir, "resources/app.asar.unpacked/dist/native/browser-focus-hook/win32-x64/mori-browser-focus.dll");
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, "a dylib is not a Windows DLL");
    expect(() => verifyWindowsFocusHookPackage(dir)).toThrow("not a Windows x64 DLL");
    const bytes = Buffer.alloc(256);
    bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64);
    bytes.writeUInt16LE(0x8664, 68); bytes.writeUInt16LE(0x2000, 86);
    writeFileSync(filename, bytes);
    expect(verifyWindowsFocusHookPackage(dir)).toBe(filename);
    bytes.writeUInt16LE(0xaa64, 68); writeFileSync(filename, bytes);
    expect(() => verifyWindowsFocusHookPackage(dir)).toThrow("not a Windows x64 DLL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
