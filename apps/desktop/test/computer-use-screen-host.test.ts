import { expect, test } from "bun:test";
import {
  mapTermProgramToScreenHost,
  readProcessAncestorCommands,
  resolveDevScreenRecordingHostLabel,
  resolveScreenRecordingAppLabel,
  screenHostLabelFromCommand,
} from "../src/shared/computer-use-screen-host";
import { detectScreenRecordingAppLabel } from "../src/main/computer-use-screen-host-native";

test("mapTermProgramToScreenHost maps common terminals", () => {
  expect(mapTermProgramToScreenHost("Apple_Terminal")).toBe("Terminal");
  expect(mapTermProgramToScreenHost("iTerm.app")).toBe("iTerm");
  expect(mapTermProgramToScreenHost("WarpTerminal")).toBe("Warp");
  expect(mapTermProgramToScreenHost("cursor")).toBe("Cursor");
  expect(mapTermProgramToScreenHost(undefined)).toBeUndefined();
});

test("screenHostLabelFromCommand prefers .app bundle name and skips runners", () => {
  expect(
    screenHostLabelFromCommand(
      "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    ),
  ).toBe("Terminal");
  expect(
    screenHostLabelFromCommand("/Applications/iTerm.app/Contents/MacOS/iTerm2"),
  ).toBe("iTerm");
  expect(
    screenHostLabelFromCommand("/Applications/Cursor.app/Contents/MacOS/Cursor"),
  ).toBe("Cursor");
  expect(
    screenHostLabelFromCommand(
      "/Users/x/eco/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
  ).toBeUndefined();
  expect(screenHostLabelFromCommand("/opt/homebrew/bin/bun run dev")).toBeUndefined();
});

test("resolveDevScreenRecordingHostLabel uses launcher not Electron", () => {
  expect(
    resolveDevScreenRecordingHostLabel({
      ancestorCommands: [
        "/opt/homebrew/bin/bun",
        "/bin/zsh",
        "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      ],
      termProgram: "Apple_Terminal",
    }),
  ).toBe("Terminal");

  expect(
    resolveDevScreenRecordingHostLabel({
      ancestorCommands: ["/opt/homebrew/bin/bun", "/bin/zsh"],
      termProgram: "iTerm.app",
    }),
  ).toBe("iTerm");
});

test("resolveScreenRecordingAppLabel packaged vs provided ancestors", () => {
  expect(resolveScreenRecordingAppLabel({ packaged: true })).toBe("Mori");
  expect(
    resolveScreenRecordingAppLabel({
      packaged: false,
      ancestorCommands: [],
      termProgram: "Apple_Terminal",
    }),
  ).toBe("Terminal");
});

test("detectScreenRecordingAppLabel packaged is Mori", () => {
  expect(detectScreenRecordingAppLabel(true)).toBe("Mori");
});

test("readProcessAncestorCommands walks injected process table", () => {
  const table = new Map<number, { ppid: number; command: string }>([
    [100, { ppid: 50, command: "/opt/homebrew/bin/bun" }],
    [
      50,
      {
        ppid: 20,
        command: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
      },
    ],
    [20, { ppid: 1, command: "/sbin/launchd" }],
  ]);
  const commands = readProcessAncestorCommands(100, {
    readEntry: (pid) => table.get(pid),
  });
  expect(commands[0]).toContain("bun");
  expect(commands[1]).toContain("Terminal.app");
});
