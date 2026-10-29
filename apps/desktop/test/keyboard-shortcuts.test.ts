import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyboardShortcutsStore } from "../src/main/keyboard-shortcuts-store";
import {
  acceleratorFromEvent,
  defaultShortcutBindings,
  formatAccelerator,
  matchesShortcut,
  validateShortcutBindings,
} from "../src/shared/keyboard-shortcuts";

for (const platform of ["darwin", "win32", "linux"]) {
  test(`shortcut defaults and modifier aliases are valid on ${platform}`, () => {
    const defaults = defaultShortcutBindings(platform);
    expect(() => validateShortcutBindings(defaults, platform)).not.toThrow();
    expect(defaults["open-scheduling"]).toHaveLength(1);
    expect(defaults["open-todos"]).toHaveLength(1);
    expect(defaults["toggle-prevent-auto-lock"]).toEqual(
      platform !== "linux" ? ["CommandOrControl+Shift+U"] : undefined,
    );
    expect(defaults["toggle-display-dimming"]).toEqual(
      platform !== "linux" ? ["CommandOrControl+Shift+D"] : undefined,
    );
    const event = {
      key: "J",
      code: "KeyJ",
      metaKey: platform === "darwin",
      ctrlKey: platform !== "darwin",
      altKey: false,
      shiftKey: true,
    };
    expect(matchesShortcut(event, "open-scheduling", defaults, platform)).toBe(true);
    expect(matchesShortcut({ ...event, isComposing: true }, "open-scheduling", defaults, platform)).toBe(
      false,
    );
    const next = validateShortcutBindings({ ...defaults, "open-scheduling": ["Alt+Shift+J"] }, platform);
    expect(matchesShortcut(event, "open-scheduling", next, platform)).toBe(false);
    expect(
      matchesShortcut(
        { ...event, metaKey: false, ctrlKey: false, altKey: true },
        "open-scheduling",
        next,
        platform,
      ),
    ).toBe(true);
  });
}
test("conflicts use actual platform modifiers and allow independent contextual commands", () => {
  const defaults = defaultShortcutBindings("darwin");
  expect(() =>
    validateShortcutBindings({ ...defaults, "open-todos": ["Command+Shift+J"] }, "darwin"),
  ).toThrow("定时任务");
  expect(() => validateShortcutBindings({ ...defaults, "open-todos": ["J"] }, "darwin")).toThrow("修饰键");
  expect(() =>
    validateShortcutBindings({ ...defaults, "open-todos": ["Control+Unknown"] }, "darwin"),
  ).toThrow("有效");
  expect(() =>
    validateShortcutBindings(
      { ...defaults, "git-commit": ["CommandOrControl+Enter"], "todo-save": ["CommandOrControl+Enter"] },
      "darwin",
    ),
  ).not.toThrow();
  expect(() =>
    validateShortcutBindings({ ...defaults, "open-todos": ["CommandOrControl+Enter"] }, "darwin"),
  ).toThrow("快捷键冲突");
  expect(() =>
    validateShortcutBindings({ ...defaults, "mori-floating": ["Command+Shift+M", "Control+M"] }, "darwin"),
  ).toThrow("配置无效");
  expect(() =>
    validateShortcutBindings({ ...defaults, "new-chat": ["Command+N", "CmdOrCtrl+N"] }, "darwin"),
  ).toThrow("冲突");
});
test("recording captures physical punctuation and formats platform-specific labels", () => {
  expect(
    acceleratorFromEvent({
      key: "CapsLock",
      code: "CapsLock",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }),
  ).toBeUndefined();
  expect(
    acceleratorFromEvent({
      key: "~",
      code: "Backquote",
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    }),
  ).toBe("Shift+Command+`");
  expect(
    acceleratorFromEvent({ key: "Shift", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }),
  ).toBeUndefined();
  expect(formatAccelerator("CommandOrControl+Shift+J", "darwin")).toBe("⇧⌘J");
  expect(formatAccelerator("CommandOrControl+Shift+J", "win32")).toBe("Ctrl+Shift+J");
});
test("cleared bindings persist and legacy Mori shortcut migrates without adding a database", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mori-shortcuts-"));
  try {
    const file = path.join(directory, "keyboard-shortcuts.json");
    fs.writeFileSync(
      path.join(directory, "mori-assistant.json"),
      JSON.stringify({ settings: { shortcut: "CommandOrControl+Shift+P" } }),
    );
    const store = new KeyboardShortcutsStore(file, "darwin");
    store.load();
    expect(store.get()["mori-floating"]).toEqual(["CommandOrControl+Shift+P"]);
    store.save({ ...store.get(), "open-todos": [], "new-chat": ["Alt+N"] });
    fs.writeFileSync(file, JSON.stringify({ ...store.get(), copy: ["Alt+C"], paste: [], reload: ["Alt+R"], minimize: [] }));
    const reloaded = new KeyboardShortcutsStore(file, "darwin");
    reloaded.load();
    expect(reloaded.get().copy).toBeUndefined();
    expect(reloaded.get().paste).toBeUndefined();
    expect(reloaded.get().reload).toBeUndefined();
    expect(reloaded.get().minimize).toBeUndefined();
    expect(reloaded.get()["open-todos"]).toEqual([]);
    expect(reloaded.get()["new-chat"]).toEqual(["Alt+N"]);
    expect(() => reloaded.save({ ...reloaded.get(), "new-chat": ["Command+O"] })).toThrow("冲突");
    expect(reloaded.get()["new-chat"]).toEqual(["Alt+N"]);
    fs.writeFileSync(file, "broken");
    expect(() => reloaded.load()).toThrow();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
