import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopUpdateInstallMonitor, monitorCommand, monitorCopy } from "../src/main/desktop-update-install-monitor";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(version = "2.0.0") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-monitor-test-"));
  dirs.push(directory);
  const pointer = path.join(directory, "desktop-update-monitor.json");
  const statePath = path.join(directory, "state.json");
  const session = { directory, version, sourcePid: -1, startedAt: Date.now(), phase: "installing", copy: monitorCopy("en-US") };
  fs.writeFileSync(pointer, JSON.stringify(session));
  fs.writeFileSync(statePath, JSON.stringify(session));
  const monitor = new DesktopUpdateInstallMonitor({ userDataPath: () => directory, locale: () => "en-US" });
  return { monitor, pointer, statePath, session };
}

test("only a matching version in a new process confirms successful installation", () => {
  const f = fixture();
  f.monitor.complete("2.0.0");
  expect(JSON.parse(fs.readFileSync(f.statePath, "utf8")).phase).toBe("completed");
  expect(fs.existsSync(f.pointer)).toBe(false);
});

test("reopening the previous version reports failure", () => {
  const f = fixture();
  f.monitor.complete("1.0.0");
  expect(JSON.parse(fs.readFileSync(f.statePath, "utf8"))).toMatchObject({ phase: "error", error: monitorCopy("en-US").versionMismatch });
});

test("the old process cannot declare its own update complete", () => {
  const f = fixture();
  fs.writeFileSync(f.pointer, JSON.stringify({ ...f.session, sourcePid: process.pid }));
  f.monitor.complete("2.0.0");
  expect(JSON.parse(fs.readFileSync(f.statePath, "utf8")).phase).toBe("installing");
  expect(fs.existsSync(f.pointer)).toBe(true);
});

test("closing the independent window does not break the next startup", () => {
  const f = fixture();
  fs.writeFileSync(f.pointer, JSON.stringify({ ...f.session, directory: path.join(f.session.directory, "closed") }));
  expect(() => f.monitor.complete("2.0.0")).not.toThrow();
  expect(fs.existsSync(f.pointer)).toBe(false);
});

test("Windows and macOS helpers use system executables and pass paths as arguments", () => {
  const script = 'C:\\Temp\\a b\\monitor.ps1';
  const state = 'C:\\Temp\\a b\\state.json';
  const windows = monitorCommand("win32", script, state);
  expect(windows.command.toLowerCase()).toEndWith("\\windowspowershell\\v1.0\\powershell.exe");
  expect(windows.args).toContain("-STA");
  expect(windows.args.slice(-4)).toEqual(["-File", script, "-StatePath", state]);
  expect(monitorCommand("darwin", "/tmp/a b/monitor.js", "/tmp/a b/state.json")).toEqual({
    command: "/usr/bin/osascript", args: ["-l", "JavaScript", "/tmp/a b/monitor.js", "/tmp/a b/state.json"],
  });
});

test("cancelled startup stops before launching a native process or writing session files", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-monitor-cancel-test-"));
  dirs.push(directory);
  const monitor = new DesktopUpdateInstallMonitor({ userDataPath: () => directory, locale: () => "en-US" });
  const controller = new AbortController();
  controller.abort(new Error("Startup cancelled"));
  await expect(monitor.start("2.0.0", controller.signal)).rejects.toThrow("Startup cancelled");
  expect(fs.readdirSync(directory)).toEqual([]);
});
